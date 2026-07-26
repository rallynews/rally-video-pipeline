const { chatCompletion, parseJSON } = require('../openrouter');

// Step 1 of the reel flow. Mistral takes the carousel copy that has already
// been researched and fact-checked and re-tells the SAME story arc as a 20–30
// second spoken script — intro hook → challenge → solution → result → why it
// matters → the engagement question.
//
// The script comes back already broken into `lines`: natural spoken sentences,
// each with the short on-screen headline that goes with it. Lines are the unit
// everything downstream is timed against — each is voiced on its own, so its
// real duration (not an estimate) drives the cuts and the captions.

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
    out.push({ text: parts.slice(0, mid).join(' ').trim(), caption: line.caption });
    out.push({ text: parts.slice(mid).join(' ').trim(), caption: '' });
  }
  return out;
}

function normalizeLines(rawLines, fallbackScript) {
  let lines = (Array.isArray(rawLines) ? rawLines : [])
    .map(l => (typeof l === 'string' ? { text: l, caption: '' } : l))
    .map(l => ({
      text: String((l && l.text) || '').replace(/\s+/g, ' ').trim(),
      // On-screen headline. Kept short — it is set in Lora over the footage.
      caption: String((l && l.caption) || '').replace(/\s+/g, ' ').trim().slice(0, 42),
    }))
    .filter(l => l.text);

  if (!lines.length) {
    lines = String(fallbackScript || '')
      .split(/(?<=[.!?])\s+/)
      .map(t => t.trim())
      .filter(Boolean)
      .map(text => ({ text, caption: '' }));
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
Break the script into 7–11 lines. Each line is ONE natural spoken sentence or clause — something a person says in one breath, roughly 6–14 words. These get voiced individually, so a line must stand on its own without sounding clipped.

CAPTIONS:
Every line gets a "caption": the on-screen headline shown while that line is spoken. 2–5 words, title-case-ish, plain text. It should pull the punchiest idea out of the line — NOT a transcript of it. Some lines are better with no caption at all; return "" for those. Roughly two thirds of lines should have one.

Return VALID JSON only, no markdown:
{"script": "the full script as one string", "lines": [{"text": "spoken line", "caption": "On-Screen Words"}], "mood": "one word for the music mood: uplifting, hopeful, warm, gentle, triumphant, curious, or calm"}`,
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
    lines,
    mood: String(parsed.mood || 'uplifting').toLowerCase().replace(/[^a-z]/g, '') || 'uplifting',
    wordCount: words(script),
  };
}

module.exports = { writeReelScript, normalizeLines, TARGET_WORDS };
