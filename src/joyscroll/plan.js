// How a Joyscroll Game video plays: every key, flip, answer and pause, with
// its time — a script the page (page.html) draws frame by frame. Pure
// functions, no I/O.
//
// The rule for every game: get close, never win.
//   Joyword   six guesses, each nearer the word; the sixth is one letter off
//             (four of five in place), and the game is lost. The word is never
//             shown.
//   Crossjoy  answers filled in clue by clue until about 80% of the grid is
//             done; the next answer goes in one letter wrong, Check marks it,
//             and that's the end. The missing answers are never shown.
//   Trivia    five questions: four right, the fifth wrong. The right answer to
//             the fifth is never shown.
//
// Times are built at a natural pace, then the whole game is stretched or
// squeezed (fit()) so the video, end card included, lands between 20 and 30
// seconds and the narration fits inside it.

const WORDS = require('./words');
const COMMON_WORDS = new Set(WORDS.COMMON);

const END_CARD = 3.4;          // seconds of orange end card
const MIN_TOTAL = 20.3;    // a hair over 20, so frame rounding never lands at 19.9
const MAX_TOTAL = 30;
const VOICE_START = 0.5;       // narration begins this far in
const VOICE_TAIL = 0.6;        // and must finish this long before the end

// A small seeded random, so the same puzzle always plays the same way.
function rng(seedText) {
  let h = 2166136261;
  for (const ch of String(seedText)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    return ((h >>> 0) % 100000) / 100000;
  };
}

// ── Joyword ──────────────────────────────────────────────────────────────────
let WORD_LIST = null;
function wordList() {
  if (!WORD_LIST) {
    WORD_LIST = [];
    for (let i = 0; i < WORDS.ALL.length; i += 5) WORD_LIST.push(WORDS.ALL.slice(i, i + 5));
  }
  return WORD_LIST;
}

// The app's own scoring (joyscroll/src/games/joyword.ts): exact letters first,
// then letters elsewhere, up to how many the answer holds.
function scoreGuess(guess, answer) {
  const out = Array(5).fill('absent');
  const left = {};
  for (let i = 0; i < 5; i++) {
    if (guess[i] === answer[i]) out[i] = 'correct';
    else left[answer[i]] = (left[answer[i]] || 0) + 1;
  }
  for (let i = 0; i < 5; i++) {
    if (out[i] === 'correct') continue;
    if (left[guess[i]] > 0) { out[i] = 'present'; left[guess[i]]--; }
  }
  return out;
}

// Ordinary-looking words: everyday letters, no repeats. The list is every
// word Joyword accepts, obscure ones included, and a guess like "aahed"
// would look like a robot playing.
const COMMON = 'etaoinshrdlcumwfgypb';
function plainness(w) {
  let s = 0;
  for (const ch of w) s += COMMON.includes(ch) ? 2 - COMMON.indexOf(ch) / COMMON.length : -3;
  if (new Set(w).size < 5) s -= 2.5;
  if (/[^aeiouy]{4}/.test(w)) s -= 3;
  return s;
}

// Six guesses: steadily closer, the last one letter off. Returns
// [{ word, scores }]. Never includes the answer.
function planJoyword(answerIn) {
  const answer = String(answerIn).toLowerCase();
  const rand = rng(answer);
  const all = wordList().filter(w => w !== answer);
  // Everyday words when they'll do; the whole list only when they won't.
  const everyday = all.filter(w => COMMON_WORDS.has(w));
  const greens = w => scoreGuess(w, answer).filter(s => s === 'correct').length;
  const yellows = w => scoreGuess(w, answer).filter(s => s === 'present').length;

  // The near miss first: a real word four letters in place.
  let last = everyday.filter(w => greens(w) === 4);
  if (!last.length) last = all.filter(w => greens(w) === 4);
  if (!last.length) last = everyday.filter(w => greens(w) === 3 && yellows(w) >= 1);
  if (!last.length) last = all.filter(w => greens(w) === 3);
  last.sort((a, b) => plainness(b) - plainness(a));
  const finalWord = last[Math.floor(rand() * Math.min(3, last.length))] || everyday[0];
  const list = everyday.length > 40 ? everyday : all;

  // Then five on the way there: roughly 0,1,2,2,3 letters in place, keeping
  // what's been found and avoiding letters already ruled out, like a person.
  const targets = [0, 1, 2, 2, Math.min(3, greens(finalWord))];
  const guesses = [];
  const known = Array(5).fill(null);
  const absent = new Set();
  for (const target of targets) {
    let best = null, bestScore = -Infinity;
    for (const w of list) {
      if (w === finalWord || guesses.includes(w)) continue;
      const g = greens(w);
      let score = -Math.abs(g - target) * 6 + yellows(w) * 0.8 + plainness(w) * 0.6;
      for (let i = 0; i < 5; i++) if (known[i] && w[i] === known[i]) score += 1.5;
      for (const ch of w) if (absent.has(ch)) score -= 2;
      score += rand() * 1.2;
      if (score > bestScore) { bestScore = score; best = w; }
    }
    guesses.push(best);
    scoreGuess(best, answer).forEach((s, i) => {
      if (s === 'correct') known[i] = best[i];
      if (s === 'absent' && !answer.includes(best[i])) absent.add(best[i]);
    });
  }
  guesses.push(finalWord);
  return guesses.map(word => ({ word, scores: scoreGuess(word, answer) }));
}

function joywordEvents(game) {
  const guesses = planJoyword(game.word);
  const ev = [];
  let t = 0.9;
  const KEY = 0.17, BEFORE_ENTER = 0.22, FLIP = 0.32, STAGGER = 0.13, AFTER = 0.4;
  guesses.forEach((g, row) => {
    for (const ch of g.word) { ev.push({ t, k: 'key', ch }); t += KEY; }
    t += BEFORE_ENTER;
    ev.push({ t, k: 'enter' });
    ev.push({ t, k: 'submit', row, word: g.word, scores: g.scores });
    t += FLIP + STAGGER * 4 + AFTER;
  });
  ev.push({ t, k: 'shake', row: 5 });
  t += 0.6;
  ev.push({ t, k: 'result' });
  t += 2.6;
  return { events: ev, duration: t, guesses };
}

// ── Crossjoy ─────────────────────────────────────────────────────────────────
// The entries, numbered and ordered exactly as the app does (crossjoy.ts).
function crossEntries(grid, clues) {
  const white = (r, c) => r >= 0 && c >= 0 && r < grid.length && c < grid[r].length && grid[r][c] !== '#';
  const nums = new Map();
  let n = 0;
  for (let r = 0; r < grid.length; r++) for (let c = 0; c < grid[r].length; c++) {
    if (!white(r, c)) continue;
    if ((!white(r, c - 1) && white(r, c + 1)) || (!white(r - 1, c) && white(r + 1, c))) nums.set(`${r},${c}`, ++n);
  }
  const clueAt = new Map((clues || []).map(k => [`${k.dir},${k.row},${k.col}`, k]));
  const out = [];
  for (const dir of ['across', 'down']) {
    const [dr, dc] = dir === 'across' ? [0, 1] : [1, 0];
    for (let r = 0; r < grid.length; r++) for (let c = 0; c < grid[r].length; c++) {
      if (!white(r, c) || white(r - dr, c - dc) || !white(r + dr, c + dc)) continue;
      const cells = [];
      for (let rr = r, cc = c; white(rr, cc); rr += dr, cc += dc) cells.push([rr, cc]);
      const k = clueAt.get(`${dir},${r},${c}`);
      out.push({ num: nums.get(`${r},${c}`), dir, row: r, col: c, cells,
                 answer: cells.map(([a, b]) => grid[a][b]).join(''), clue: (k && k.clue) || '' });
    }
  }
  return out.sort((a, b) => (a.dir === b.dir ? a.num - b.num : a.dir === 'across' ? -1 : 1));
}

function crossjoyEvents(game) {
  const grid = (game.grid || []).map(r => String(r).toLowerCase());
  const entries = crossEntries(grid, game.clues);
  if (!entries.length) throw new Error('This crossword has no entries');
  const rand = rng(grid.join(''));
  const whiteCount = grid.join('').replace(/#/g, '').length;
  const filled = new Set();
  const ev = [];
  let t = 0.9;
  const KEY = 0.2, MOVE = 0.45, LOCK = 0.55;

  const empties = e => e.cells.filter(([r, c]) => !filled.has(`${r},${c}`));
  const typeInto = (index, letters) => {
    const e = entries[index];
    ev.push({ t, k: 'select', entry: index });
    t += MOVE;
    for (const { r, c, ch } of letters) {
      ev.push({ t, k: 'key', ch });
      ev.push({ t, k: 'type', r, c, ch });
      t += KEY;
    }
    return e;
  };

  // Right answers in clue order until about 80% of the grid is in, always
  // leaving at least one answer with a gap to get wrong.
  let failIndex = -1;
  for (let i = 0; i < entries.length; i++) {
    const gaps = empties(entries[i]);
    if (!gaps.length) continue;
    const after = filled.size + gaps.length;
    const leftAfter = entries.some((e, j) => j !== i && e.cells.some(([r, c]) => !filled.has(`${r},${c}`) && !gaps.some(([a, b]) => a === r && b === c)));
    if ((filled.size / whiteCount >= 0.75 || after / whiteCount > 0.9 || !leftAfter) && filled.size > 0) { failIndex = i; break; }
    typeInto(i, gaps.map(([r, c]) => ({ r, c, ch: grid[r][c] })));
    gaps.forEach(([r, c]) => filled.add(`${r},${c}`));
    ev.push({ t, k: 'lock', entry: i });
    t += LOCK;
  }
  if (failIndex === -1) failIndex = entries.findIndex(e => empties(e).length);
  if (failIndex === -1) throw new Error('This crossword is too small to play out');

  // The near miss: the next answer, right but for one letter.
  const gaps = empties(entries[failIndex]);
  const wrongAt = gaps.length > 1 ? 1 + Math.floor(rand() * (gaps.length - 1)) : 0;
  const swap = ch => { const pool = 'eatoinsrl'.replace(ch, ''); return pool[Math.floor(rand() * pool.length)]; };
  const letters = gaps.map(([r, c], i) => ({ r, c, ch: i === wrongAt ? swap(grid[r][c]) : grid[r][c] }));
  typeInto(failIndex, letters);
  t += 0.45;
  ev.push({ t, k: 'check', wrong: [[letters[wrongAt].r, letters[wrongAt].c]] });
  t += 1.0;
  ev.push({ t, k: 'result' });
  t += 2.6;
  return { events: ev, duration: t, entries, failIndex, filledShare: (filled.size + gaps.length) / whiteCount };
}

// ── Trivia ───────────────────────────────────────────────────────────────────
function triviaEvents(game) {
  const qs = (game.questions || []).slice(0, 5);
  if (qs.length < 5) throw new Error('A trivia video needs five questions');
  const ev = [];
  let t = 0.6;
  const SHOW = 1.9, TAP = 0.35, HOLD = 1.25, OUT = 0.35;
  qs.forEach((q, i) => {
    const right = i < 4;
    const opts = q.options || [];
    // The fifth: a wrong option, not the first one listed (that looks like a
    // careless tap), when there is a choice.
    let pick = q.answer_index;
    if (!right) {
      const wrong = opts.map((_, j) => j).filter(j => j !== q.answer_index);
      pick = wrong.length > 1 ? wrong[1] : wrong[0];
    }
    ev.push({ t, k: 'question', i });
    t += SHOW;
    ev.push({ t, k: 'tap', i, opt: pick });
    t += TAP;
    ev.push({ t, k: 'reveal', i, opt: pick, right });
    t += HOLD + (right ? 0 : 0.6);
    if (i < 4) { ev.push({ t, k: 'next', i }); t += OUT; }
  });
  ev.push({ t, k: 'result' });
  t += 2.4;
  return { events: ev, duration: t };
}

// ── Fitting it all into 20–30 seconds ────────────────────────────────────────
function gameEvents(game) {
  if (game.type === 'joyword') return joywordEvents(game);
  if (game.type === 'crossjoy') return crossjoyEvents(game);
  if (game.type === 'trivia') return triviaEvents(game);
  throw new Error(`Unknown game type: ${game.type}`);
}

// The video's length and the factor the game's clock is scaled by, so that
// game + end card fills it and the narration (voiceSeconds, from VOICE_START)
// ends at least VOICE_TAIL before the end.
function fit(gameSeconds, voiceSeconds = 0) {
  const needed = Math.max(gameSeconds + END_CARD, voiceSeconds ? VOICE_START + voiceSeconds + VOICE_TAIL : 0);
  if (needed > MAX_TOTAL + 0.01 && voiceSeconds && VOICE_START + voiceSeconds + VOICE_TAIL > MAX_TOTAL) {
    throw new Error(`The narration runs ${voiceSeconds.toFixed(1)}s — too long for a ${MAX_TOTAL}-second video. Shorten it in Studio and retry.`);
  }
  const total = Math.min(MAX_TOTAL, Math.max(MIN_TOTAL, needed));
  const scale = (total - END_CARD) / gameSeconds;
  return { total, scale, gameEnd: total - END_CARD };
}

// The full script for the page: the game's events on the fitted clock, the
// end card, and the captions.
function buildScript(game, { voiceSeconds = 0, captions = [] } = {}) {
  const g = gameEvents(game);
  const { total, scale, gameEnd } = fit(g.duration, voiceSeconds);
  const events = g.events.map(e => ({ ...e, t: +(e.t * scale).toFixed(3) }));
  events.push({ t: gameEnd, k: 'end' });
  return {
    type: game.type,
    game,
    events,
    // How long one second of the game's own animations lasts on this clock,
    // so a flip or a hop keeps its proportions when the game is stretched.
    pace: scale,
    total,
    endAt: gameEnd,
    captions,
    extra: g.entries ? { entries: g.entries, failIndex: g.failIndex } : g.guesses ? { guesses: g.guesses } : {},
  };
}

// The sound effects, from the events: [{ t, sfx, volume }].
function sfxCues(script) {
  const out = [];
  for (const e of script.events) {
    if (e.k === 'key') out.push({ t: e.t, sfx: 'key', volume: 0.5 });
    else if (e.k === 'submit') out.push({ t: e.t + 0.05, sfx: 'pop', volume: 0.45 });
    else if (e.k === 'lock') out.push({ t: e.t, sfx: 'ching', volume: 0.55 });
    else if (e.k === 'tap') out.push({ t: e.t, sfx: 'tap', volume: 0.6 });
    else if (e.k === 'reveal') out.push({ t: e.t, sfx: e.right ? 'ching' : 'miss', volume: 0.6 });
    else if (e.k === 'shake' || e.k === 'check') out.push({ t: e.t, sfx: 'miss', volume: 0.65 });
    else if (e.k === 'end') out.push({ t: e.t + 0.35, sfx: 'pop', volume: 0.55 });
  }
  return out;
}

module.exports = {
  buildScript, sfxCues, fit, planJoyword, crossEntries, scoreGuess, gameEvents,
  END_CARD, MIN_TOTAL, MAX_TOTAL, VOICE_START, VOICE_TAIL,
};
