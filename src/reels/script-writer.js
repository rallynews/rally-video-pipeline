const { chatCompletion, parseJSON } = require('../openrouter');

// Step 1 of the reel flow. Mistral takes the carousel copy that has already
// been researched and fact-checked and re-tells the SAME story arc as a 20–30
// second spoken script — intro hook → challenge → solution → result → why it
// matters → the engagement question.
//
// The script comes back already broken into `lines`: natural spoken sentences.
// Lines are the unit everything downstream is timed against — each is voiced
// on its own, so its real duration (not an estimate) drives the cuts, and the
// line's text doubles as its on-screen caption (built in the timeline, not
// here).

// ~2.6 words/second of relaxed conversational delivery.
const TARGET_WORDS = { min: 55, max: 78 };

function words(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

// Split a too-long line on sentence boundaries so no single voice clip runs
// long enough to sit on one image forever.
function splitLongLines(lines) {
  const out = [];
  for (const line of lines) {
    if (words(line.text) <= 16) {
      out.push(line);
      continue;
    }
    // Prefer a clause boundary; if the model wrote one long unpunctuated run,
    // break it at the midpoint word rather than leaving a 7-second voice clip
    // sitting on one or two images.
    let parts = String(line.text).split(/(?<=[.!?,;—])\s+/).filter(p => p.trim());
    if (parts.length < 2) parts = String(line.text).trim().split(/\s+/);

    // Rebalance into halves rather than fragments.
    const mid = Math.ceil(parts.length / 2);
    out.push({ text: parts.slice(0, mid).join(' ').trim() });
    out.push({ text: parts.slice(mid).join(' ').trim() });
  }
  return out;
}

// The opening headline: short, unquoted, one line.
function normalizeHook(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'\u201c\u201d\u2018\u2019]+|["'\u201c\u201d\u2018\u2019]+$/g, '')
    .slice(0, 60);
}

function normalizeLines(rawLines, fallbackScript) {
  let lines = (Array.isArray(rawLines) ? rawLines : [])
    .map(l => (typeof l === 'string' ? { text: l } : l))
    .map(l => ({ text: String((l && l.text) || '').replace(/\s+/g, ' ').trim() }))
    .filter(l => l.text);

  if (!lines.length) {
    lines = String(fallbackScript || '')
      .split(/(?<=[.!?])\s+/)
      .map(t => t.trim())
      .filter(Boolean)
      .map(text => ({ text }));
  }

  return splitLongLines(lines);
}

async function writeReelScript(story, slideCopy, raw) {
  const content = await chatCompletion({
    max_tokens: 1200,
    messages: [
      {
        role: 'system',
        content: `You write the spoken script for Rally News short-form vertical video (Instagram Reels / YouTube Shorts / TikTok).

You are given the copy from today's Rally News carousel — it has ALREADY been researched and fact-checked. Your job is to re-tell that EXACT SAME story arc as a script someone reads out loud over b-roll.

HARD RULES:
- Use ONLY the facts in the carousel copy. Do not add a single new name, number, date or claim. If it isn't in the copy, it doesn't go in the script.
- Cover the same arc, in this order: the hook, the challenge, the turn/solution, the result, why it matters, and close on the engagement question.
- ${TARGET_WORDS.min}–${TARGET_WORDS.max} words TOTAL. That is 20–30 seconds of relaxed speech. Count them.

VOICE — this is read by a young woman, casually, to camera:
- Chill, colloquial, friendly. Like telling a mate something cool you just read.
- Contractions everywhere. Short sentences. Everyday words, not press-release words.
- Warm, not breathless. No "OMG", no "you guys", no "let that sink in", no hashtags, no emoji, no "link in bio".
- Never say "Rally News" and never narrate the carousel itself.
- Write it to be SPOKEN: no brackets, no stage directions, no numbers written as digits when a word reads better (say "twelve thousand", not "12,000").

LINES:
Break the script into 7–11 lines. Each line is ONE natural spoken sentence or clause — something a person says in one breath, roughly 6–14 words. These get voiced individually, so a line must stand on its own without sounding clipped. From the second line on, each line is also shown on screen as a caption while it is spoken, so no line may rely on the previous one to parse.

HOOK:
Also write a "hook": the on-screen headline over the OPENING shot (the article's own photo), shown while the first line is spoken. 3–7 words, punchy and curiosity-driven — the thing that stops the scroll. It is NOT spoken and must NOT be a transcript of the first line; it teases the payoff. E.g. "A River Came Back", "Chemo Couldn't Stop Him", "Solar Just Beat Oil".

Return VALID JSON only, no markdown:
{"script": "the full script as one string", "hook": "On-Screen Opening Headline", "lines": [{"text": "spoken line"}], "mood": "one word for the music mood: uplifting, hopeful, warm, gentle, triumphant, curious, or calm"}`,
      },
      {
        role: 'user',
        content: `Today's fact-checked carousel copy:

Content pillar: ${slideCopy.pillar}
Cover headline: ${slideCopy.headline}
The challenge: ${slideCopy.challenge}
The solution: ${slideCopy.solution}
The result: ${slideCopy.resultHeading}
Result detail: ${slideCopy.resultLine}
Why it matters: ${raw.whyMatters || slideCopy.whyMatters}
Engagement question (the script must END on this idea, in your own casual words): ${raw.engagementQuestion || ''}

Original story headline: "${story.headline}"
Publisher: ${story.publisher}

Write the ${TARGET_WORDS.min}–${TARGET_WORDS.max} word spoken script and return the JSON described above.`,
      },
    ],
  });

  const parsed = parseJSON(content);
  const lines = normalizeLines(parsed.lines, parsed.script);
  const script = String(parsed.script || lines.map(l => l.text).join(' ')).trim();

  return {
    script,
    hook: normalizeHook(parsed.hook),
    lines,
    mood: String(parsed.mood || 'uplifting').toLowerCase().replace(/[^a-z]/g, '') || 'uplifting',
    wordCount: words(script),
  };
}

module.exports = { writeReelScript, normalizeLines, normalizeHook, TARGET_WORDS };
