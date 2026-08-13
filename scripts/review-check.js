#!/usr/bin/env node
// Asserts the contract between the review app and the reel builder, against a
// stubbed image library — no credentials, no network, no ffmpeg:
//
//   node scripts/review-check.js
//
// Two promises are being checked, and they're the ones that make the review
// page worth having:
//
//   (a) every image that reaches the finished reel was on the review page
//   (b) an image chosen in review is the image that plays — always
//
// Both used to be false. The picker only listed one file per keyword and never
// listed the generic pool, so a shot that fell back to a generic still couldn't
// even be named; the builder then re-resolved every approved shot through the
// substitution ladder, which skips any photo another shot already spent; and
// the timeline's densify pass pulled extra images out of the library after
// approval. A pick could survive all three and still not play.

const assert = require('assert');
const path = require('path');

const { resolveDraftShots } = require('../src/reels/shot-planner');
const { buildTimeline } = require('../src/reels/timeline');
const catalogue = require('../src/reels/r2-catalogue');

// A library shaped like a real one: keyworded stills, two files claiming the
// same keyword, one file carrying two keywords, and a generic pool.
const LIB = {
  images: [
    { key: 'images/forest.jpg', keywords: ['forest'] },
    { key: 'images/forest-river.jpg', keywords: ['forest', 'river'] },
    { key: 'images/volunteers.jpg', keywords: ['volunteers'] },
    { key: 'images/solar.jpg', keywords: ['solar'] },
    { key: 'images/hands.jpg', keywords: ['hands'] },
    { key: 'images/city.jpg', keywords: ['city'] },
  ],
  generic: ['generic/sunrise-01.jpg', 'generic/light-02.jpg'],
  tracks: [],
  outros: [],
  stocked: new Set(['forest', 'river', 'volunteers', 'solar', 'hands', 'city']),
  prefixes: { image: 'images/', generic: 'generic/', audio: 'audio/', outro: 'outro/' },
};

const STORY_KEYWORDS = ['forest', 'volunteers'];

const LINES = [
  { text: 'A river everyone had written off is running again.' },
  { text: 'Farmers gave back a strip of land and let the water spread.' },
  { text: 'Fish came back within two summers.' },
];

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failures++;
    console.log(`  ❌ ${name}\n     ${e.message}`);
  }
}

// What the review app would offer, and what the draft would show.
const entries = catalogue.libraryEntries(LIB);
const offered = new Set(entries.map(e => e.key));

console.log('\nThe picker offers every image the reel can reach\n');

check('every keyworded still is offered', () => {
  for (const img of LIB.images) {
    assert.ok(offered.has(img.key), `${img.key} is missing from the picker`);
  }
});

check('two files claiming one keyword are both offered', () => {
  assert.ok(offered.has('images/forest.jpg') && offered.has('images/forest-river.jpg'));
  const labels = entries.map(e => e.label);
  assert.ok(labels.includes('forest') && labels.includes('forest-river'));
});

check('the generic fallback pool is offered', () => {
  for (const key of LIB.generic) {
    assert.ok(offered.has(key), `${key} is missing from the picker`);
  }
});

check('every image the builder can pick is offered', () => {
  // Exhaust the ladder from every rung: exact, sibling, generic, repeat.
  for (let i = 0; i < 400; i++) {
    const used = new Set(LIB.images.slice(0, i % LIB.images.length).map(x => x.key));
    const key = catalogue.pickImage(LIB, ['forest', 'river'], used, null);
    assert.ok(offered.has(key), `${key} can play but is not in the picker`);
  }
});

console.log('\nA reviewed choice is the image that plays\n');

// The editor's file, as the app would commit it: one shot per line, and both
// of the last two shots deliberately pinned to a photo an earlier shot spent.
const approvedShots = [
  { line: 0, key: 'images/forest.jpg', image: 'forest', keywords: ['forest'], motion: 'push-in', transition: 'cut' },
  { line: 1, key: 'images/forest.jpg', image: 'forest', keywords: ['forest'], motion: 'pan-left', transition: 'cut' },
  { line: 2, key: 'generic/light-02.jpg', image: 'light-02', keywords: [], motion: 'pan-up', transition: 'dissolve' },
];

check('an approved key is used verbatim, even when already spent', () => {
  const shots = resolveDraftShots(approvedShots, LINES.length, LIB, STORY_KEYWORDS);
  assert.strictEqual(shots.length, 3);
  assert.deepStrictEqual(shots.map(s => s.key), approvedShots.map(s => s.key));
});

check('a generic still chosen in review survives the build', () => {
  const shots = resolveDraftShots(approvedShots, LINES.length, LIB, STORY_KEYWORDS);
  assert.strictEqual(shots[2].key, 'generic/light-02.jpg');
});

check('motions and transitions are carried through', () => {
  const shots = resolveDraftShots(approvedShots, LINES.length, LIB, STORY_KEYWORDS);
  assert.strictEqual(shots[1].motion, 'pan-left');
  assert.strictEqual(shots[2].transition, 'dissolve');
});

check('the same choice resolves the same way every time', () => {
  const first = resolveDraftShots(approvedShots, LINES.length, LIB, STORY_KEYWORDS).map(s => s.key);
  for (let i = 0; i < 50; i++) {
    const again = resolveDraftShots(approvedShots, LINES.length, LIB, STORY_KEYWORDS).map(s => s.key);
    assert.deepStrictEqual(again, first, 'an approved plan must not be re-rolled');
  }
});

check('a key deleted since the draft falls back to its keywords', () => {
  const stale = [{ line: 0, key: 'images/gone.jpg', keywords: ['solar'], motion: 'push-in', transition: 'cut' }];
  const shots = resolveDraftShots(stale, 1, LIB, STORY_KEYWORDS);
  assert.strictEqual(shots[0].key, 'images/solar.jpg');
});

check('an edit made by the OLD review app still wins over its stale key', () => {
  // The previous app wrote the chosen keyword into `image`/`keywords` and left
  // `key` on whatever the draft first resolved. Honouring that key verbatim
  // would quietly undo the edit, so a label that disagrees with the key means
  // the label is the newer decision.
  const oldEdit = [{
    line: 0, key: 'images/forest.jpg', image: 'city', keywords: ['city'],
    motion: 'push-in', transition: 'cut',
  }];
  const shots = resolveDraftShots(oldEdit, 1, LIB, STORY_KEYWORDS);
  assert.strictEqual(shots[0].key, 'images/city.jpg');
});

check('a consistent key and label is still honoured exactly', () => {
  const clean = [{
    line: 0, key: 'images/forest-river.jpg', image: 'forest-river',
    keywords: ['forest', 'river'], motion: 'push-in', transition: 'cut',
  }];
  const shots = resolveDraftShots(clean, 1, LIB, STORY_KEYWORDS);
  assert.strictEqual(shots[0].key, 'images/forest-river.jpg');
});

check('a malformed shot entry is skipped, not thrown on', () => {
  const junk = [null, 'nonsense', { line: 'x' }, { line: 99 },
    { line: 0, key: 'images/city.jpg', image: 'city' }];
  const shots = resolveDraftShots(junk, 1, LIB, STORY_KEYWORDS);
  assert.deepStrictEqual(shots.map(s => s.key), ['images/city.jpg']);
});

check('a keyword-only shot still gets the photo it asked for', () => {
  // Older drafts, and the legacy library shape, carry no object key. The
  // keyword is still the editor's request, so the exact photo wins even though
  // the shot before it already spent that file.
  const legacy = [
    { line: 0, keywords: ['solar'], motion: 'push-in', transition: 'cut' },
    { line: 1, keywords: ['city'], motion: 'pan-left', transition: 'cut' },
    { line: 2, keywords: ['solar'], motion: 'pan-up', transition: 'cut' },
  ];
  const shots = resolveDraftShots(legacy, 3, LIB, STORY_KEYWORDS);
  assert.strictEqual(shots[0].key, 'images/solar.jpg');
  assert.strictEqual(shots[2].key, 'images/solar.jpg', 'the second ask for solar was substituted away');
});

console.log('\nThe build adds no image the editor did not see\n');

// Long lines and few shots: exactly the shape that makes densify reach for
// more pictures.
const DURATIONS = [6.5, 7.0, 5.5];

check('a reviewed cut is never densified with fresh images', () => {
  const shots = resolveDraftShots(approvedShots, LINES.length, LIB, STORY_KEYWORDS);
  const approvedKeys = new Set(shots.map(s => s.key));
  const timeline = buildTimeline(LINES, shots, DURATIONS, LIB, 'A River Came Back', { densify: false });
  assert.strictEqual(timeline.shots.length, shots.length, 'shot count changed after approval');
  for (const shot of timeline.shots) {
    assert.ok(approvedKeys.has(shot.key), `${shot.key} was never in the approved cut`);
  }
});

check('the unreviewed path still densifies (nothing was approved to protect)', () => {
  const shots = resolveDraftShots(approvedShots, LINES.length, LIB, STORY_KEYWORDS);
  const timeline = buildTimeline(LINES, shots, DURATIONS, LIB, 'A River Came Back');
  assert.ok(timeline.shots.length > shots.length, 'densify should still pace an unreviewed cut');
});

check('the picture and the narration still land together', () => {
  const shots = resolveDraftShots(approvedShots, LINES.length, LIB, STORY_KEYWORDS);
  const timeline = buildTimeline(LINES, shots, DURATIONS, LIB, 'A River Came Back', { densify: false });
  assert.ok(
    Math.abs(timeline.videoDuration - timeline.narrationDuration) < 0.01,
    `picture ${timeline.videoDuration}s vs narration ${timeline.narrationDuration}s`
  );
});

check('blanking a line drops it and its shots, and remaps the rest', () => {
  // What generateReel does with the editor's blanked lines, in miniature.
  const kept = [LINES[0], LINES[2]];
  const remapped = approvedShots
    .filter(s => s.line !== 1)
    .map(s => ({ ...s, line: s.line === 2 ? 1 : 0 }));
  const shots = resolveDraftShots(remapped, kept.length, LIB, STORY_KEYWORDS);
  assert.deepStrictEqual(shots.map(s => s.key), ['images/forest.jpg', 'generic/light-02.jpg']);
  assert.deepStrictEqual(shots.map(s => s.line), [0, 1]);
});

console.log('\nLabels name the file that plays\n');

check('a label is the filename, without folder or extension', () => {
  assert.strictEqual(catalogue.labelOf('videos/b-roll/forest.jpg'), 'forest');
  assert.strictEqual(catalogue.labelOf('generic/sunrise-01.png'), 'sunrise-01');
  assert.strictEqual(catalogue.labelOf(''), '');
});

check('every offered entry has a label the picker can search', () => {
  for (const e of entries) {
    assert.ok(e.label && e.label === path.basename(e.key).replace(/\.[a-z0-9]+$/i, ''));
    assert.ok(e.pool === 'keyword' || e.pool === 'generic');
  }
});

check('hasKey only trusts files that are really there', () => {
  assert.ok(catalogue.hasKey(LIB, 'images/forest.jpg'));
  assert.ok(catalogue.hasKey(LIB, 'generic/light-02.jpg'));
  assert.ok(!catalogue.hasKey(LIB, 'images/gone.jpg'));
  assert.ok(!catalogue.hasKey(LIB, ''));
});

console.log('\nThe wiring, through generateReel itself\n');

// Everything above tests the pieces. This drives the real entry point with the
// heavy edges stubbed out — no R2, no speech, no ffmpeg — so the option that
// protects an approved cut is checked where it's actually passed, not where
// it's convenient to assert.
function driveGenerateReel(approvedReel) {
  const seen = {};

  // Patched before src/reels is required: it destructures these at load time.
  const timeline = require('../src/reels/timeline');
  const realBuildTimeline = timeline.buildTimeline;
  timeline.buildTimeline = function (lines, shots, durations, lib, hook, options) {
    seen.options = options;
    seen.planned = shots;
    // The BUILT timeline, not the plan handed to it — densify runs inside, so
    // inspecting the input would miss exactly the images this is looking for.
    seen.timeline = realBuildTimeline.apply(null, arguments);
    return seen.timeline;
  };

  const voice = require('../src/reels/voice');
  voice.isConfigured = () => true;
  voice.narrateLines = async lines => ({
    clips: lines.map(() => Buffer.alloc(0)), ext: '.mp3', label: 'stub',
  });

  process.env.R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || 'stub';
  process.env.R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || 'stub';

  const reels = require('../src/reels');
  require('../src/reels/ffmpeg').isAvailable = async () => true;
  require('../src/reels/r2-catalogue').loadCatalogue = async () => LIB;

  const asm = require('../src/reels/assembler');
  asm.normalizeVoiceClips = async (workDir, clips) => ({
    files: clips.map((_, i) => `voice-${i}.wav`),
    durations: DURATIONS.slice(0, clips.length),
  });
  // Stop the run the moment the timeline is built — everything past this point
  // is ffmpeg, and the timeline is what we came to inspect.
  asm.buildNarration = async () => { throw new Error('__stop__'); };

  const story = { headline: 'A river came back', publisher: 'The Guardian', url: 'https://example.test' };
  const slideCopy = { pillar: 'Climate & Environment', source: 'The Guardian', resultHeading: 'The river runs again' };

  return reels.generateReel(story, slideCopy, {}, null, approvedReel)
    .then(() => { throw new Error('the stub should have stopped the run'); })
    .catch(err => {
      if (err.message !== '__stop__') throw err;
      return seen;
    });
}

const approvedReel = {
  lines: LINES.map(l => ({ text: l.text })),
  shots: approvedShots,
  hook: 'A River Came Back',
  mood: 'uplifting',
};

driveGenerateReel(approvedReel).then(seen => {
  check('generateReel turns densify OFF for an approved cut', () => {
    assert.ok(seen.options, 'buildTimeline was called with no options at all');
    assert.strictEqual(seen.options.densify, false);
  });

  check('no image reaches the reel that was not in the approved cut', () => {
    const approvedKeys = new Set(approvedShots.map(s => s.key));
    const strays = seen.timeline.shots.filter(s => !approvedKeys.has(s.key));
    assert.deepStrictEqual(
      strays.map(s => s.key), [],
      'these images were never shown in review'
    );
  });

  check('the approved cut reaches the reel shot for shot', () => {
    assert.deepStrictEqual(
      seen.timeline.shots.map(s => s.key),
      approvedShots.map(s => s.key)
    );
  });

  if (failures) {
    console.error(`\n❌ ${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log('\n✅ The review app and the reel builder agree: what you see is what plays.\n');
}).catch(err => {
  console.error(`\n❌ The generateReel harness failed: ${err.message}\n`);
  process.exit(1);
});
