const { chatCompletion, parseJSON } = require('../openrouter');

// Proofread pass over an approved draft.
//
// Runs at produce time, after the editor has approved WITH EDITS, and only
// then: it exists to catch typos introduced by hand, not to second-guess copy
// nobody touched. It corrects spelling, grammar and punctuation and nothing
// else — voice, facts, structure, informality and length are all off limits.
//
// A model told "only fix the grammar" will occasionally rewrite anyway, so the
// instruction is not trusted on its own. Every correction is diffed against the
// original at word level and REJECTED if it changed more than a proofread
// plausibly would, which turns a silent rewrite into a logged no-op.

// Fields that carry copy the editor can type into.
const COPY_FIELDS = [
  'headline', 'challenge', 'solution', 'resultHeading', 'resultLine',
  'whyMatters', 'engagementQuestion', 'captionLead',
];

// How far a correction may drift before it stops being a proofread. Three word
// operations are always allowed, so a short line can take a couple of genuine
// fixes; above that it scales with length.
const MAX_DRIFT_RATIO = 0.2;
const MIN_DRIFT_ALLOWED = 3;

// Contractions are expanded on BOTH sides before comparing. Fixing "its" to
// "it's" is one edit to a reader but two to a diff (substitute + insert), and
// that arithmetic was rejecting real corrections on short lines. Normalising
// makes the two forms identical, so only the genuine changes count.
const CONTRACTIONS = [
  [/\b(it|that|there|here|what|who|he|she|let)'?s\b/g, '$1 is'],
  [/\b(i|you|we|they)'?re\b/g, '$1 are'],
  [/\b(i|you|we|they|he|she|it)'?ve\b/g, '$1 have'],
  [/\b(i|you|we|they|he|she|it)'?ll\b/g, '$1 will'],
  [/\b(i|you|we|they|he|she|it)'?d\b/g, '$1 would'],
  [/\b(do|does|did|is|are|was|were|has|have|had|would|could|should|ca|wo)n'?t\b/g, '$1 not'],
  [/\bcan not\b/g, 'ca not'],
  [/\bi'?m\b/g, 'i am'],
];

function wordsOf(text) {
  let normalized = String(text || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'");
  for (const [pattern, replacement] of CONTRACTIONS) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// Word-level edit distance. Spelling fixes are substitutions (1 each), a added
// or dropped article is 1; a rewrite runs into double digits fast.
function wordDistance(a, b) {
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

// Is `after` a plausible proofread of `before`, or a rewrite wearing its name?
function isProofread(before, after) {
  const a = wordsOf(before);
  const b = wordsOf(after);
  if (!a.length || !b.length) return false;

  const allowed = Math.max(MIN_DRIFT_ALLOWED, Math.ceil(a.length * MAX_DRIFT_RATIO));
  if (Math.abs(a.length - b.length) > allowed) return false;
  return wordDistance(a, b) <= allowed;
}

// Everything the editor could have typed into, flattened to { id: text } so it
// goes to the model — and comes back — as one addressable object.
function collectFields(draft) {
  const fields = {};
  for (const key of COPY_FIELDS) {
    const value = String((draft.raw && draft.raw[key]) || '').trim();
    if (value) fields[`raw.${key}`] = value;
  }
  if (draft.reel) {
    const hook = String(draft.reel.hook || '').trim();
    if (hook) fields['reel.hook'] = hook;
    (draft.reel.lines || []).forEach((line, i) => {
      const text = String((line && line.text) || '').trim();
      if (text) fields[`reel.line.${i}`] = text;
    });
  }
  return fields;
}

function applyField(draft, id, value) {
  if (id.startsWith('raw.')) {
    draft.raw[id.slice(4)] = value;
    return;
  }
  if (id === 'reel.hook') {
    draft.reel.hook = value;
    return;
  }
  const lineMatch = /^reel\.line\.(\d+)$/.exec(id);
  if (lineMatch && draft.reel && draft.reel.lines[+lineMatch[1]]) {
    draft.reel.lines[+lineMatch[1]].text = value;
  }
}

// Proofread the draft IN PLACE. Returns a report of what changed and what was
// rejected; never throws, because a failed proofread must not block a run that
// the editor has already approved.
async function proofread(draft) {
  const fields = collectFields(draft);
  const ids = Object.keys(fields);
  if (!ids.length) return { ran: false, changes: [], rejected: [] };

  let corrected;
  try {
    const content = await chatCompletion({
      max_tokens: 2000,
      messages: [
        {
          role: 'system',
          content: `You are a copy proofreader. You are given social-media copy that a human editor has just finished editing by hand, as a JSON object of {id: text}.

Correct ONLY these, and nothing else:
- misspellings and typos
- grammatical errors (subject–verb agreement, tense, plurals, pronouns, malformed sentences)
- punctuation and capitalisation errors
- doubled words ("the the"), missing or doubled spaces

You MUST NOT:
- rewrite, reword, improve, shorten, lengthen, or restructure anything
- change the tone, register or voice — this copy is deliberately casual and colloquial, and informality is NOT an error
- "correct" sentence fragments, one-word sentences, or sentences starting with And/But/So — those are intentional style
- change any fact, name, number, date, quotation or claim
- add or remove hashtags, emoji, links or line breaks
- change British spellings to American ones, or the reverse — keep whichever the text already uses
- touch a field that has no error

If a field is already correct, return it BYTE-FOR-BYTE unchanged. Most fields will need no change at all; returning them identical is the expected outcome.

Return VALID JSON only, no markdown: the same object with the same keys, each mapped to its corrected (or unchanged) text.`,
        },
        {
          role: 'user',
          content: `Proofread this copy. Return the same JSON keys with corrected text.\n\n${JSON.stringify(fields, null, 2)}`,
        },
      ],
    });
    corrected = parseJSON(content);
  } catch (err) {
    console.warn(`  [proofread] pass failed (${err.message}) — approved copy used as written.`);
    return { ran: false, changes: [], rejected: [], error: err.message };
  }

  const changes = [];
  const rejected = [];

  for (const id of ids) {
    const before = fields[id];
    const after = String(corrected[id] == null ? '' : corrected[id]).trim();
    if (!after || after === before) continue;

    if (!isProofread(before, after)) {
      // A rewrite, not a proofread. Keep what the editor approved.
      rejected.push({ field: id, before, after });
      continue;
    }
    applyField(draft, id, after);
    changes.push({ field: id, before, after });
  }

  for (const r of rejected) {
    console.warn(`  [proofread] rejected a rewrite of ${r.field} — kept the approved text`);
  }
  for (const c of changes) {
    console.log(`  [proofread] ${c.field}: "${c.before}" → "${c.after}"`);
  }
  if (!changes.length && !rejected.length) {
    console.log('  [proofread] no spelling or grammar errors found.');
  }

  return { ran: true, changes, rejected };
}

module.exports = { proofread, isProofread, collectFields, COPY_FIELDS };
