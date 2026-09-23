// Backstop values only — far above any realistic content, never a creative limit.
const MAX_MESSAGE_CHARS = 200000;
const MAX_CANDIDATES = 50;
const MAX_EVIDENCE = 10;
const MAX_DIALOGUE_LINES = 20;

const VOID_HTML_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
    'param', 'source', 'track', 'wbr',
]);

// Frequent capitalized English words that are not personal names.
const EN_COMMON_WORDS = new Set([
    'the', 'a', 'an', 'i', 'he', 'she', 'it', 'they', 'we', 'you', 'his', 'her', 'their', 'my', 'your',
    'our', 'its', 'mr', 'mrs', 'ms', 'dr', 'sir', 'madam', 'miss', 'lord', 'lady', 'god', 'oh', 'ah',
    'well', 'no', 'yes', 'okay', 'ok', 'but', 'and', 'or', 'then', 'when', 'what', 'why', 'how', 'where',
    'who', 'whose', 'if', 'as', 'at', 'in', 'on', 'of', 'to', 'so', 'not', 'now', 'just', 'still', 'even',
    'though', 'after', 'before', 'once', 'again', 'only', 'maybe', 'perhaps', 'please', 'wait', 'stop',
    'look', 'listen', 'hey', 'hi', 'hello', 'goodbye', 'right', 'fine', 'sure', 'really', 'there', 'here',
    'this', 'that', 'these', 'those', 'something', 'someone', 'nothing', 'everything', 'anyone',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
    'november', 'december', 'morning', 'evening', 'night', 'today', 'tomorrow', 'yesterday',
    'chapter', 'info', 'status', 'date', 'weather', 'location', 'inventory',
    'because', 'however', 'although', 'instead', 'meanwhile', 'suddenly', 'finally', 'later', 'earlier',
    'anyway', 'somehow', 'already', 'never', 'always', 'sometimes', 'often', 'could', 'would', 'should',
    'did', 'does', 'doing', 'have', 'has', 'had', 'having', 'been', 'being', 'let', 'everyone', 'everybody',
    'somebody', 'anybody', 'nobody', 'one', 'thing',
    'street', 'avenue', 'boulevard', 'road', 'highway', 'district', 'county', 'province',
    'city', 'town', 'village', 'airport', 'station', 'ocean', 'sea', 'river', 'lake',
]);

// Frequently mentioned real locations and geographic adjectives are not NPCs.
const EN_PLACE_NAMES = new Set([
    'california', 'seoul', 'incheon', 'pacific', 'atlantic', 'tokyo', 'osaka',
    'korea', 'japan', 'china', 'america', 'europe', 'asia', 'africa',
    'new york', 'los angeles', 'london', 'paris', 'busan', 'daegu',
]);
const EN_PLACE_DESIGNATORS = new Set([
    'street', 'st', 'avenue', 'ave', 'road', 'rd', 'boulevard', 'blvd', 'lane', 'ln',
    'district', 'city', 'county', 'province', 'state', 'airport', 'station',
    'ocean', 'sea', 'river', 'lake', 'mountain', 'island', 'high', 'highway',
]);

const WORD_PATTERN = /[A-Za-z][A-Za-z'’\-]*|[가-힣]+/g;
const EN_CONTRACTION_ENDING = /'(?:m|re|ve|ll|d|t)$/i;

// Frequent Korean two-plus-syllable stems that are not personal names.
const KO_COMMON_STEMS = new Set([
    '그녀', '그것', '그거', '이것', '저것', '우리', '당신', '자신', '자기', '사람', '여자', '남자',
    '아이', '소년', '소녀', '친구', '목소리', '시선', '얼굴', '손길', '생각', '마음', '순간', '시간',
    '오늘', '내일', '어제', '지금', '여기', '거기', '저기', '하지만', '그리고', '그래서', '그런데',
    '정말', '진짜', '제발', '조금', '천천', '갑자기', '다시', '이제', '아직', '거의', '모두', '서로',
    '함께', '문득', '잠시', '고개', '숨결', '입술', '어깨', '대답', '질문', '이야기', '모습', '느낌',
    '소리', '기분', '표정', '분위기', '상대', '상황', '문제', '이유', '대화', '자리', '주변', '근처',
    '하나', '무언가', '누군가', '어딘가', '스스로', '온몸', '심장', '숨소리', '한숨', '눈빛', '눈동자',
    '위로', '손가락', '하지', '쪽으', '허리', '열기', '침대', '들어', '공기', '기사', '속에서',
    '에어컨', '사이', '목덜미', '당장', '바닥', '전까지', '체온', '이내', '너머', '바람',
    '위에', '골반', '안쪽', '없어', '손바닥', '이성', '아까', '억울함', '소유욕', '아니',
    '매트리스', '뻗어', '핏대', '머리카락', '머릿속',
    '쾌감', '맞닿', '기세', '번화', '땀방울', '그제', '더욱', '뒤에', '갈아',
]);
const KO_PLACE_STEMS = new Set([
    '서울', '인천', '부산', '대구', '대전', '광주', '울산', '세종', '제주', '경기',
    '강원', '충북', '충남', '전북', '전남', '경북', '경남', '일본', '중국', '미국',
]);

// Longest-first so 께서는 wins over 는.
const KO_SUFFIXES = [
    '께서는', '께서', '에게서', '한테서', '이라고', '라고요', '이라는', '라고', '라는', '에게로',
    '에게', '한테', '에서', '으로', '부터', '까지', '와는', '과는', '와의', '과의', '이랑', '씨는',
    '씨가', '씨의', '님은', '님이', '님의', '로', '랑', '와', '과', '씨', '님', '은', '는', '이', '가',
    '을', '를', '의', '도', '만', '아', '야', '에',
].sort((left, right) => right.length - left.length);

const QUOTE_PATTERN = /"([^"\n]{2,})"|“([^”\n]{2,})”|‘([^’\n]{2,})’|「([^」\n]{2,})」|『([^』\n]{2,})』/g;
const KO_ACTOR_SUFFIX = /(?:께서는|께서|씨는|씨가|님은|님이|은|는|이|가)$/u;
const KO_PERSON_ACTION = /(?:말하|말했|물었|묻고|대답하|대답했|웃었|웃으며|웃고|울었|울며|외쳤|속삭였|중얼거렸|부르|불렀|쳐다봤|바라봤|고개를|시선을|코웃음|앉았|앉아|일어섰|일어나|들어왔|나갔|걸어왔|걸어갔|다가왔|다가갔|다가오|다가가|고개를 저|으쓱|칭얼거렸|스쳐 지나갔|떠났|떠올렸|도착했|돌아왔|손을 내밀|손을 뻗|잔을 건넸|잔을 닦)/u;
const KO_PERSON_ADDRESS = /(?:씨|님|께서)$/u;

export function stripAllPairedTagBlocks(text) {
    const input = String(text ?? '');
    const tagPattern = /<(\/?)\s*([A-Za-z][A-Za-z0-9_:-]*)(?:\s[^<>]*?)?\s*(\/?)>/g;
    const stack = [];
    const ranges = [];
    let match;

    while ((match = tagPattern.exec(input)) !== null) {
        const closing = match[1] === '/';
        const name = match[2].toLocaleLowerCase();
        const selfClosing = match[3] === '/' || VOID_HTML_TAGS.has(name);
        if (!closing) {
            if (!selfClosing) stack.push({ name, start: match.index });
            continue;
        }
        let openingIndex = -1;
        for (let index = stack.length - 1; index >= 0; index -= 1) {
            if (stack[index].name === name) {
                openingIndex = index;
                break;
            }
        }
        if (openingIndex < 0) continue;
        ranges.push([stack[openingIndex].start, tagPattern.lastIndex]);
        stack.splice(openingIndex);
    }

    if (!ranges.length) return input;
    ranges.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
    const merged = [];
    for (const range of ranges) {
        const previous = merged.at(-1);
        if (!previous || range[0] > previous[1]) merged.push([...range]);
        else previous[1] = Math.max(previous[1], range[1]);
    }
    let cursor = 0;
    let output = '';
    for (const [start, end] of merged) {
        output += `${input.slice(cursor, start)} `;
        cursor = end;
    }
    return `${output}${input.slice(cursor)}`;
}

export function stripDecorations(text) {
    let clean = String(text ?? '')
        .replace(/<info[_-]?panel\b[^>]*>[\s\S]*?<\/info[_-]?panel\s*>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
        .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
        .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, ' ');
    clean = stripAllPairedTagBlocks(clean);
    return clean
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\r/g, '')
        .replace(/[ \t]+/g, ' ')
        .trim()
        .slice(0, MAX_MESSAGE_CHARS);
}

function splitSentences(text) {
    return String(text ?? '')
        .split(/\n+/)
        .flatMap((chunk) => chunk.split(/(?<=[.!?。！？…])\s+/u))
        .map((sentence) => sentence.replace(/^[*_~\s]+|[*_~\s]+$/g, '').trim())
        .filter((sentence) => sentence.length >= 2);
}

function extractQuotes(sentence) {
    const quotes = [];
    QUOTE_PATTERN.lastIndex = 0;
    let match;
    while ((match = QUOTE_PATTERN.exec(sentence)) !== null) {
        const spoken = match.slice(1).find(Boolean)?.trim();
        if (spoken) quotes.push(spoken);
    }
    return quotes;
}

function koreanStem(token) {
    for (const suffix of KO_SUFFIXES) {
        if (token.endsWith(suffix)) {
            // Never retry a shorter suffix: "쪽으로" must not become "쪽으"+"로".
            if (token.length - suffix.length < 2) return '';
            return token.slice(0, token.length - suffix.length);
        }
    }
    return '';
}

function hasKoreanPersonContext(sentence, token, index) {
    if (KO_PERSON_ADDRESS.test(token)) return true;
    if (!KO_ACTOR_SUFFIX.test(token)) return false;
    const following = sentence.slice(index + token.length, index + token.length + 44)
        .split(/[,.!?。！？\n]/u, 1)[0];
    const action = KO_PERSON_ACTION.exec(following);
    if (!action) return false;
    // "쾌감이 번졌다. 신은 웃었다" does not make 쾌감 a person.
    const beforeAction = following.slice(0, action.index);
    return !/[가-힣]{2,6}(?:은|는|이|가)\s/u.test(beforeAction);
}

function buildKnownSet(names) {
    const known = new Set();
    for (const name of names ?? []) {
        const clean = String(name ?? '').trim();
        if (!clean) continue;
        known.add(clean.toLocaleLowerCase());
        // A three-syllable Korean full name is often shortened to its given name.
        if (/^[가-힣]{3}$/.test(clean)) known.add(clean.slice(1));
        for (const token of clean.match(WORD_PATTERN) ?? []) {
            if (token.length >= 2) known.add(token.toLocaleLowerCase());
        }
    }
    return known;
}

/** Verify model suggestions against the actual chat before showing them. */
export function validateAiNpcCandidates(raw, messages, knownNames = [], options = {}) {
    const known = buildKnownSet(knownNames);
    const minMessages = Math.max(2, Number(options.minMessages) || 2);
    const items = Array.isArray(raw?.npcs) ? raw.npcs : [];
    const results = [];
    const seen = new Set();
    for (const item of items.slice(0, 100)) {
        const name = String(item?.name ?? '').trim();
        const lower = name.toLocaleLowerCase();
        if (!name || name.length > 80 || seen.has(lower) || known.has(lower)) continue;
        if (!/^(?:[가-힣]{2,6}(?:\s+[가-힣]{2,6})?|[A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z][A-Za-z'’\-]*){0,3})$/u.test(name)) continue;
        if (EN_COMMON_WORDS.has(lower) || EN_PLACE_NAMES.has(lower) ||
            name.split(/\s+/).some((part) => EN_PLACE_DESIGNATORS.has(part.toLocaleLowerCase())) ||
            KO_COMMON_STEMS.has(name) || KO_PLACE_STEMS.has(name)) continue;
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = /^[가-힣\s]+$/u.test(name)
            ? new RegExp(`(^|[^가-힣])${escaped}`, 'u')
            : new RegExp(`(^|[^A-Za-z])${escaped}(?=$|[^A-Za-z])`, 'i');
        const matches = (messages ?? []).map((message) => ({ message, clean: stripDecorations(message?.text) }))
            .filter(({ clean }) => pattern.test(clean));
        if (matches.length < minMessages) continue;
        // Require a short, verbatim quote mentioning the name in the chat.
        // A model-generated name or unsupported person claim cannot pass.
        const quotes = Array.isArray(item?.evidence) ? item.evidence : [];
        const grounded = quotes.map((quote) => String(quote ?? '').trim())
            .filter((quote) => quote.length >= name.length + 3 && quote.length <= 300 && pattern.test(quote) &&
                matches.some(({ clean }) => clean.includes(quote)));
        if (!grounded.length) continue;
        seen.add(lower);
        const evidence = matches.slice(0, 10).map(({ message, clean }) => {
            const quote = grounded.find((value) => clean.includes(value));
            const position = clean.search(pattern);
            return { messageId: message.id, snippet: (quote || clean.slice(Math.max(0, position - 75), position + 125)).slice(0, 200) };
        });
        results.push({
            name, kind: 'ai', count: matches.length, mentions: matches.length,
            messageIds: matches.map(({ message }) => message.id), evidence, dialogueLines: [],
            score: matches.length * 10 + grounded.length,
        });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES);
}

/**
 * Find NPC candidates: repeated names that are absent from every known
 * character card. Local heuristic only; false positives are expected and the
 * UI keeps a human in the loop.
 * messages: [{ id, text }]
 */
export function detectNpcCandidates(messages, knownNames = [], options = {}) {
    const minMessages = Math.max(2, Number(options.minMessages) || 2);
    const known = buildKnownSet(knownNames);
    const stems = new Map();

    const record = (stemKey, display, messageId, sentence, flags) => {
        if (!stems.has(stemKey)) {
            stems.set(stemKey, {
                display,
                mentions: 0,
                messageIds: new Set(),
                evidence: new Map(),
                dialogueLines: [],
                personMessageIds: new Set(),
                hasSuffixForm: false,
                hasMidSentence: false,
                hasBareForm: false,
                kind: flags.kind,
            });
        }
        const entry = stems.get(stemKey);
        entry.mentions += 1;
        entry.messageIds.add(messageId);
        entry.hasSuffixForm ||= Boolean(flags.suffixForm);
        entry.hasMidSentence ||= Boolean(flags.midSentence);
        entry.hasBareForm ||= Boolean(flags.bareForm);
        if (flags.personCue) entry.personMessageIds.add(messageId);
        if (!entry.evidence.has(messageId)) entry.evidence.set(messageId, sentence.slice(0, 200));
        for (const quote of flags.quotes ?? []) {
            if (entry.dialogueLines.length >= MAX_DIALOGUE_LINES) break;
            if (!entry.dialogueLines.includes(quote)) entry.dialogueLines.push(quote.slice(0, 200));
        }
    };

    for (const message of messages ?? []) {
        const clean = stripDecorations(message?.text);
        if (!clean) continue;
        for (const sentence of splitSentences(clean)) {
            const quotes = extractQuotes(sentence);
            const tokens = [...sentence.matchAll(WORD_PATTERN)];
            for (const [tokenIndex, tokenMatch] of tokens.entries()) {
                const token = tokenMatch[0];
                const normalizedEnglish = token.replace(/’/g, "'");
                if (/^[A-Z][a-z'\-]{2,}$/.test(normalizedEnglish)) {
                    // English contractions such as "I'm", "we're", "he'll",
                    // "I'd" and "can't" are capitalized words, not names.
                    if (EN_CONTRACTION_ENDING.test(normalizedEnglish)) continue;
                    // Possessives ("Dana's", "Marcus'") are the same name, not
                    // a new one — strip them before the known-name check.
                    const possessive = /'(?:s)?$/i.test(normalizedEnglish);
                    const stem = normalizedEnglish.replace(/'(?:s)?$/i, '');
                    if (stem.length < 3) continue;
                    const lower = stem.toLocaleLowerCase();
                    if (EN_COMMON_WORDS.has(lower) || EN_PLACE_NAMES.has(lower) || known.has(lower)) continue;
                    const nextToken = tokens[tokenIndex + 1];
                    const gap = nextToken ? sentence.slice(tokenMatch.index + token.length, nextToken.index) : '';
                    if (nextToken && /^\s+$/.test(gap)
                        && EN_PLACE_DESIGNATORS.has(nextToken[0].toLocaleLowerCase().replace(/\.$/, ''))) continue;
                    record(lower, stem, message.id, sentence, {
                        kind: 'en',
                        midSentence: tokenIndex > 0,
                        bareForm: !possessive,
                        quotes,
                    });
                    continue;
                }
                if (/^[가-힣]{2,8}$/.test(token)) {
                    const stem = koreanStem(token);
                    const candidates = stem ? [{ stem, suffixForm: true }] : [{ stem: token, suffixForm: false }];
                    for (const { stem: value, suffixForm } of candidates) {
                        if (value.length < 2 || value.length > 6) continue;
                        if (KO_COMMON_STEMS.has(value) || KO_PLACE_STEMS.has(value) || known.has(value.toLocaleLowerCase())) continue;
                        record(`ko:${value}`, value, message.id, sentence, {
                            kind: 'ko',
                            suffixForm,
                            personCue: hasKoreanPersonContext(sentence, token, tokenMatch.index),
                            midSentence: true,
                            quotes,
                        });
                    }
                }
            }
        }
    }

    const results = [];
    for (const entry of stems.values()) {
        if (entry.messageIds.size < minMessages) continue;
        if (entry.mentions < minMessages) continue;
        // English names must appear mid-sentence at least once; Korean stems
        // must have appeared with a particle attached at least once. Both cut
        // most non-name noise while keeping real names.
        if (entry.kind === 'en' && (!entry.hasMidSentence || !entry.hasBareForm)) continue;
        if (entry.kind === 'ko' && (!entry.hasSuffixForm || !entry.personMessageIds.size)) continue;
        results.push({
            name: entry.display,
            kind: entry.kind,
            count: entry.messageIds.size,
            mentions: entry.mentions,
            messageIds: [...entry.messageIds],
            evidence: [...entry.evidence.entries()]
                .slice(0, MAX_EVIDENCE)
                .map(([messageId, snippet]) => ({ messageId, snippet })),
            dialogueLines: entry.dialogueLines,
            score: entry.messageIds.size * 10 + entry.mentions + (entry.dialogueLines.length ? 5 : 0),
        });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES);
}

/**
 * Merge several detected candidates (e.g. "캘런" and "밴스" for one NPC called
 * by given name and surname) into a single candidate under a display name.
 */
export function mergeCandidates(group, parts) {
    const messageIds = [...new Set(parts.flatMap((part) => part.messageIds ?? []))];
    const evidence = [];
    const seenEvidence = new Set();
    for (const part of parts) {
        for (const item of part.evidence ?? []) {
            if (seenEvidence.has(item.messageId)) continue;
            seenEvidence.add(item.messageId);
            evidence.push(item);
        }
    }
    const dialogueLines = [...new Set(parts.flatMap((part) => part.dialogueLines ?? []))].slice(0, MAX_DIALOGUE_LINES);
    const mentions = parts.reduce((sum, part) => sum + (Number(part.mentions) || 0), 0);
    return {
        name: group.name,
        kind: 'merged',
        merged: true,
        members: [...group.members],
        count: messageIds.length,
        mentions,
        messageIds,
        evidence: evidence.slice(0, MAX_EVIDENCE),
        dialogueLines,
        score: messageIds.length * 10 + mentions + (dialogueLines.length ? 5 : 0),
    };
}

function cleanProfileText(value, limit) {
    return String(value ?? '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\b(?:system|assistant|user)\s*:/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, limit);
}

function normalizeForMatch(value) {
    return String(value ?? '')
        .toLocaleLowerCase()
        .replace(/["“”‘’「」『』']/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Validate and sanitize the AI-compiled NPC profile. Rejects prompt-hijack
 * attempts and drops example lines that are not verbatim from the scenes.
 */
export function sanitizeNpcProfile(raw, sceneText, fallbackName = '') {
    if (!raw || typeof raw !== 'object') return null;
    const whole = JSON.stringify(raw);
    if (/\b(?:ignore|override|disregard)\b.{0,40}\b(?:instruction|prompt|rule)s?\b/i.test(whole)
        || /\b(?:reveal|print|repeat)\b.{0,40}\b(?:system prompt|hidden instruction)s?\b/i.test(whole)) return null;

    const name = cleanProfileText(raw.name, 200) || cleanProfileText(fallbackName, 200);
    if (!name) return null;
    const aliases = (Array.isArray(raw.aliases) ? raw.aliases : [])
        .map((value) => cleanProfileText(value, 100))
        .filter((value) => value && value !== name)
        .filter((value, index, all) => all.indexOf(value) === index)
        .slice(0, 20);
    const appearance = cleanProfileText(raw.appearance, 10000);
    const personality = cleanProfileText(raw.personality, 10000);
    const speechStyle = cleanProfileText(raw.speech_style ?? raw.speechStyle, 10000);
    const relationships = cleanProfileText(raw.relationships, 10000);
    const facts = (Array.isArray(raw.facts) ? raw.facts : [])
        .map((value) => cleanProfileText(value, 4000))
        .filter(Boolean)
        .slice(0, 50);
    const normalizedScenes = normalizeForMatch(sceneText);
    const exampleLines = (Array.isArray(raw.example_lines) ? raw.example_lines : [])
        .map((value) => cleanProfileText(value, 2000))
        .filter(Boolean)
        .filter((line) => normalizedScenes.includes(normalizeForMatch(line)))
        .slice(0, 30);

    if (!appearance && !personality && !speechStyle && !facts.length) return null;
    return { name, aliases, appearance, personality, speechStyle, relationships, facts, exampleLines };
}

/**
 * Sanitize a sheet-format profile: the sheet text imitates the character
 * card's own markup, so tags and line breaks are preserved — only control
 * characters, code fences, role prefixes, and hijack attempts are removed.
 */
export function sanitizeSheetProfile(raw, sceneText, fallbackName = '') {
    if (!raw || typeof raw !== 'object') return null;
    const whole = JSON.stringify(raw);
    if (/\b(?:ignore|override|disregard)\b.{0,40}\b(?:instruction|prompt|rule)s?\b/i.test(whole)
        || /\b(?:reveal|print|repeat)\b.{0,40}\b(?:system prompt|hidden instruction)s?\b/i.test(whole)) return null;

    const name = cleanProfileText(raw.name, 200) || cleanProfileText(fallbackName, 200);
    if (!name) return null;
    const aliases = (Array.isArray(raw.aliases) ? raw.aliases : [])
        .map((value) => cleanProfileText(value, 100))
        .filter((value) => value && value !== name)
        .filter((value, index, all) => all.indexOf(value) === index)
        .slice(0, 20);
    const sheet = String(raw.sheet ?? '')
        .replace(/```/g, '')
        .replace(/^\s*(?:system|assistant|user)\s*:/gim, '')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, 1000000);
    if (!sheet) return null;
    const normalizedScenes = normalizeForMatch(sceneText);
    const exampleLines = (Array.isArray(raw.example_lines) ? raw.example_lines : [])
        .map((value) => cleanProfileText(value, 2000))
        .filter(Boolean)
        .filter((line) => normalizedScenes.includes(normalizeForMatch(line)))
        .slice(0, 30);
    return { name, aliases, sheet, exampleLines };
}

/** Keep only genuinely new, scene-grounded additions for an existing entry. */
export function sanitizeNpcUpdates(raw, existingContent, sceneText) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.new_facts)) return null;
    const whole = JSON.stringify(raw);
    if (/\b(?:ignore|override|disregard)\b.{0,40}\b(?:instruction|prompt|rule)s?\b/i.test(whole)
        || /\b(?:reveal|print|repeat)\b.{0,40}\b(?:system prompt|hidden instruction)s?\b/i.test(whole)) return null;
    const source = normalizeForMatch(sceneText);
    const known = normalizeForMatch(existingContent);
    const seen = new Set();
    const facts = [];
    for (const item of raw.new_facts) {
        const fact = cleanProfileText(item?.fact, 200000);
        const evidence = cleanProfileText(item?.evidence, 2000);
        const normalized = normalizeForMatch(fact);
        if (!fact || !evidence || evidence.length < 8) continue;
        if (!source.includes(normalizeForMatch(evidence))) continue;
        if (known.includes(normalized) || seen.has(normalized)) continue;
        seen.add(normalized);
        facts.push(fact);
    }
    return facts;
}

/** Proposed edits must cite the current chat and point at one exact place in the existing entry. */
export function sanitizeNpcChangeSuggestions(raw, existingContent, sceneText) {
    if (!raw || typeof raw !== 'object' || (raw.new_facts !== undefined && !Array.isArray(raw.new_facts)) ||
        (raw.replacements !== undefined && !Array.isArray(raw.replacements))) return null;
    const whole = JSON.stringify(raw);
    if (/\b(?:ignore|override|disregard)\b.{0,40}\b(?:instruction|prompt|rule)s?\b/i.test(whole)
        || /\b(?:reveal|print|repeat)\b.{0,40}\b(?:system prompt|hidden instruction)s?\b/i.test(whole)) return null;
    const source = normalizeForMatch(sceneText);
    const known = normalizeForMatch(existingContent);
    const replacements = [];
    const occupied = [];
    for (const item of (raw.replacements ?? []).slice(0, 30)) {
        const oldText = String(item?.old_text ?? '').replace(/\r/g, '').trim();
        const newText = String(item?.new_text ?? '').replace(/\r/g, '').trim();
        const evidence = cleanProfileText(item?.evidence, 2000);
        if (oldText.length < 4 || oldText.length > 2000 || !newText || newText.length > 2000 ||
            !evidence || evidence.length < 8 || !source.includes(normalizeForMatch(evidence)) ||
            normalizeForMatch(oldText) === normalizeForMatch(newText) ||
            /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(newText)) continue;
        const start = existingContent.indexOf(oldText);
        if (start < 0 || existingContent.indexOf(oldText, start + 1) !== -1) continue;
        const end = start + oldText.length;
        if (occupied.some(([from, to]) => start < to && end > from)) continue;
        occupied.push([start, end]);
        replacements.push({ oldText, newText, evidence, selected: true });
    }
    const newFacts = [];
    const seen = new Set();
    for (const item of (raw.new_facts ?? []).slice(0, 50)) {
        const text = cleanProfileText(item?.fact, 2000);
        const evidence = cleanProfileText(item?.evidence, 2000);
        const normalized = normalizeForMatch(text);
        if (!text || !evidence || evidence.length < 8 || !source.includes(normalizeForMatch(evidence)) ||
            known.includes(normalized) || seen.has(normalized)) continue;
        seen.add(normalized);
        newFacts.push({ text, evidence, selected: true });
    }
    return { replacements, newFacts };
}

export function composeNpcUpdateContent(baseContent, suggestions, outputLanguage = 'english') {
    const base = String(baseContent ?? '');
    const selected = (suggestions?.replacements ?? []).filter((item) => item.selected);
    const spans = selected.map((item) => ({ ...item, start: base.indexOf(item.oldText) }));
    if (spans.some((item) => item.start < 0 || base.indexOf(item.oldText, item.start + 1) !== -1)) {
        throw new Error('기존 값이 바뀌었어요. 다시 갱신해 주세요.');
    }
    spans.sort((a, b) => b.start - a.start);
    let content = base;
    for (const item of spans) {
        content = `${content.slice(0, item.start)}${item.newText}${content.slice(item.start + item.oldText.length)}`;
    }
    const facts = (suggestions?.newFacts ?? []).filter((item) => item.selected).map((item) => item.text);
    if (facts.length) {
        const heading = outputLanguage === 'korean' ? '> 추가 정보' : '> ADDITIONAL FACTS';
        content += `\n\n${heading}\n${facts.map((fact) => `- ${fact}`).join('\n')}`;
    }
    return content;
}

export function buildLorebookContent(npc) {
    const lines = [`[NPC: ${npc.name}]`];
    if (npc.aliases?.length) lines.push(`별칭·호칭: ${npc.aliases.join(', ')}`);
    if (npc.appearance) lines.push(`외모: ${npc.appearance}`);
    if (npc.personality) lines.push(`성격: ${npc.personality}`);
    if (npc.speechStyle) lines.push(`말투: ${npc.speechStyle}`);
    if (npc.relationships) lines.push(`관계: ${npc.relationships}`);
    if (npc.facts?.length) {
        lines.push('알려진 사실:');
        npc.facts.forEach((fact) => lines.push(`- ${fact}`));
    }
    if (npc.exampleLines?.length) {
        lines.push('예시 대사:');
        npc.exampleLines.forEach((line) => lines.push(`- "${line}"`));
    }
    return lines.join('\n');
}

/**
 * Remove only the "(추정)" markers from generated content — the inferred
 * values themselves are kept exactly as written.
 */
export function removeInferenceMarkers(content) {
    return String(content ?? '')
        .replace(/\s*\(추정\)/g, '')
        .replace(/[ \t]+([,.;!?])/g, '$1')
        .replace(/[ \t]{2,}/g, ' ');
}

export function buildEntryKeys(npc, sourceNames = []) {
    // Activation must work in the original chat language even when the AI
    // renders the NPC's name in the lorebook's selected output language.
    return [...sourceNames, npc.name, ...(npc.aliases ?? [])]
        .map((value) => String(value ?? '').trim())
        .filter(Boolean)
        .filter((value, index, all) => all.indexOf(value) === index)
        .slice(0, 30);
}
