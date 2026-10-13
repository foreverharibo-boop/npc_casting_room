import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNpcCreationPrompt, collectNpcCreationBackground } from '../npc-creation.js';

let sequence = 0;
async function setup(overrides = {}) {
    let book = null;
    let writes = 0;
    let calls = 0;
    let prompt;
    const context = {
        eventTypes: { APP_READY: 'ready' },
        eventSource: { on() {}, removeListener() {} },
        extensionSettings: { npcCastingRoom: { entryFormat: 'balanced', outputLanguage: 'korean' } },
        chatMetadata: {}, chatId: 'new-npc-test', groupId: null, characterId: 0,
        name1: '사용자', name2: '주인공', chat: [], groups: [],
        characters: [{ name: '주인공', avatar: 'main.png', data: {} }],
        saveSettingsDebounced() {}, saveMetadataDebounced() {}, updateWorldInfoList: async () => {},
        loadWorldInfo: async () => book && structuredClone(book),
        saveWorldInfo: async (_name, data) => { writes++; book = structuredClone(data); },
        writeExtensionField: async (id, key, value) => {
            context.characters[id].data.extensions ??= {};
            context.characters[id].data.extensions[key] = value;
        },
        generateRaw: async (options) => {
            calls++;
            prompt = options.prompt;
            return JSON.stringify({ name: '서도윤', aliases: ['도윤'], sheet: '[NPC: 서도윤]\n성격: 말이 많고 눈치가 빠르다.', example_lines: ['가짜 과거 대사'] });
        },
        ...overrides,
    };
    globalThis.SillyTavern = { getContext: () => context };
    const module = await import(`../index.js?creation-test=${++sequence}`);
    return { module, context, book: () => book, writes: () => writes, calls: () => calls, prompt: () => prompt, setBook: (data) => { book = data; } };
}

test('등장 장면 없이 새 NPC를 만들고 수정 후에만 로어북에 저장·연결한다', async () => {
    const env = await setup();
    const result = await env.module.prepareNewNpcDraft({ concept: '35살 현장 동료. 말 많고 눈치 빠름.' });
    assert.equal(result.ok, true);
    assert.equal(result.draft.newNpc, true);
    assert.equal(result.draft.npcName, '서도윤');
    assert.equal(env.calls(), 1);
    assert.equal(env.writes(), 0);
    assert.equal(env.book(), null);
    assert.equal(env.context.characters[0].data.extensions, undefined);
    assert.doesNotMatch(result.draft.content, /가짜 과거 대사/);
    result.draft.content += '\n나이: 35세';
    assert.equal((await env.module.saveNpcDraft(result.draft)).ok, true);
    assert.deepEqual(env.book().entries[0].key, ['서도윤', '도윤']);
    assert.match(env.book().entries[0].content, /나이: 35세/);
    assert.equal(env.context.characters[0].data.extensions.world, '캐스팅룸-주인공');
    env.module.onDisable();
});

test('지정한 이름은 유지하고 원문 키워드로 저장한다', async () => {
    const env = await setup();
    const result = await env.module.prepareNewNpcDraft({ name: '김민철', concept: '현장 동료' });
    assert.equal(result.ok, true);
    assert.equal(result.draft.npcName, '김민철');
    assert.equal(result.draft.keys[0], '김민철');
    assert.match(env.prompt()[0].content, /The name must be exactly "김민철"/);
    env.module.onDisable();
});

test('빈 설정·빈 직접 양식은 API 호출 전에 거부한다', async () => {
    const env = await setup();
    assert.equal((await env.module.prepareNewNpcDraft({ concept: '  ' })).ok, false);
    env.context.extensionSettings.npcCastingRoom.entryFormat = 'custom';
    assert.equal((await env.module.prepareNewNpcDraft({ concept: '현장 동료' })).ok, false);
    assert.equal(env.calls(), 0);
    env.module.onDisable();
});

test('기존 로어북과 같은 이름은 생성 전에 거부한다', async () => {
    const env = await setup();
    env.setBook({ entries: { 4: { uid: 4, key: ['김민철'], content: '원본' } } });
    const result = await env.module.prepareNewNpcDraft({ name: '김민철', concept: '현장 동료' });
    assert.equal(result.ok, false);
    assert.equal(env.calls(), 0);
    assert.equal(env.writes(), 0);
    assert.equal(env.book().entries[4].content, '원본');
    env.module.onDisable();
});

test('AI가 정한 별칭 충돌과 생성 뒤 추가된 같은 이름을 거부한다', async () => {
    const env = await setup();
    env.setBook({ entries: { 4: { uid: 4, key: ['도윤'], content: '원본' } } });
    assert.equal((await env.module.prepareNewNpcDraft({ concept: '현장 동료' })).ok, false);
    env.setBook(null);
    const result = await env.module.prepareNewNpcDraft({ concept: '현장 동료' });
    env.setBook({ entries: { 4: { uid: 4, key: ['서도윤'], content: '나중에 추가한 원본' } } });
    assert.equal((await env.module.saveNpcDraft(result.draft)).ok, false);
    assert.equal(env.writes(), 0);
    assert.equal(env.book().entries[4].content, '나중에 추가한 원본');
    env.module.onDisable();
});

test('생성 중 채팅 전환 시 결과를 버리고 저장 전 전환도 거부한다', async () => {
    const env = await setup();
    const original = env.context.generateRaw;
    env.context.generateRaw = async (options) => {
        env.context.chatId = 'another-chat';
        return original(options);
    };
    assert.equal((await env.module.prepareNewNpcDraft({ concept: '현장 동료' })).ok, false);
    env.context.generateRaw = original;
    const result = await env.module.prepareNewNpcDraft({ concept: '현장 동료' });
    env.context.chatId = 'third-chat';
    assert.equal((await env.module.saveNpcDraft(result.draft)).ok, false);
    assert.equal(env.writes(), 0);
    env.module.onDisable();
});

test('기존 로어북 읽기 실패 시 새 NPC 생성을 중단한다', async () => {
    const env = await setup();
    env.context.characters[0].data.extensions = { world: '기존월드' };
    await assert.rejects(env.module.prepareNewNpcDraft({ concept: '현장 동료' }), /로어북을 읽지 못해/);
    assert.equal(env.calls(), 0);
    assert.equal(env.writes(), 0);
    env.module.onDisable();
});

test('창작 프롬프트는 네 양식·언어를 지원하며 수집 지시와 혼동하지 않는다', () => {
    for (const format of ['sheet', 'balanced', 'compact', 'custom']) {
        const prompt = buildNpcCreationPrompt({ name: '김민철', concept: '친한 사이는 아님', format,
            customFormat: '이름/직업/성격', referenceSheet: '<{{char}}>MAIN SECRET</{{char}}>', language: 'korean' });
        assert.match(prompt[0].content, /Preserve every explicit user constraint/);
        assert.match(prompt[0].content, /Do not change another character or invent shared past events/);
        assert.match(prompt[0].content, /Write field values in Korean/);
        assert.doesNotMatch(prompt[0].content, /copied verbatim from the excerpts|infer the most plausible/);
        assert.match(prompt[1].content, /친한 사이는 아님/);
        if (format === 'sheet') assert.match(prompt[1].content, /FORMAT ONLY/);
        if (format === 'custom') assert.match(prompt[0].content, /이름\/직업\/성격/);
    }
});

test('현재 카드와 현재 페르소나만 읽고 채팅·로어북·다른 페르소나는 보내지 않는다', async () => {
    const env = await setup({
        characters: [
            { name: '주인공', avatar: 'main.png', description: '<{{char}}>현장 노동자 {{char}}. {{user}}와 동거.</{{char}}>', personality: '능글맞음', scenario: '투룸', mes_example: '말투 견본', data: {} },
            { name: '다른카드', avatar: 'other.png', description: '전송하지 않을 다른 카드' },
        ],
        powerUserSettings: { persona_description: '{{user}}는 대학생.', persona_descriptions: { other: { description: '전송하지 않을 다른 페르소나' } } },
        chat: [{ name: '주인공', mes: '전송하지 않을 채팅 사건' }],
    });
    env.setBook({ entries: { 4: { key: ['다른인물'], content: '전송하지 않을 로어북 내용' } } });
    assert.equal((await env.module.prepareNewNpcDraft({ concept: '주인공의 현장 동료' })).ok, true);
    const text = JSON.stringify(env.prompt());
    for (const expected of ['현장 노동자 주인공', '사용자와 동거', '능글맞음', '투룸', '말투 견본', '사용자는 대학생']) assert.ok(text.includes(expected));
    assert.doesNotMatch(text, /전송하지 않을/);
    assert.doesNotMatch(text, /<주인공>|<\{\{char\}\}>/);
    assert.match(env.prompt()[0].content, /CURRENT persona sheets as background/);
    assert.match(env.prompt()[0].content, /flag the conflict in the draft/);
    env.module.onDisable();
});

test('설정 참고를 각각 끌 수 있고 껐을 때는 자료가 프롬프트에서 빠진다', async () => {
    const env = await setup({ powerUserSettings: { persona_description: '페르소나식별문구' } });
    env.context.characters[0].description = '캐시트식별문구';
    env.context.extensionSettings.npcCastingRoom.newNpcCharacterContext = false;
    assert.equal((await env.module.prepareNewNpcDraft({ concept: '현장 동료' })).ok, true);
    assert.doesNotMatch(JSON.stringify(env.prompt()), /캐시트식별문구/);
    assert.match(JSON.stringify(env.prompt()), /페르소나식별문구/);
    env.context.extensionSettings.npcCastingRoom.newNpcCharacterContext = true;
    env.context.extensionSettings.npcCastingRoom.newNpcPersonaContext = false;
    await env.module.prepareNewNpcDraft({ concept: '현장 동료' });
    assert.match(JSON.stringify(env.prompt()), /캐시트식별문구/);
    assert.doesNotMatch(JSON.stringify(env.prompt()), /페르소나식별문구/);
    env.context.extensionSettings.npcCastingRoom.newNpcCharacterContext = false;
    await env.module.prepareNewNpcDraft({ concept: '현장 동료' });
    assert.doesNotMatch(JSON.stringify(env.prompt()), /캐시트식별문구|페르소나식별문구/);
    env.module.onDisable();
});

test('긴 캐시트는 설정 참고와 양식 따라하기에 중복 전송되지 않는다', async () => {
    const env = await setup();
    env.context.characters[0].description = '<{{char}}>고유캐시트문구 {{char}}는 현장 노동자.</{{char}}>';
    env.context.extensionSettings.npcCastingRoom.entryFormat = 'sheet';
    await env.module.prepareNewNpcDraft({ concept: '현장 동료' });
    assert.equal(JSON.stringify(env.prompt()).split('고유캐시트문구').length - 1, 1);
    assert.match(env.prompt()[1].content, /description field of the background character/);
    env.context.extensionSettings.npcCastingRoom.newNpcCharacterContext = false;
    await env.module.prepareNewNpcDraft({ concept: '현장 동료' });
    assert.match(env.prompt()[1].content, /Reference sheet \(FORMAT ONLY, a different character\)/);
    assert.equal(JSON.stringify(env.prompt()).split('고유캐시트문구').length - 1, 1);
    env.module.onDisable();
});

test('그룹챗은 현재 그룹의 카드만 읽고 비어 있는 페르소나는 생략한다', () => {
    const background = collectNpcCreationBackground({
        groupId: 'g1', characterId: 2, name1: '사용자',
        groups: [{ id: 'g1', members: ['a.png', 'b.png'] }],
        characters: [
            { name: 'A', avatar: 'a.png', data: { description: 'A의 시트' } },
            { name: 'B', avatar: 'b.png', description: 'B의 시트' },
            { name: '밖의인물', avatar: 'c.png', description: '현재 그룹에 없는 시트' },
        ],
    });
    assert.deepEqual(background.characters.map((card) => card.name), ['A', 'B']);
    assert.equal(background.persona, null);
    assert.doesNotMatch(JSON.stringify(background), /현재 그룹에 없는/);
    assert.deepEqual(collectNpcCreationBackground({}, { characters: false, persona: false }), { characters: [], persona: null });
});

test('목록용 카드가 얕게 로드된 경우 현재 카드만 완전히 읽는다', async () => {
    const loaded = [];
    const env = await setup({ characters: [
        { name: '주인공', avatar: 'main.png', shallow: true, data: {} },
        { name: '다른카드', avatar: 'other.png', shallow: true },
    ] });
    env.context.unshallowCharacter = async (id) => {
        loaded.push(id);
        env.context.characters[id].description = '완전히 읽은 캐시트';
        env.context.characters[id].shallow = false;
    };
    assert.equal((await env.module.prepareNewNpcDraft({ concept: '현장 동료' })).ok, true);
    assert.deepEqual(loaded, [0]);
    assert.match(JSON.stringify(env.prompt()), /완전히 읽은 캐시트/);
    env.module.onDisable();
});
