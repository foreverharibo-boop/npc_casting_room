import {
    buildEntryKeys,
    buildLorebookContent,
    detectNpcCandidates,
    mergeCandidates,
    removeInferenceMarkers,
    sanitizeNpcProfile,
    sanitizeSheetProfile,
    stripDecorations,
} from './scout.js';

const MODULE_NAME = 'npcCastingRoom';
// Resolve the served extension path from this module's own URL so the
// extension works no matter what the installed folder (= GitHub repo) is named.
const EXTENSION_PATH = (() => {
    try {
        const parts = new URL('.', import.meta.url).pathname.split('/').filter(Boolean);
        const anchor = parts.lastIndexOf('extensions');
        if (anchor >= 0 && anchor < parts.length - 1) {
            return decodeURIComponent(parts.slice(anchor + 1).join('/'));
        }
    } catch { /* fall through to the default */ }
    return 'third-party/npc-casting-room';
})();
const LOG_PREFIX = '[🎭캐스팅룸]';
const EXTENSION_VERSION = '1.5.3';
const CHAT_LOREBOOK_METADATA_KEY = 'world_info';
// Backstop values only — the real bound is the scan window (스캔 범위) setting.
const MAX_SCENES = 500;
const MAX_SCENE_CHARS = 200000;

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    windowSize: 30,
    minMessages: 2,
    lorebookTarget: 'character',
    profileId: '',
    maxTokens: 1200,
    entryFormat: 'sheet',
    inferMissing: true,
    outputLanguage: 'english',
    dismissed: {},
    createdEntries: {},
    mergedGroups: {},
});

let uiReady = false;
let scanTimer = null;
let generating = false;
let runtimeActive = true;
let eventsRegistered = false;
let lastCandidates = [];
let lastMessages = [];
let mainGenerationBusy = false;
let queuedCandidate = null;
let requestAbortController = null;
let pendingDraft = null;
const registeredEventHandlers = [];

function getContext() {
    return SillyTavern.getContext();
}

function getEventTypes(context = getContext()) {
    return context.eventTypes ?? context.event_types ?? {};
}

function getSettings() {
    const context = getContext();
    const current = context.extensionSettings[MODULE_NAME];
    context.extensionSettings[MODULE_NAME] = {
        ...structuredClone(DEFAULT_SETTINGS),
        ...(current && typeof current === 'object' ? current : {}),
    };
    const settings = context.extensionSettings[MODULE_NAME];
    // SillyTavern already controls whether the extension is enabled. The
    // redundant master checkbox was removed from the drawer header, so migrate
    // any old saved "off" value to active instead of leaving the extension
    // stuck without a visible control that can turn it back on.
    settings.enabled = true;
    settings.dismissed = settings.dismissed && typeof settings.dismissed === 'object' ? settings.dismissed : {};
    settings.createdEntries = settings.createdEntries && typeof settings.createdEntries === 'object' ? settings.createdEntries : {};
    settings.mergedGroups = settings.mergedGroups && typeof settings.mergedGroups === 'object' ? settings.mergedGroups : {};
    settings.lorebookTarget = settings.lorebookTarget === 'chat' ? 'chat' : 'character';
    settings.entryFormat = settings.entryFormat === 'basic' ? 'basic' : 'sheet';
    settings.inferMissing = settings.inferMissing !== false;
    settings.outputLanguage = settings.outputLanguage === 'korean' ? 'korean' : 'english';
    settings.windowSize = Math.max(5, Math.round(Number(settings.windowSize) || DEFAULT_SETTINGS.windowSize));
    settings.maxTokens = Math.max(256, Math.round(Number(settings.maxTokens) || DEFAULT_SETTINGS.maxTokens));
    return settings;
}

function saveSettings() {
    getContext().saveSettingsDebounced();
}

function isGroupChat(context = getContext()) {
    return context.groupId !== undefined && context.groupId !== null && context.groupId !== '';
}

function messageText(message) {
    const swipeId = Number(message?.swipe_id) || 0;
    const activeSwipe = Array.isArray(message?.swipes) ? message.swipes[swipeId] : '';
    if (typeof activeSwipe === 'string' && activeSwipe.trim()) return activeSwipe.trim();
    return typeof message?.mes === 'string' ? message.mes.trim() : '';
}

export function collectRecentMessages() {
    const context = getContext();
    const settings = getSettings();
    const chat = Array.isArray(context.chat) ? context.chat : [];
    const limit = Math.max(5, Number(settings.windowSize) || DEFAULT_SETTINGS.windowSize);
    const collected = [];
    for (let index = chat.length - 1; index >= 0 && collected.length < limit; index -= 1) {
        const message = chat[index];
        if (!message || message.is_user || message.is_system || typeof message.mes !== 'string') continue;
        if (message.extra?.type === 'narrator' || message.extra?.type === 'system') continue;
        const text = messageText(message);
        if (text.length < 8) continue;
        collected.push({ id: `m${index}`, chatIndex: index, speaker: String(message.name ?? ''), text });
    }
    return collected.reverse();
}

export function knownCharacterNames() {
    const context = getContext();
    const names = [context.name1, context.name2];
    for (const character of Array.isArray(context.characters) ? context.characters : []) {
        if (character?.name) names.push(character.name);
    }
    if (Array.isArray(context.groups)) {
        for (const group of context.groups) {
            if (group?.name) names.push(group.name);
        }
    }
    const settings = getSettings();
    for (const entries of Object.values(settings.createdEntries)) {
        for (const entry of Array.isArray(entries) ? entries : []) {
            if (entry?.name) names.push(entry.name);
        }
    }
    return names.filter(Boolean);
}

function dismissScopeKey() {
    const context = getContext();
    if (isGroupChat(context)) return `chat:${context.chatId ?? ''}`;
    const character = context.characters?.[Number(context.characterId)];
    const avatar = String(character?.avatar ?? '').trim();
    return avatar ? `card:${avatar}` : `chat:${context.chatId ?? ''}`;
}

function dismissedNames() {
    const settings = getSettings();
    const list = settings.dismissed[dismissScopeKey()];
    return new Set(Array.isArray(list) ? list.map((value) => String(value).toLocaleLowerCase()) : []);
}

function dismissName(name) {
    const settings = getSettings();
    const key = dismissScopeKey();
    if (!Array.isArray(settings.dismissed[key])) settings.dismissed[key] = [];
    if (!settings.dismissed[key].includes(name)) settings.dismissed[key].push(name);
    settings.dismissed[key] = settings.dismissed[key].slice(-100);
    saveSettings();
}

function mergedGroupsForScope() {
    const settings = getSettings();
    const list = settings.mergedGroups[dismissScopeKey()];
    return Array.isArray(list) ? list : [];
}

export function mergeCandidateGroup(memberNames, displayName) {
    const members = [...new Set((memberNames ?? []).map((value) => String(value ?? '').trim()).filter(Boolean))];
    const name = String(displayName ?? '').trim() || members.join(' ');
    if (members.length < 2 || !name) return false;
    const settings = getSettings();
    const key = dismissScopeKey();
    if (!Array.isArray(settings.mergedGroups[key])) settings.mergedGroups[key] = [];
    // Groups overlapping the new selection are absorbed into it.
    const overlapping = settings.mergedGroups[key].filter((group) =>
        group.members.some((member) => members.some((value) => value.toLocaleLowerCase() === member.toLocaleLowerCase())));
    const allMembers = [...new Set([...members, ...overlapping.flatMap((group) => group.members)])];
    settings.mergedGroups[key] = settings.mergedGroups[key]
        .filter((group) => !overlapping.includes(group))
        .concat([{ name, members: allMembers }])
        .slice(-50);
    saveSettings();
    return true;
}

export function unmergeCandidateGroup(displayName) {
    const settings = getSettings();
    const key = dismissScopeKey();
    const list = Array.isArray(settings.mergedGroups[key]) ? settings.mergedGroups[key] : [];
    settings.mergedGroups[key] = list.filter((group) => group.name !== displayName);
    saveSettings();
}

export function scanCandidates() {
    const settings = getSettings();
    lastMessages = collectRecentMessages();
    const dismissed = dismissedNames();
    const detected = detectNpcCandidates(lastMessages, knownCharacterNames(), {
        minMessages: Number(settings.minMessages) || DEFAULT_SETTINGS.minMessages,
    });

    const byLower = new Map(detected.map((candidate) => [candidate.name.toLocaleLowerCase(), candidate]));
    const consumed = new Set();
    const merged = [];
    for (const group of mergedGroupsForScope()) {
        const parts = group.members
            .map((member) => byLower.get(member.toLocaleLowerCase()))
            .filter(Boolean);
        if (!parts.length) continue;
        parts.forEach((part) => consumed.add(part));
        merged.push(mergeCandidates(group, parts));
    }

    lastCandidates = [...merged, ...detected.filter((candidate) => !consumed.has(candidate))]
        .filter((candidate) => !dismissed.has(candidate.name.toLocaleLowerCase()))
        .sort((a, b) => b.score - a.score);
    return lastCandidates;
}

function sanitizeBookName(value) {
    return String(value ?? '')
        .replace(/[\\/:*?"<>|#%&{}$!'@`+=]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60) || 'character';
}

export function resolveTargetBook() {
    const context = getContext();
    const settings = getSettings();
    if (settings.lorebookTarget === 'chat' || isGroupChat(context)) {
        const metadata = context.chatMetadata;
        if (!metadata || typeof metadata !== 'object') return null;
        let name = typeof metadata[CHAT_LOREBOOK_METADATA_KEY] === 'string' ? metadata[CHAT_LOREBOOK_METADATA_KEY].trim() : '';
        if (!name) {
            name = sanitizeBookName(`캐스팅룸-챗-${context.chatId ?? 'chat'}`);
            metadata[CHAT_LOREBOOK_METADATA_KEY] = name;
            if (typeof context.saveMetadataDebounced === 'function') context.saveMetadataDebounced();
        }
        return { name, binding: 'chat' };
    }
    const character = context.characters?.[Number(context.characterId)];
    if (!character) return null;
    const primary = character?.data?.extensions?.world;
    if (typeof primary === 'string' && primary.trim()) {
        // Respect an existing character lorebook: add NPC entries to it
        // instead of competing with a second book.
        return { name: primary.trim(), binding: 'existing' };
    }
    return { name: sanitizeBookName(`캐스팅룸-${character.name ?? 'character'}`), binding: 'new-character' };
}

async function getWorldApi() {
    const context = getContext();
    if (typeof context.loadWorldInfo === 'function' && typeof context.saveWorldInfo === 'function') return context;
    try {
        const module = await import('../../../world-info.js');
        if (typeof module.loadWorldInfo === 'function' && typeof module.saveWorldInfo === 'function') return module;
    } catch (error) {
        console.debug(`${LOG_PREFIX} world-info.js 직접 임포트 실패`, error);
    }
    return null;
}

async function getWriteExtensionField() {
    const context = getContext();
    if (typeof context.writeExtensionField === 'function') return context.writeExtensionField;
    try {
        const module = await import('../../../extensions.js');
        if (typeof module.writeExtensionField === 'function') return module.writeExtensionField;
    } catch (error) {
        console.debug(`${LOG_PREFIX} extensions.js 직접 임포트 실패`, error);
    }
    return null;
}

function buildScenesFor(candidate) {
    const needles = [candidate.name, ...(candidate.members ?? [])]
        .map((value) => String(value ?? '').toLocaleLowerCase())
        .filter(Boolean);
    const scenes = [];
    for (const message of lastMessages) {
        if (scenes.length >= MAX_SCENES) break;
        const clean = stripDecorations(message.text);
        const lower = clean.toLocaleLowerCase();
        if (!needles.some((needle) => lower.includes(needle))) continue;
        scenes.push(`[${message.id} | speaker=${message.speaker}]\n${clean.slice(0, MAX_SCENE_CHARS)}`);
    }
    return scenes.join('\n\n');
}

function referenceSheetText() {
    const context = getContext();
    if (isGroupChat(context)) return '';
    const character = context.characters?.[Number(context.characterId)];
    const description = String(character?.description ?? character?.data?.description ?? '').trim();
    // Long character sheets are the format reference — clip only as a runaway
    // backstop, far above any realistic sheet length.
    return description.slice(0, 1000000);
}

function npcSheetPromptMessages(candidate, sceneText, referenceSheet, existingContent = '') {
    const alsoCalled = candidate.members?.length
        ? ` This NPC is also referred to as: ${candidate.members.map((member) => JSON.stringify(member)).join(', ')}. Treat all of these as the same person.`
        : '';
    const settings = getSettings();
    const languageName = settings.outputLanguage === 'korean' ? 'Korean' : 'English';
    const coverageRule = settings.inferMissing
        ? `- Fill EVERY section of the sheet; leave nothing empty. When the excerpts give no direct information for a section, infer the most plausible value from the NPC's shown behavior, dialogue, and context, and append the exact marker "(추정)" to each inferred value (always this Korean marker, regardless of the writing language). Inferences must never contradict anything shown in the excerpts.`
        : `- Omit sections the excerpts give no information for.\n- Describe only what the excerpts actually show or strongly imply; never invent details.`;
    const languageRule = `- Write every field value in ${languageName}, regardless of the language of the excerpts or of the reference sheet. Keep the reference sheet's section labels and markup exactly as they are.`;
    const system = `You compile a factual profile of one NPC from roleplay chat excerpts, formatted to match a reference character sheet. Return JSON only, with no markdown fences.\n\nSchema:\n{"name":"","aliases":[""],"sheet":"","example_lines":[""]}\n\nRules:\n- Target NPC: ${JSON.stringify(candidate.name)}.${alsoCalled} Ignore every other character.\n- "sheet" must imitate the reference character sheet's format exactly: the same section names, the same order, the same markup or tag style, and the same language for section labels. Fill the sections with the TARGET NPC's information only.\n- The reference sheet describes a DIFFERENT character. Never copy its facts, personality, or story details — copy only its structure.\n${languageRule}\n${coverageRule}\n- example_lines: lines spoken by the target NPC, copied verbatim from the excerpts — include as many as the excerpts genuinely support. If unsure who spoke a line, omit it.\n- The sheet may be as long and detailed as the reference format requires.\n- The ENTIRE reply must be exactly one JSON object: the first character '{' and the last character '}'. No markdown, no commentary.`;
    const existing = existingContent
        ? `\n\nAn earlier profile of this NPC exists. Merge it with the new excerpts and return the updated full sheet:\n${existingContent.slice(0, 1000000)}`
        : '';
    const user = `Chat excerpts:\n\n${sceneText}\n\nReference character sheet (FORMAT ONLY — different character):\n${referenceSheet}${existing}`;
    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
}

function npcPromptMessages(candidate, sceneText, existingContent = '') {
    const context = getContext();
    const mainNames = [context.name1, context.name2].filter(Boolean).join(', ');
    const alsoCalled = candidate.members?.length
        ? ` This NPC is also referred to as: ${candidate.members.map((member) => JSON.stringify(member)).join(', ')}. Treat all of these as the same person.`
        : '';
    const system = `You compile a factual profile card of one NPC from roleplay chat excerpts. Return JSON only, with no markdown.\n\nSchema:\n{"name":"","aliases":[""],"appearance":"","personality":"","speech_style":"","relationships":"","facts":[""],"example_lines":[""]}\n\nRules:\n- Target NPC: ${JSON.stringify(candidate.name)}.${alsoCalled} Ignore every other character.\n- Describe only what the excerpts actually show or strongly imply; never invent details.\n- Write appearance, personality, speech_style, relationships, and facts in ${getSettings().outputLanguage === 'korean' ? 'Korean' : 'English'}.\n- example_lines must be lines spoken by the target NPC, copied verbatim in their original language from the excerpts. If unsure who spoke a line, omit it.\n- relationships describes how the NPC relates to the main characters (${mainNames}).\n${getSettings().inferMissing
        ? '- Fill every field; leave nothing empty. When the excerpts give no direct information, infer the most plausible value from the NPC\'s shown behavior, dialogue, and context, and append "(추정)" to each inferred value. Inferences must never contradict the excerpts.'
        : '- Leave a field as an empty string or empty array when the excerpts give no information.'}\n- Include as many facts and example_lines as the excerpts genuinely support.\n- Keep appearance, personality, speech_style, and relationships each under 300 characters, and each fact under 150 characters, so the whole reply fits within the response token limit.\n- The ENTIRE reply must be exactly one JSON object: the first character '{' and the last character '}'. No markdown, no bullet lists, no headings, no commentary, no code fences.`;
    const existing = existingContent
        ? `\n\nAn earlier profile of this NPC exists. Merge it with the new excerpts and return the updated full profile:\n${existingContent.slice(0, 1000000)}`
        : '';
    const user = `Chat excerpts:\n\n${sceneText}${existing}`;
    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
}

async function requestNpcProfile(prompt, signal) {
    const context = getContext();
    const settings = getSettings();
    const profileId = String(settings.profileId ?? '').trim();
    const maxTokens = Number(settings.maxTokens) || DEFAULT_SETTINGS.maxTokens;

    if (profileId) {
        // A dedicated Connection Profile runs on its own pipeline, fully
        // separate from the main API connection — safe even mid-generation.
        const service = context.ConnectionManagerRequestService;
        if (!service || typeof service.sendRequest !== 'function') {
            throw new Error('Connection Profiles 서비스를 사용할 수 없습니다.');
        }
        const result = await service.sendRequest(profileId, prompt, maxTokens, {
            stream: false,
            signal,
            extractData: true,
        });
        if (typeof result === 'string') return result;
        if (result && typeof result.content === 'string') return result.content;
        throw new Error('연결 프로필이 텍스트를 반환하지 않았습니다.');
    }
    if (typeof context.generateRaw !== 'function') {
        throw new Error('현재 연결을 통한 백그라운드 생성을 사용할 수 없습니다.');
    }
    return context.generateRaw({ prompt, responseLength: maxTokens, trimNames: false, signal });
}

function balanceClosers(fragment) {
    let inString = false;
    let escaped = false;
    const stack = [];
    for (const ch of fragment) {
        if (escaped) {
            escaped = false;
            continue;
        }
        if (inString) {
            if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{') stack.push('}');
        else if (ch === '[') stack.push(']');
        else if (ch === '}' || ch === ']') stack.pop();
    }
    return { closers: stack.reverse().join(''), inString };
}

// Salvage a JSON object that was cut off mid-way by the response token limit:
// close the open string, trim dangling fragments, append missing brackets, and
// keep trimming at the last comma until something parses.
export function tryParseJsonLoose(fragment) {
    let candidate = String(fragment ?? '').trim();
    for (let attempt = 0; attempt < 40 && candidate.length > 2; attempt += 1) {
        const state = balanceClosers(candidate);
        let repaired = candidate + (state.inString ? '"' : '');
        repaired = repaired.replace(/[,:\s]+$/, '');
        try {
            return JSON.parse(repaired + balanceClosers(repaired).closers);
        } catch { /* trim further and retry */ }
        const cut = candidate.lastIndexOf(',');
        if (cut <= 0) break;
        candidate = candidate.slice(0, cut);
    }
    return null;
}

export function parseProfileResponse(text) {
    const raw = String(text ?? '');
    // Reasoning models may wrap or prefix the answer with think blocks.
    const clean = raw
        .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
        .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, ' ')
        .replace(/```(?:json)?/gi, '')
        .replace(/```/g, '')
        .trim();
    if (!clean) {
        throw new Error('AI가 빈 응답을 보냈어요. 추론(thinking) 모델이라면 생각에 토큰을 다 썼을 수 있으니, 설정에서 「응답 토큰」을 올려 보세요.');
    }
    const start = clean.indexOf('{');
    if (start < 0) {
        console.debug(`${LOG_PREFIX} JSON이 없는 응답 원문:`, raw.slice(0, 600));
        throw new Error(`AI 응답에 JSON 객체가 없습니다. 응답 시작 부분: "${clean.slice(0, 80)}"`);
    }
    const end = clean.lastIndexOf('}');
    if (end > start) {
        try {
            return JSON.parse(clean.slice(start, end + 1));
        } catch { /* fall through to loose repair */ }
    }
    const repaired = tryParseJsonLoose(clean.slice(start));
    if (repaired) {
        console.debug(`${LOG_PREFIX} 잘린 JSON 응답을 복구해서 사용했어요.`);
        return repaired;
    }
    console.debug(`${LOG_PREFIX} 복구 불가능한 응답 원문:`, raw.slice(0, 600));
    throw new Error('AI 응답이 중간에 잘려 복구하지 못했어요. 설정에서 「응답 토큰」을 올려 보세요.');
}

function newEntryTemplate(uid, keys, comment, content) {
    return {
        uid,
        key: keys,
        keysecondary: [],
        comment,
        content,
        constant: false,
        vectorized: false,
        selective: true,
        selectiveLogic: 0,
        addMemo: true,
        order: 100,
        position: 1,
        disable: false,
        excludeRecursion: false,
        preventRecursion: false,
        delayUntilRecursion: false,
        probability: 100,
        useProbability: true,
        depth: 4,
        group: '',
        groupOverride: false,
        groupWeight: 100,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: '',
        role: 0,
        sticky: 0,
        cooldown: 0,
        delay: 0,
        displayIndex: uid,
    };
}

function trackedEntries(bookName) {
    const settings = getSettings();
    if (!Array.isArray(settings.createdEntries[bookName])) settings.createdEntries[bookName] = [];
    return settings.createdEntries[bookName];
}

async function promptForName(defaultName) {
    const popup = getContext().Popup;
    try {
        if (popup?.show?.input) {
            const value = await popup.show.input('🎭NPC 캐스팅룸', '합친 NPC의 대표 이름을 정해 주세요.', defaultName);
            if (value === null || value === undefined) return null;
            return String(value).trim() || defaultName;
        }
    } catch (error) {
        console.debug(`${LOG_PREFIX} 이름 입력 팝업 실패`, error);
    }
    if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
        const value = window.prompt('합친 NPC의 대표 이름', defaultName);
        if (value === null) return null;
        return String(value).trim() || defaultName;
    }
    return defaultName;
}

export async function prepareNpcDraft(candidate) {
    if (generating) return { ok: false, reason: '이미 다른 NPC를 생성하는 중이에요.' };
    const target = resolveTargetBook();
    if (!target) return { ok: false, reason: '로어북을 연결할 캐릭터나 채팅을 찾을 수 없어요.' };
    const worldApi = await getWorldApi();
    if (!worldApi) return { ok: false, reason: '이 실리태번 버전에서는 로어북 API를 찾을 수 없어요.' };

    const sceneText = buildScenesFor(candidate);
    if (!sceneText) return { ok: false, reason: '이 NPC가 등장한 장면을 찾지 못했어요. 다시 스캔해 주세요.' };

    generating = true;
    updateUi();
    try {
        const tracked = trackedEntries(target.name);
        const existing = tracked.find((item) => item.name.toLocaleLowerCase() === candidate.name.toLocaleLowerCase());
        let existingContent = '';
        if (existing) {
            try {
                const data = await worldApi.loadWorldInfo(target.name);
                if (data?.entries?.[existing.uid]) {
                    existingContent = String(data.entries[existing.uid].content ?? '');
                }
            } catch { /* 기존 내용이 없으면 새로 작성 */ }
        }

        const settings = getSettings();
        const referenceSheet = settings.entryFormat !== 'basic' ? referenceSheetText() : '';
        const useSheetFormat = Boolean(referenceSheet);
        requestAbortController?.abort();
        requestAbortController = new AbortController();
        const response = await requestNpcProfile(
            useSheetFormat
                ? npcSheetPromptMessages(candidate, sceneText, referenceSheet, existingContent)
                : npcPromptMessages(candidate, sceneText, existingContent),
            requestAbortController.signal,
        );
        const parsed = parseProfileResponse(response);
        const npc = useSheetFormat
            ? sanitizeSheetProfile(parsed, sceneText, candidate.name)
            : sanitizeNpcProfile(parsed, sceneText, candidate.name);
        if (!npc) throw new Error('AI가 만든 프로필이 검증을 통과하지 못했어요.');
        // Merged candidates: every member name must survive as a lorebook key
        // so the entry triggers no matter which name the chat uses.
        for (const member of candidate.members ?? []) {
            if (member !== npc.name && !npc.aliases.includes(member)) npc.aliases.push(member);
        }
        npc.aliases = npc.aliases.slice(0, 24);

        let content;
        if (useSheetFormat) {
            content = npc.sheet;
            const missingLines = (npc.exampleLines ?? []).filter((line) => !content.includes(line));
            if (missingLines.length) {
                content += `\n\n예시 대사:\n${missingLines.map((line) => `- "${line}"`).join('\n')}`;
            }
        } else {
            content = buildLorebookContent(npc);
        }
        return {
            ok: true,
            draft: { npcName: npc.name, content, keys: buildEntryKeys(npc), target },
        };
    } finally {
        generating = false;
        requestAbortController = null;
        updateUi();
    }
}

export async function saveNpcDraft(draft) {
    const context = getContext();
    if (!draft?.npcName || !draft?.content || !draft?.target?.name) {
        return { ok: false, reason: '저장할 초안이 없어요.' };
    }
    const worldApi = await getWorldApi();
    if (!worldApi) return { ok: false, reason: '이 실리태번 버전에서는 로어북 API를 찾을 수 없어요.' };
    const target = draft.target;
    const tracked = trackedEntries(target.name);
    const existing = tracked.find((item) => item.name.toLocaleLowerCase() === draft.npcName.toLocaleLowerCase());

    let data = null;
    try {
        data = await worldApi.loadWorldInfo(target.name);
    } catch {
        data = null;
    }
    if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') {
        data = { entries: {} };
    }

    const uids = Object.keys(data.entries).map(Number).filter(Number.isFinite);
    const uid = existing && data.entries[existing.uid] ? Number(existing.uid) : (uids.length ? Math.max(...uids) + 1 : 0);
    const previous = data.entries[uid] && typeof data.entries[uid] === 'object' ? data.entries[uid] : null;
    data.entries[uid] = {
        ...(previous ?? newEntryTemplate(uid, draft.keys, `🎭 ${draft.npcName}`, draft.content)),
        uid,
        key: draft.keys,
        comment: `🎭 ${draft.npcName}`,
        content: draft.content,
    };
    await worldApi.saveWorldInfo(target.name, data, true);
    if (typeof worldApi.updateWorldInfoList === 'function') {
        try { await worldApi.updateWorldInfoList(); } catch { /* 목록 갱신은 실패해도 치명적이지 않음 */ }
    }

    let bindingNote = '';
    if (target.binding === 'new-character') {
        const writeField = await getWriteExtensionField();
        const characterId = Number(context.characterId);
        if (typeof writeField === 'function') {
            await writeField(characterId, 'world', target.name);
            const character = context.characters?.[characterId];
            if (character) {
                character.data = character.data && typeof character.data === 'object' ? character.data : {};
                character.data.extensions = character.data.extensions && typeof character.data.extensions === 'object' ? character.data.extensions : {};
                character.data.extensions.world = target.name;
            }
        } else {
            bindingNote = ' 카드 자동 연결에는 실패했으니 캐릭터 패널의 🌐 버튼에서 이 로어북을 직접 선택해 주세요.';
        }
    }

    if (existing) {
        existing.uid = uid;
        existing.updatedAt = Date.now();
    } else {
        tracked.push({ name: draft.npcName, uid, world: target.name, createdAt: Date.now(), updatedAt: Date.now() });
    }
    saveSettings();
    return { ok: true, world: target.name, uid, name: draft.npcName, note: bindingNote };
}

export async function createNpcLorebookEntry(candidate) {
    const prepared = await prepareNpcDraft(candidate);
    if (!prepared.ok) return prepared;
    return saveNpcDraft(prepared.draft);
}

/**
 * UI entry point. When the request would ride the main API connection while
 * the chat is still generating, defer it and run automatically afterwards.
 * A dedicated Connection Profile skips the queue entirely.
 */
export async function queueOrGenerate(candidate, options = {}) {
    const settings = getSettings();
    const useSeparateProfile = Boolean(String(settings.profileId ?? '').trim());
    if (!useSeparateProfile && mainGenerationBusy) {
        queuedCandidate = candidate;
        updateUi();
        return {
            ok: false,
            queued: true,
            reason: '메인 연결이 채팅을 생성하는 중이에요. 이번 생성이 끝나면 자동으로 이어서 만들게요.',
        };
    }
    return createNpcLorebookEntry(candidate, options);
}

export function getPendingDraft() {
    return pendingDraft;
}

async function generateFromUi(candidate) {
    try {
        const settings = getSettings();
        const useSeparateProfile = Boolean(String(settings.profileId ?? '').trim());
        if (!useSeparateProfile && mainGenerationBusy) {
            queuedCandidate = candidate;
            updateUi();
            toastr.info('메인 연결이 채팅을 생성하는 중이에요. 이번 생성이 끝나면 자동으로 초안을 만들게요.', '🎭캐스팅룸');
            return;
        }
        const prepared = await prepareNpcDraft(candidate);
        if (prepared.ok) {
            pendingDraft = prepared.draft;
            updateUi();
            toastr.success(`"${prepared.draft.npcName}" 초안이 준비됐어요. 내용을 확인하고 저장해 주세요.`, '🎭캐스팅룸');
        } else if (prepared.reason) {
            toastr.info(prepared.reason, '🎭캐스팅룸');
        }
    } catch (error) {
        if (error?.name === 'AbortError') return;
        console.error(`${LOG_PREFIX} NPC 항목 생성 실패`, error);
        const hint = /API request failed|Response not OK/i.test(String(error?.message))
            ? ' — 선택한 연결 프로필에 API·모델·키가 전부 저장돼 있는지 확인하고, 안 되면 「현재 연결 사용」으로 테스트해 보세요.'
            : '';
        toastr.error(`생성 실패: ${error?.message ?? error}${hint}`, '🎭캐스팅룸');
    }
}

function scheduleScan(delay = 600) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
        if (!runtimeActive) return;
        const settings = getSettings();
        if (!settings.enabled) {
            lastCandidates = [];
            updateUi();
            return;
        }
        scanCandidates();
        updateUi();
    }, delay);
}

function renderCandidates() {
    const list = document.getElementById('npcc-candidate-list');
    const empty = document.getElementById('npcc-empty');
    if (!list || !empty) return;
    list.replaceChildren();
    for (const candidate of lastCandidates) {
        const article = document.createElement('article');
        article.className = 'npcc-item';

        const head = document.createElement('div');
        head.className = 'npcc-item-head';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'npcc-merge-check';
        check.title = '합칠 후보 선택';
        check.dataset.npccName = candidate.name;
        const title = document.createElement('div');
        title.className = 'npcc-item-title';
        const name = document.createElement('div');
        name.className = 'npcc-item-name';
        name.textContent = candidate.merged ? `🔗 ${candidate.name}` : candidate.name;
        const meta = document.createElement('small');
        const mergedInfo = candidate.merged ? ` · 합침: ${candidate.members.join(' + ')}` : '';
        meta.textContent = `답변 ${candidate.count}개 · 언급 ${candidate.mentions}회${candidate.dialogueLines.length ? ` · 대사 ${candidate.dialogueLines.length}개` : ''}${mergedInfo}`;
        title.append(name, meta);
        head.append(check, title);

        const evidence = document.createElement('details');
        evidence.className = 'npcc-evidence';
        const summary = document.createElement('summary');
        summary.textContent = '등장 장면 보기';
        evidence.append(summary);
        for (const item of candidate.evidence) {
            const row = document.createElement('div');
            row.className = 'npcc-evidence-row';
            row.textContent = `“${item.snippet}”`;
            evidence.append(row);
        }

        const actions = document.createElement('div');
        actions.className = 'npcc-actions';
        const generate = document.createElement('button');
        generate.type = 'button';
        generate.className = 'menu_button';
        generate.textContent = '🎭 로어북 생성';
        generate.disabled = generating;
        generate.addEventListener('click', () => void generateFromUi(candidate));
        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.className = 'menu_button';
        dismiss.textContent = '무시';
        dismiss.addEventListener('click', () => {
            dismissName(candidate.name);
            scanCandidates();
            updateUi();
        });
        actions.append(generate, dismiss);
        if (candidate.merged) {
            const unmerge = document.createElement('button');
            unmerge.type = 'button';
            unmerge.className = 'menu_button';
            unmerge.textContent = '합침 해제';
            unmerge.addEventListener('click', () => {
                unmergeCandidateGroup(candidate.name);
                scanCandidates();
                updateUi();
            });
            actions.append(unmerge);
        }

        article.append(head, evidence, actions);
        list.append(article);
    }
    empty.hidden = lastCandidates.length !== 0;
    list.hidden = lastCandidates.length === 0;
}

function renderCreated() {
    const list = document.getElementById('npcc-created-list');
    const empty = document.getElementById('npcc-created-empty');
    if (!list || !empty) return;
    const settings = getSettings();
    const entries = Object.values(settings.createdEntries).flat().filter(Boolean);
    list.replaceChildren();
    for (const entry of entries) {
        const row = document.createElement('div');
        row.className = 'npcc-created-item';
        const label = document.createElement('span');
        label.textContent = `🎭 ${entry.name} → ${entry.world}`;
        const update = document.createElement('button');
        update.type = 'button';
        update.className = 'menu_button';
        update.textContent = '갱신';
        update.disabled = generating;
        update.addEventListener('click', () => {
            const candidate = lastCandidates.find((item) => item.name.toLocaleLowerCase() === entry.name.toLocaleLowerCase())
                ?? { name: entry.name, count: 0, mentions: 0, dialogueLines: [], evidence: [], messageIds: [] };
            void generateFromUi(candidate);
        });
        row.append(label, update);
        list.append(row);
    }
    empty.hidden = entries.length !== 0;
    list.hidden = entries.length === 0;
}

function populateProfiles() {
    if (!uiReady) return;
    const select = document.getElementById('npcc-profile');
    if (!select) return;
    const settings = getSettings();
    const currentValue = String(settings.profileId ?? '');
    select.replaceChildren();
    const current = document.createElement('option');
    current.value = '';
    current.textContent = '현재 연결 사용';
    select.append(current);
    try {
        const service = getContext().ConnectionManagerRequestService;
        const profiles = typeof service?.getSupportedProfiles === 'function' ? service.getSupportedProfiles() : [];
        for (const profile of profiles ?? []) {
            if (!profile?.id) continue;
            const option = document.createElement('option');
            option.value = String(profile.id);
            option.textContent = String(profile.name || profile.id);
            select.append(option);
        }
    } catch (error) {
        console.warn(`${LOG_PREFIX} 연결 프로필 목록을 불러오지 못했습니다.`, error);
    }
    if (currentValue && ![...select.options].some((option) => option.value === currentValue)) {
        const missing = document.createElement('option');
        missing.value = currentValue;
        missing.textContent = '저장된 연결 프로필을 찾을 수 없음';
        select.append(missing);
    }
    select.value = currentValue;
}

function setTab(tabName) {
    if (!uiReady) return;
    document.querySelectorAll('#npcc-settings [data-npcc-tab]').forEach((button) => {
        const active = button.dataset.npccTab === tabName;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
    });
    document.getElementById('npcc-panel-candidates').hidden = tabName !== 'candidates';
    document.getElementById('npcc-panel-settings').hidden = tabName !== 'settings';
}

function updateUi() {
    if (!uiReady) return;
    const settings = getSettings();
    document.getElementById('npcc-window-size').value = String(settings.windowSize);
    document.getElementById('npcc-min-messages').value = String(settings.minMessages);
    document.getElementById('npcc-target').value = settings.lorebookTarget;
    const maxTokensInput = document.getElementById('npcc-max-tokens');
    if (maxTokensInput) maxTokensInput.value = String(settings.maxTokens);
    const entryFormatSelect = document.getElementById('npcc-entry-format');
    if (entryFormatSelect) entryFormatSelect.value = settings.entryFormat;
    const inferMissingCheck = document.getElementById('npcc-infer-missing');
    if (inferMissingCheck) inferMissingCheck.checked = Boolean(settings.inferMissing);
    const languageSelect = document.getElementById('npcc-language');
    if (languageSelect) languageSelect.value = settings.outputLanguage;
    document.getElementById('npcc-candidate-count').textContent = String(settings.enabled ? lastCandidates.length : 0);
    const draftBox = document.getElementById('npcc-draft');
    if (draftBox) {
        draftBox.hidden = !pendingDraft;
        if (pendingDraft) {
            document.getElementById('npcc-draft-meta').textContent = `"${pendingDraft.npcName}" → 로어북 "${pendingDraft.target.name}" · 키워드: ${pendingDraft.keys.join(', ')}`;
            document.getElementById('npcc-draft-text').textContent = pendingDraft.content;
            const cleanButton = document.getElementById('npcc-draft-clean');
            if (cleanButton) cleanButton.disabled = !pendingDraft.content.includes('(추정)');
        }
    }
    const queueNote = document.getElementById('npcc-queue-note');
    if (queueNote) {
        queueNote.hidden = !queuedCandidate;
        queueNote.textContent = queuedCandidate
            ? `⏳ "${queuedCandidate.name}" 항목은 메인 연결의 채팅 생성이 끝나면 자동으로 만들어져요.`
            : '';
    }
    const targetNote = document.getElementById('npcc-target-note');
    if (targetNote) {
        targetNote.textContent = isGroupChat()
            ? '그룹챗에서는 채팅 로어북에만 저장돼요.'
            : settings.lorebookTarget === 'character'
                ? '같은 카드로 새 챗을 파도 NPC가 따라와요. 카드에 이미 로어북이 있으면 그 로어북에 항목을 추가해요.'
                : '이 채팅에서만 NPC가 유지돼요.';
    }
    renderCandidates();
    renderCreated();
}

function bindSetting(id, key, parser = (value) => value, afterChange = null) {
    const element = document.getElementById(id);
    if (!element) return;
    element.addEventListener('change', () => {
        const value = element.type === 'checkbox' ? element.checked : element.value;
        const settings = getSettings();
        settings[key] = parser(value);
        saveSettings();
        if (afterChange) afterChange(settings);
        scanCandidates();
        updateUi();
    });
}

function bindUi() {
    document.querySelectorAll('#npcc-settings [data-npcc-tab]').forEach((button) => {
        button.addEventListener('click', () => setTab(button.dataset.npccTab));
    });

    bindSetting('npcc-window-size', 'windowSize', (value) => {
        const parsed = Math.round(Number(value));
        return Number.isFinite(parsed) && parsed > 0
            ? Math.max(5, parsed)
            : DEFAULT_SETTINGS.windowSize;
    });
    bindSetting('npcc-min-messages', 'minMessages', Number);
    bindSetting('npcc-target', 'lorebookTarget', String);
    bindSetting('npcc-profile', 'profileId', String);
    bindSetting('npcc-entry-format', 'entryFormat', String);
    bindSetting('npcc-infer-missing', 'inferMissing', Boolean);
    bindSetting('npcc-language', 'outputLanguage', String);
    bindSetting('npcc-max-tokens', 'maxTokens', (value) => {
        const parsed = Math.round(Number(value));
        return Number.isFinite(parsed) && parsed > 0
            ? Math.max(256, parsed)
            : DEFAULT_SETTINGS.maxTokens;
    });

    document.getElementById('npcc-rescan')?.addEventListener('click', () => {
        scanCandidates();
        updateUi();
        toastr.success('최근 답변을 다시 스캔했어요.', '🎭캐스팅룸');
    });
    document.getElementById('npcc-draft-save')?.addEventListener('click', async () => {
        if (!pendingDraft) return;
        try {
            const result = await saveNpcDraft(pendingDraft);
            if (result.ok) {
                pendingDraft = null;
                scanCandidates();
                updateUi();
                toastr.success(`"${result.name}" 항목을 로어북 "${result.world}"에 저장했어요.${result.note ?? ''}`, '🎭캐스팅룸');
            } else if (result.reason) {
                toastr.error(result.reason, '🎭캐스팅룸');
            }
        } catch (error) {
            console.error(`${LOG_PREFIX} 초안 저장 실패`, error);
            toastr.error(`저장 실패: ${error?.message ?? error}`, '🎭캐스팅룸');
        }
    });
    document.getElementById('npcc-draft-clean')?.addEventListener('click', () => {
        if (!pendingDraft) return;
        pendingDraft.content = removeInferenceMarkers(pendingDraft.content);
        updateUi();
        toastr.success('"(추정)" 표시를 모두 지웠어요. 내용은 그대로예요.', '🎭캐스팅룸');
    });
    document.getElementById('npcc-draft-cancel')?.addEventListener('click', () => {
        pendingDraft = null;
        updateUi();
        toastr.info('생성을 취소했어요. 로어북에는 아무것도 저장되지 않았어요.', '🎭캐스팅룸');
    });

    document.getElementById('npcc-merge-selected')?.addEventListener('click', async () => {
        const checked = [...document.querySelectorAll('#npcc-candidate-list .npcc-merge-check:checked')]
            .map((element) => element.dataset.npccName)
            .filter(Boolean);
        if (checked.length < 2) {
            toastr.info('합칠 후보를 2개 이상 체크해 주세요.', '🎭캐스팅룸');
            return;
        }
        const defaultName = checked.join(' ');
        const name = await promptForName(defaultName);
        if (name === null) return;
        if (!mergeCandidateGroup(checked, name)) {
            toastr.error('후보를 합치지 못했어요.', '🎭캐스팅룸');
            return;
        }
        scanCandidates();
        updateUi();
        toastr.success(`"${name || defaultName}"(으)로 합쳤어요. 두 이름 모두 로어북 키워드에 들어가요.`, '🎭캐스팅룸');
    });
    document.getElementById('npcc-clear-dismissed')?.addEventListener('click', () => {
        const settings = getSettings();
        delete settings.dismissed[dismissScopeKey()];
        saveSettings();
        scanCandidates();
        updateUi();
        toastr.success('무시 목록을 초기화했어요.', '🎭캐스팅룸');
    });
}

async function initializeUi() {
    if (document.getElementById('npcc-settings')) {
        uiReady = true;
        return;
    }
    const context = getContext();
    const html = await context.renderExtensionTemplateAsync(EXTENSION_PATH, 'settings');
    const container = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!container) throw new Error('확장 설정 패널을 찾을 수 없습니다.');
    container.insertAdjacentHTML('beforeend', html);
    // A wrong template path can resolve to a 404 page instead of throwing.
    // Verify our actual markup arrived before wiring anything up.
    if (!document.getElementById('npcc-candidate-list')) {
        document.getElementById('npcc-settings')?.remove();
        throw new Error(`설정 템플릿을 불러오지 못했습니다 (경로: ${EXTENSION_PATH}). 설치 폴더 구조를 확인해 주세요.`);
    }
    uiReady = true;
    bindUi();
    populateProfiles();
    scanCandidates();
    updateUi();
}

function registerEvents() {
    if (eventsRegistered) return;
    const context = getContext();
    const events = getEventTypes(context);
    const listen = (eventName, handler) => {
        const event = events[eventName];
        if (!event) return;
        context.eventSource.on(event, handler);
        registeredEventHandlers.push({ event, handler });
    };
    listen('MESSAGE_RECEIVED', () => scheduleScan(700));
    listen('MESSAGE_EDITED', () => scheduleScan(700));
    listen('MESSAGE_DELETED', () => scheduleScan(700));
    listen('MESSAGE_SWIPED', () => scheduleScan(700));
    listen('GENERATION_STARTED', () => {
        mainGenerationBusy = true;
    });
    const finishMainGeneration = () => {
        mainGenerationBusy = false;
        if (!queuedCandidate) return;
        const candidate = queuedCandidate;
        queuedCandidate = null;
        setTimeout(() => {
            if (runtimeActive && getSettings().enabled) void generateFromUi(candidate);
        }, 400);
    };
    listen('GENERATION_ENDED', finishMainGeneration);
    listen('GENERATION_STOPPED', finishMainGeneration);
    listen('CHAT_CHANGED', () => {
        lastCandidates = [];
        lastMessages = [];
        queuedCandidate = null;
        pendingDraft = null;
        mainGenerationBusy = false;
        requestAbortController?.abort();
        populateProfiles();
        scheduleScan(200);
    });
    listen('CONNECTION_PROFILE_LOADED', populateProfiles);
    eventsRegistered = true;
}

function unregisterEvents() {
    if (!eventsRegistered) return;
    const eventSource = getContext().eventSource;
    for (const { event, handler } of registeredEventHandlers.splice(0)) {
        if (typeof eventSource.removeListener === 'function') eventSource.removeListener(event, handler);
        else if (typeof eventSource.off === 'function') eventSource.off(event, handler);
    }
    eventsRegistered = false;
}

async function initialize() {
    runtimeActive = true;
    getSettings();
    registerEvents();
    await initializeUi();
    console.log(`${LOG_PREFIX} v${EXTENSION_VERSION} 로드 완료`);
}

export function onEnable() {
    runtimeActive = true;
    registerEvents();
    scheduleScan(100);
}

export function onDisable() {
    runtimeActive = false;
    clearTimeout(scanTimer);
    queuedCandidate = null;
    pendingDraft = null;
    mainGenerationBusy = false;
    requestAbortController?.abort();
    unregisterEvents();
}

export function onClean() {
    const context = getContext();
    delete context.extensionSettings[MODULE_NAME];
    context.saveSettingsDebounced();
}

const context = getContext();
const events = getEventTypes(context);
if (events.APP_READY) {
    context.eventSource.on(events.APP_READY, () => {
        if (!runtimeActive) return;
        void initialize().catch((error) => {
            console.error(`${LOG_PREFIX} 초기화 실패`, error);
            toastr.error(`초기화 실패: ${error?.message ?? error}`, '🎭캐스팅룸');
        });
    });
} else {
    void initialize().catch((error) => console.error(`${LOG_PREFIX} 초기화 실패`, error));
}
