import {
    buildEntryKeys,
    buildLorebookContent,
    detectNpcCandidates,
    sanitizeNpcProfile,
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
const EXTENSION_VERSION = '1.1.2';
const CHAT_LOREBOOK_METADATA_KEY = 'world_info';
const MAX_SCENES = 8;
const MAX_SCENE_CHARS = 1500;

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    windowSize: 30,
    minMessages: 2,
    lorebookTarget: 'character',
    profileId: '',
    maxTokens: 1200,
    dismissed: {},
    createdEntries: {},
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
    settings.dismissed = settings.dismissed && typeof settings.dismissed === 'object' ? settings.dismissed : {};
    settings.createdEntries = settings.createdEntries && typeof settings.createdEntries === 'object' ? settings.createdEntries : {};
    settings.lorebookTarget = settings.lorebookTarget === 'chat' ? 'chat' : 'character';
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

export function scanCandidates() {
    const settings = getSettings();
    lastMessages = collectRecentMessages();
    const dismissed = dismissedNames();
    lastCandidates = detectNpcCandidates(lastMessages, knownCharacterNames(), {
        minMessages: Number(settings.minMessages) || DEFAULT_SETTINGS.minMessages,
    }).filter((candidate) => !dismissed.has(candidate.name.toLocaleLowerCase()));
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
    const needle = candidate.name.toLocaleLowerCase();
    const scenes = [];
    for (const message of lastMessages) {
        if (scenes.length >= MAX_SCENES) break;
        const clean = stripDecorations(message.text);
        if (!clean.toLocaleLowerCase().includes(needle)) continue;
        scenes.push(`[${message.id} | speaker=${message.speaker}]\n${clean.slice(0, MAX_SCENE_CHARS)}`);
    }
    return scenes.join('\n\n');
}

function npcPromptMessages(candidate, sceneText, existingContent = '') {
    const context = getContext();
    const mainNames = [context.name1, context.name2].filter(Boolean).join(', ');
    const system = `You compile a factual profile card of one NPC from roleplay chat excerpts. Return JSON only, with no markdown.\n\nSchema:\n{"name":"","aliases":[""],"appearance":"","personality":"","speech_style":"","relationships":"","facts":[""],"example_lines":[""]}\n\nRules:\n- Target NPC: ${JSON.stringify(candidate.name)}. Ignore every other character.\n- Describe only what the excerpts actually show or strongly imply; never invent details.\n- Write appearance, personality, speech_style, relationships, and facts in Korean.\n- example_lines must be lines spoken by the target NPC, copied verbatim in their original language from the excerpts. If unsure who spoke a line, omit it.\n- relationships describes how the NPC relates to the main characters (${mainNames}).\n- Leave a field as an empty string or empty array when the excerpts give no information.\n- Return at most 6 facts and 5 example_lines.`;
    const existing = existingContent
        ? `\n\nAn earlier profile of this NPC exists. Merge it with the new excerpts and return the updated full profile:\n${existingContent.slice(0, 1500)}`
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

function parseProfileResponse(text) {
    const clean = String(text ?? '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('AI 응답에 JSON 객체가 없습니다.');
    return JSON.parse(clean.slice(start, end + 1));
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

async function confirmAction(title, message) {
    const popup = getContext().Popup;
    if (popup?.show?.confirm) return popup.show.confirm(title, message);
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') return window.confirm(message);
    return true;
}

export async function createNpcLorebookEntry(candidate, { manual = true } = {}) {
    const context = getContext();
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

        let data = null;
        try {
            data = await worldApi.loadWorldInfo(target.name);
        } catch {
            data = null;
        }
        if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') {
            data = { entries: {} };
        }
        if (existing && data.entries[existing.uid]) {
            existingContent = String(data.entries[existing.uid].content ?? '');
        }

        requestAbortController?.abort();
        requestAbortController = new AbortController();
        const response = await requestNpcProfile(
            npcPromptMessages(candidate, sceneText, existingContent),
            requestAbortController.signal,
        );
        const npc = sanitizeNpcProfile(parseProfileResponse(response), sceneText, candidate.name);
        if (!npc) throw new Error('AI가 만든 프로필이 검증을 통과하지 못했어요.');

        const content = buildLorebookContent(npc);
        const keys = buildEntryKeys(npc);
        if (manual) {
            const approved = await confirmAction(
                '🎭NPC 캐스팅룸',
                `"${npc.name}" 항목을 로어북 "${target.name}"에 저장할까요?\n\n${content.slice(0, 600)}`,
            );
            if (!approved) return { ok: false, reason: '저장을 취소했어요.' };
        }

        const uids = Object.keys(data.entries).map(Number).filter(Number.isFinite);
        const uid = existing && data.entries[existing.uid] ? Number(existing.uid) : (uids.length ? Math.max(...uids) + 1 : 0);
        const previous = data.entries[uid] && typeof data.entries[uid] === 'object' ? data.entries[uid] : null;
        data.entries[uid] = {
            ...(previous ?? newEntryTemplate(uid, keys, `🎭 ${npc.name}`, content)),
            uid,
            key: keys,
            comment: `🎭 ${npc.name}`,
            content,
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
            tracked.push({ name: npc.name, uid, world: target.name, createdAt: Date.now(), updatedAt: Date.now() });
        }
        saveSettings();
        return { ok: true, world: target.name, uid, name: npc.name, note: bindingNote };
    } finally {
        generating = false;
        requestAbortController = null;
        updateUi();
    }
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

async function generateFromUi(candidate) {
    try {
        const result = await queueOrGenerate(candidate, { manual: true });
        if (result.queued) {
            toastr.info(result.reason, '🎭캐스팅룸');
            return;
        }
        if (result.ok) {
            toastr.success(`"${result.name}" 항목을 로어북 "${result.world}"에 저장했어요.${result.note ?? ''}`, '🎭캐스팅룸');
            scanCandidates();
            updateUi();
        } else if (result.reason) {
            toastr.info(result.reason, '🎭캐스팅룸');
        }
    } catch (error) {
        if (error?.name === 'AbortError') return;
        console.error(`${LOG_PREFIX} NPC 항목 생성 실패`, error);
        toastr.error(`생성 실패: ${error?.message ?? error}`, '🎭캐스팅룸');
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
        const title = document.createElement('div');
        const name = document.createElement('div');
        name.className = 'npcc-item-name';
        name.textContent = candidate.name;
        const meta = document.createElement('small');
        meta.textContent = `답변 ${candidate.count}개 · 언급 ${candidate.mentions}회${candidate.dialogueLines.length ? ` · 대사 ${candidate.dialogueLines.length}개` : ''}`;
        title.append(name, meta);
        head.append(title);

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
    document.getElementById('npcc-enabled').checked = settings.enabled;
    document.getElementById('npcc-window-size').value = String(settings.windowSize);
    document.getElementById('npcc-min-messages').value = String(settings.minMessages);
    document.getElementById('npcc-target').value = settings.lorebookTarget;
    document.getElementById('npcc-candidate-count').textContent = String(settings.enabled ? lastCandidates.length : 0);
    const queueNote = document.getElementById('npcc-queue-note');
    if (queueNote) {
        queueNote.hidden = !queuedCandidate;
        queueNote.textContent = queuedCandidate
            ? `⏳ "${queuedCandidate.name}" 항목은 메인 연결의 채팅 생성이 끝나면 자동으로 만들어져요.`
            : '';
    }
    const header = document.getElementById('npcc-header-status');
    if (!settings.enabled) header.textContent = '현재 꺼져 있어요';
    else if (generating) header.textContent = 'AI가 프로필을 만드는 중이에요';
    else if (queuedCandidate) header.textContent = '메인 생성이 끝나면 이어서 만들 예정이에요';
    else header.textContent = lastCandidates.length ? `캐스팅 후보 ${lastCandidates.length}명 대기 중` : '새 NPC를 기다리는 중이에요';
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

    bindSetting('npcc-enabled', 'enabled', Boolean);
    bindSetting('npcc-window-size', 'windowSize', Number);
    bindSetting('npcc-min-messages', 'minMessages', Number);
    bindSetting('npcc-target', 'lorebookTarget', String);
    bindSetting('npcc-profile', 'profileId', String);

    document.getElementById('npcc-rescan')?.addEventListener('click', () => {
        scanCandidates();
        updateUi();
        toastr.success('최근 답변을 다시 스캔했어요.', '🎭캐스팅룸');
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
    if (!document.getElementById('npcc-enabled')) {
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
