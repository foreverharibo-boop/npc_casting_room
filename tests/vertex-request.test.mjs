import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVertexPayload, describeRequestError, requestVertexProfile } from '../vertex-request.js';

function fixture() {
    const saved = { chat_completion_source: 'openrouter', temperature: 0.5 };
    const current = { chat_completion_source: 'openrouter', vertexai_auth_mode: 'express', vertexai_region: 'global', vertexai_express_project_id: 'test-project' };
    const profile = { id: 'vertex', api: 'vertexai', preset: 'test', model: 'test-gemini-model', 'secret-id': 'key-id' };
    let converted;
    const context = {
        chatCompletionSettings: current,
        extensionSettings: { connectionManager: { selectedProfile: 'other' } },
        getPresetManager: () => ({ getCompletionPresetByName: () => saved }),
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        proxies: [{ name: 'saved-proxy', url: 'https://proxy.example', password: 'proxy-password' }],
        ChatCompletionService: {
            presetToGeneratePayload: async (preset, overrides, payload) => {
                converted = preset;
                // Mimic core defaults to catch a main-connection proxy leaking.
                return { reverse_proxy: 'https://main.example', proxy_password: 'main-password', ...payload };
            },
        },
    };
    return { context, profile, saved, current, converted: () => converted };
}

test('Vertex fields are present before preset conversion even when main and preset use another API', async () => {
    const f = fixture();
    const before = structuredClone({ saved: f.saved, current: f.current, profile: f.profile });
    const prompt = [{ role: 'user', content: 'NPC' }];
    const payload = await buildVertexPayload(f.context, f.profile, prompt, 1200);
    assert.equal(f.converted().chat_completion_source, 'vertexai');
    assert.equal(f.converted().vertexai_express_project_id, 'test-project');
    assert.equal(payload.vertexai_auth_mode, 'express');
    assert.equal(payload.vertexai_region, 'global');
    assert.equal(payload.vertexai_express_project_id, 'test-project');
    assert.equal(payload.model, f.profile.model);
    assert.equal(payload.secret_id, 'key-id');
    assert.equal(payload.reverse_proxy, '');
    assert.equal(payload.proxy_password, '');
    assert.equal(payload.stream, false);
    assert.deepEqual({ saved: f.saved, current: f.current, profile: f.profile }, before);
});

test('separate full-auth profile keeps its saved authentication and explicit region/proxy', async () => {
    const f = fixture();
    f.saved.vertexai_auth_mode = 'full';
    f.profile['api-url'] = 'europe-west4';
    f.profile.proxy = 'saved-proxy';
    const payload = await buildVertexPayload(f.context, f.profile, [], 1500, true);
    assert.equal(payload.vertexai_auth_mode, 'full');
    assert.equal(payload.vertexai_region, 'europe-west4');
    assert.equal(payload.reverse_proxy, 'https://proxy.example');
    assert.equal(payload.proxy_password, 'proxy-password');
    assert.equal(payload.secret_id, null);
});

test('active Vertex profile uses its live Express controls after changing settings', async () => {
    const f = fixture();
    f.saved.vertexai_auth_mode = 'full';
    f.saved.vertexai_express_project_id = 'old-project';
    f.context.extensionSettings.connectionManager.selectedProfile = 'vertex';
    f.current.chat_completion_source = 'vertexai';
    const payload = await buildVertexPayload(f.context, f.profile, [], 1200);
    assert.equal(payload.vertexai_auth_mode, 'express');
    assert.equal(payload.vertexai_express_project_id, 'test-project');
    f.current.vertexai_express_project_id = '';
    assert.equal((await buildVertexPayload(f.context, f.profile, [], 1200)).vertexai_express_project_id, '');
});

test('a profile without a preset works, but a missing named preset gives a useful error', async () => {
    const f = fixture();
    delete f.profile.preset;
    assert.equal((await buildVertexPayload(f.context, f.profile, [], 1200)).vertexai_auth_mode, 'express');
    f.profile.preset = 'missing';
    f.context.getPresetManager = () => ({ getCompletionPresetByName: () => null });
    await assert.rejects(buildVertexPayload(f.context, f.profile, [], 1200), /프리셋을 찾을 수/);
});

test('Vertex reports ST authentication messages and upstream error codes without retrying', async () => {
    const f = fixture();
    const originalFetch = globalThis.fetch;
    let calls = 0;
    try {
        globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: true, message: 'API key is required for Vertex AI Express mode' }), { status: 400 }); };
        await assert.rejects(requestVertexProfile(f.context, f.profile, [], 1200), /HTTP 400.*API key is required/);
        assert.equal(calls, 1);
        globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: { code: 429, message: 'Quota exceeded' } }), { status: 500 }); };
        await assert.rejects(requestVertexProfile(f.context, f.profile, [], 1200), /HTTP 500 \/ 429.*Quota exceeded/);
        assert.equal(calls, 2);
    } finally { globalThis.fetch = originalFetch; }
});

test('successful response is returned through the ST backend with the original abort signal', async () => {
    const f = fixture();
    const controller = new AbortController();
    const originalFetch = globalThis.fetch;
    try {
        globalThis.fetch = async (url, options) => {
            assert.equal(url, '/api/backends/chat-completions/generate');
            assert.equal(options.signal, controller.signal);
            assert.equal(JSON.parse(options.body).vertexai_express_project_id, 'test-project');
            return new Response(JSON.stringify({ choices: [{ message: { content: '{"name":"NPC"}' } }] }));
        };
        assert.equal(await requestVertexProfile(f.context, f.profile, [], 1200, controller.signal), '{"name":"NPC"}');
        globalThis.fetch = async () => { throw new DOMException('Cancelled', 'AbortError'); };
        await assert.rejects(requestVertexProfile(f.context, f.profile, [], 1200, controller.signal), { name: 'AbortError' });
    } finally { globalThis.fetch = originalFetch; }
});

test('nested causes are visible and credential-shaped values are masked', () => {
    const message = describeRequestError(new Error('API request failed', { cause: new Error('Invalid key AIzaTEST_KEY https://example.test?key=private-value Bearer private-token') }));
    assert.match(message, /API request failed → Invalid key/);
    assert.doesNotMatch(message, /AIzaTEST_KEY|private-value|private-token/);
});
