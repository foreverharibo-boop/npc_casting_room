// Isolated Vertex requests: never switch the main connection or mutate its preset.
export function isVertexProfile(context, profile) {
    return profile?.api === 'vertexai'
        || context.CONNECT_API_MAP?.[profile?.api]?.source === 'vertexai';
}

export function describeRequestError(error) {
    const messages = [];
    const seen = new Set();
    for (let cause = error; cause && !seen.has(cause); cause = cause.cause) {
        seen.add(cause);
        const message = typeof cause === 'string' ? cause : cause.message;
        if (typeof message === 'string' && !messages.includes(message)) messages.push(message);
    }
    return (messages.join(' → ') || '알 수 없는 오류')
        .replace(/AIza[\w-]+/g, '[키 숨김]')
        .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [숨김]')
        .replace(/([?&](?:key|api_key|access_token)=)[^&\s"'<>]+/gi, '$1[숨김]')
        .slice(0, 700);
}

export async function buildVertexPayload(context, profile, prompt, maxTokens, useActiveKey = false) {
    const service = context.ChatCompletionService;
    if (typeof service?.presetToGeneratePayload !== 'function') {
        throw new Error('버텍스 요청 서비스를 사용할 수 없어요. 실리태번 버전을 확인해 주세요.');
    }
    const current = context.chatCompletionSettings ?? {};
    const saved = profile.preset
        ? context.getPresetManager?.('openai')?.getCompletionPresetByName(profile.preset)
        : null;
    if (profile.preset && !saved) {
        throw new Error('선택한 연결 프로필의 프리셋을 찾을 수 없어요. 연결 프로필에 프리셋을 다시 저장해 주세요.');
    }
    const preset = structuredClone(saved ?? {});
    const selected = context.extensionSettings?.connectionManager?.selectedProfile === profile.id
        && current.chat_completion_source === 'vertexai';
    // When this profile is active, honor the live Vertex controls. Otherwise use
    // its saved preset first, then the persisted Vertex-specific settings.
    const setting = (key) => selected ? (current[key] ?? preset[key]) : (preset[key] ?? current[key]);
    const authMode = setting('vertexai_auth_mode') || 'express';
    if (!['express', 'full'].includes(authMode)) throw new Error('버텍스 인증 방식이 올바르지 않아요.');
    const vertex = {
        chat_completion_source: 'vertexai',
        vertexai_auth_mode: authMode,
        vertexai_region: profile['api-url'] || setting('vertexai_region') || 'us-central1',
        vertexai_express_project_id: setting('vertexai_express_project_id') ?? '',
    };
    // The core profile service changes source AFTER generating preset parameters.
    // Set it before conversion so Vertex-only fields are included even when the
    // main connection or the saved preset uses a different provider.
    const payload = await service.presetToGeneratePayload({ ...preset, ...vertex }, {}, {
        ...vertex,
        model: profile.model,
        messages: prompt,
        max_tokens: maxTokens,
        stream: false,
        secret_id: useActiveKey ? null : profile['secret-id'],
    });
    // A saved proxy belongs to this profile; never inherit the main proxy.
    payload.reverse_proxy = '';
    payload.proxy_password = '';
    if (profile.proxy) {
        const proxies = context.proxies ?? (await import('/scripts/openai.js')).proxies;
        const proxy = proxies?.find((entry) => entry.name === profile.proxy);
        if (!proxy && !['<None>', '<Empty>'].includes(profile.proxy)) {
            throw new Error('선택한 연결 프로필의 프록시를 찾을 수 없어요.');
        }
        if (proxy) {
            payload.reverse_proxy = proxy.url;
            payload.proxy_password = proxy.password;
        }
    }
    if (profile['prompt-post-processing'] !== undefined) {
        payload.custom_prompt_post_processing = profile['prompt-post-processing'];
    }
    return payload;
}

export async function requestVertexProfile(context, profile, prompt, maxTokens, signal, useActiveKey = false) {
    const payload = await buildVertexPayload(context, profile, prompt, maxTokens, useActiveKey);
    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST', headers: context.getRequestHeaders(), cache: 'no-cache',
        body: JSON.stringify(payload), signal,
    });
    let data;
    try {
        data = await response.json();
    } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error;
        throw new Error(`버텍스 응답을 읽지 못했어요 (HTTP ${response.status}).`);
    }
    if (!response.ok || data?.error) {
        // ST sometimes returns {error:true,message:...}; core sendRequest drops
        // that message. Preserve it as well as Google's nested error code/status.
        const detail = typeof data?.error === 'string' ? data.error
            : data?.error?.message || data?.message || '서버에서 상세 오류를 반환하지 않았어요.';
        const upstreamCode = data?.error?.code || data?.error?.status;
        throw new Error(`버텍스 요청 실패 (HTTP ${response.status}${upstreamCode ? ` / ${upstreamCode}` : ''}): ${describeRequestError(String(detail))}`);
    }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
        throw new Error('버텍스가 빈 본문을 반환했어요. 출력 토큰 한도와 모델 설정을 확인해 주세요.');
    }
    return content;
}
