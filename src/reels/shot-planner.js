const { chatCompletion, parseJSON } = require('../openrouter');
const { pickImage } = require('./r2-catalogue');
const { bankPrompt, filterToBank } = require('./keywords');

// Step 2 of the reel flow. Mistral reads the script back and decides where the
// picture cuts — every second or two — then names the keywords for the image
// each cut lands on. Only keywords that exist in the R2 library are offered, so
// every shot resolves to a real file.
//
// The plan is expressed per line (a line = one voiced sentence), because line
// timings are the only timings we will actually know. How long each shot is on
// screen falls out of the recorded voice in the timeline builder.

const MOTIONS = ['push-in', 'pull-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down'];
const TRANSITIONS = ['cut', 'whip-left', 'whip-right', 'dissolve', 'flash', 'zoom-punch'];

const SHOT_BOUNDS = { min: 15, max: 25 };

function clampMotion(value, i) {
  const v = String(value || '').toLowerCase().trim();
  if (MOTIONS.includes(v)) return v;
  // Alternate push/pull so a fallback plan still breathes.
  return MOTIONS[i % MOTIONS.length];
}

function clampTransition(value, i) {
  const v = String(value || '').toLowerCase().trim();
  if (TRANSITIONS.includes(v)) return v;
  return i % 4 === 0 ? 'whip-left' : 'cut';
}

// Force the plan into the 15–25 shot window the brief asks for, weighting each
// line by how much of the script it carries so long lines get the extra cuts.
function rebalanceShotCounts(counts, lines) {
  const weights = lines.map(l => Math.max(1, l.text.split(/\s+/).length));
  let total = counts.reduce((a, b) => a + b, 0);

  const order = weights
    .map((w, i) => ({ i, w }))
    .sort((a, b) => b.w - a.w)
    .map(x => x.i);

  let guard = 0;
  while (total < SHOT_BOUNDS.min && guard++ < 200) {
    for (const i of order) {
      if (total >= SHOT_BOUNDS.min) break;
      if (counts[i] < 3) { counts[i]++; total++; }
    }
    if (order.every(i => counts[i] >= 3)) break;
  }

  guard = 0;
  const reverse = [...order].reverse();
  while (total > SHOT_BOUNDS.max && guard++ < 200) {
    for (const i of reverse) {
      if (total <= SHOT_BOUNDS.max) break;
      if (counts[i] > 1) { counts[i]--; total--; }
    }
    if (reverse.every(i => counts[i] <= 1)) break;
  }

  return counts;
}

// Turn the model's per-line plan into a flat, validated shot list with a real
// R2 object key on every shot.
function resolveShots(plan, lines, catalogue, storyKeywords) {
  const byLine = new Map();
  for (const entry of Array.isArray(plan) ? plan : []) {
    const idx = Number(entry && entry.index);
    if (Number.isInteger(idx) && idx >= 0 && idx < lines.length) {
      byLine.set(idx, Array.isArray(entry.shots) ? entry.shots : []);
    }
  }

  const counts = lines.map((_, i) => {
    const raw = (byLine.get(i) || []).length;
    return Math.min(3, Math.max(1, raw || 2));
  });
  rebalanceShotCounts(counts, lines);

  const used = new Set();
  let previous = null;
  const shots = [];

  for (let i = 0; i < lines.length; i++) {
    const planned = byLine.get(i) || [];
    for (let s = 0; s < counts[i]; s++) {
      const spec = planned[s] || planned[planned.length - 1] || {};
      // Anything off the bank is dropped here rather than at match time, so a
      // shot always carries keywords the library could actually answer. With
      // nothing left, fall back to the story's own keywords.
      const asked = filterToBank(spec.keywords);
      const keywords = asked.length ? asked : storyKeywords;

      const key = pickImage(catalogue, keywords, used, previous);
      if (!key) throw new Error('R2 image library is empty — nothing to cut to');
      used.add(key);
      previous = key;

      shots.push({
        line: i,
        key,
        keywords,
        motion: clampMotion(spec.motion, shots.length),
        // The very first shot has nothing to transition from.
        transition: shots.length === 0 ? 'cut' : clampTransition(spec.transition, shots.length),
      });
    }
  }

  return shots;
}

async function planShots(story, slideCopy, script, lines, catalogue, storyKeywords) {
  // Words the library can answer today. Keywords with no image behind them are
  // still legal — they fall through to the generic pool — but the planner is
  // pointed at the stocked ones first so most cuts land on a real subject.
  const stocked = [...catalogue.stocked].sort();

  let plan = [];
  try {
    const content = await chatCompletion({
      max_tokens: 1800,
      messages: [
        {
          role: 'system',
          content: `You are the editor cutting a 9:16 short-form video for Rally News. You are given a spoken script already broken into numbered lines, and the keyword library of b-roll stills available to you.

Your job: decide where the picture CUTS, and what it cuts TO.

PACING — this is the whole point:
- The picture changes every 1–2 seconds. It should never sit still on one image for long.
- Each line of script is roughly 2–4 seconds of speech. Give a short line 1 shot, a normal line 2 shots, a long or high-energy line 3 shots.
- Aim for ${SHOT_BOUNDS.min}–${SHOT_BOUNDS.max} shots across the whole video.

KEYWORDS — the only thing that picks the image:
- For each shot give 2–4 keywords describing what should be on screen at that exact moment.
- You MUST choose from the keyword bank below. Any word outside it is discarded and the shot falls back to a generic filler image, so an off-bank word is a wasted shot.

KEYWORD BANK:
${bankPrompt()}

- These bank keywords have images in the library RIGHT NOW — prefer them wherever they fit: ${stocked.length ? stocked.join(', ') : '(library is empty)'}
- Match the picture to what is being SAID at that moment, not to the story in general. If the line is about a river, ask for river. If the line names a result, ask for something that reads as success or scale.
- Do not repeat keywords on two shots in a row.

MOTION — every shot moves, never a still frame. One of: ${MOTIONS.join(', ')}.
- push-in / pull-out for emotional or reflective lines.
- pan-left / pan-right for momentum and lists.
- pan-up for scale and reveals, pan-down for grounding.
- Vary it. Do not use push-in on every shot.

TRANSITION — how the picture gets to this shot. One of: ${TRANSITIONS.join(', ')}.
- cut: the default, use it for most shots.
- whip-left / whip-right: fast, energetic — use on a beat change or when the story turns.
- dissolve: soft, use for reflective or emotional moments.
- flash: a bright hit — use sparingly, at most once, on the biggest result.
- zoom-punch: use at most once, on the hook or the payoff.
- The majority of transitions must be plain cuts. At most 6 non-cut transitions in the whole video.

Return VALID JSON only, no markdown, one entry per script line:
{"lines":[{"index":0,"shots":[{"keywords":["kw","kw"],"motion":"push-in","transition":"cut"}]}]}`,
        },
        {
          role: 'user',
          content: `Story: "${story.headline}" (${slideCopy.pillar})

Full script:
${script}

Numbered lines to cut against:
${lines.map((l, i) => `${i}. ${l.text}${l.caption ? `   [on-screen: ${l.caption}]` : ''}`).join('\n')}

Plan the cuts and return the JSON described above.`,
        },
      ],
    });

    const parsed = parseJSON(content);
    plan = parsed.lines || parsed.shots || [];
  } catch (err) {
    // A missing plan is recoverable — resolveShots falls back to two
    // story-keyword shots per line, which still cuts on the beat.
    console.warn(`  [reel] shot planning call failed (${err.message}) — using default pacing.`);
  }

  const shots = resolveShots(plan, lines, catalogue, storyKeywords);
  console.log(`  [reel] planned ${shots.length} shots across ${lines.length} lines`);
  return shots;
}

module.exports = { planShots, resolveShots, MOTIONS, TRANSITIONS, SHOT_BOUNDS };
