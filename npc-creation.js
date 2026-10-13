/** Creative generation is intentionally separate from evidence-based scouting. */
export function buildNpcCreationPrompt({ name = '', concept, format, customFormat = '', referenceSheet = '', language = 'english' }) {
    const korean = language === 'korean';
    const labels = korean
        ? ['외형', '성격·행동', '말투', '관계', '기억할 설정']
        : ['Appearance', 'Personality & behavior', 'Speech', 'Relationships', 'Continuity'];
    const sections = korean
        ? ['OVERVIEW', '신상·외형', '배경', '관계', '성격·심리', '습관·행동', '말투', '목표·현재 상황', '능력·자원']
        : ['OVERVIEW', 'IDENTITY & APPEARANCE', 'BACKSTORY', 'CONNECTIONS', 'PERSONALITY & PSYCHOLOGY', 'HABITS & BEHAVIOR', 'SPEECH', 'GOALS & CURRENT SITUATION', 'CAPABILITIES & ASSETS'];
    const formatRule = format === 'custom'
        ? `Follow the user's sheet format below: section names, order, markup and level of detail. Examples supply structure only, never character facts.\n${customFormat}`
        : format === 'sheet' && referenceSheet.trim()
            ? `Imitate only the inner section names, order, markup and level of detail of the reference sheet. Keep its labels in their original language. Never copy its character's identity, traits, relationships or events. Omit outer <{{char}}> and </{{char}}> tags and do not invent a replacement wrapper.`
            : format === 'compact'
                ? `Use [NPC: name] followed by these five labeled lines in order: ${labels.join('; ')}. Aim for 100–180 English-equivalent tokens, focusing on recognizable traits and portrayal.`
                : `Use [NPC: name] followed by these sections in order, each prefixed by >: ${sections.join('; ')}. Aim for 300–500 English-equivalent tokens. Include identity, appearance, background, motives, habits, speech, goals and useful abilities.`;
    return [
        { role: 'system', content: `Create ONE new fictional supporting character from the user's concept, not an extracted profile of someone who already appeared in the RP. Return exactly one JSON object without fences or commentary.\nSchema: {"name":"","aliases":[],"sheet":"","example_lines":[]}\n${name ? `The name must be exactly ${JSON.stringify(name)}. Do not rename or translate it.` : 'Choose a suitable specific name unless the concept already gives one; preserve any name supplied in the concept.'}\nPreserve every explicit user constraint, including negative constraints, identity and relationship limits. Expand unspecified appearance, personality, speech, background, goals and habits coherently. These additions are proposed character settings; no (추정) markers are needed. Do not change another character or invent shared past events, intimate relationships, promises, hidden knowledge or events in the current RP unless explicitly supplied by the user. No chat excerpts are provided; never claim a detail was observed in chat or that this NPC already appeared. Do not manufacture ties to the main characters when none were requested. Any example dialogue inside the sheet is an original speech sample, never a quote from past RP. Keep example_lines empty.\nWrite field values in ${korean ? 'Korean' : 'English'}, preserving explicit names and format labels.\n${formatRule}` },
        { role: 'user', content: `User's NPC concept:\n${concept}${format === 'sheet' && referenceSheet.trim() ? `\n\nReference sheet (FORMAT ONLY, a different character):\n${referenceSheet}` : ''}` },
    ];
}
