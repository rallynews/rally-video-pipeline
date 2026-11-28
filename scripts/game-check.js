#!/usr/bin/env node
// Builds one Joyscroll Game video of each kind — Joyword, Crossjoy, Trivia —
// from sample puzzles, so the look, the pacing and the sound can be checked
// without Studio:
//
//   npm run game-check                 # real voice and music (needs the secrets)
//   npm run game-check -- --offline    # no network: a tone stands in for the
//                                      # voice, a generated bed for the music
//
// Writes game-check-<type>.mp4 to the current folder (or --out <dir>) and
// checks each is 1080×1920 and 20–30 seconds long.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const args = process.argv.slice(2);
const offline = args.includes('--offline');
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : process.cwd();
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

const ff = require('../src/reels/ffmpeg');

if (offline) {
  // A tone as long as an unhurried read of each line, and a soft chord as the
  // music bed, in place of the speech API and the R2 library.
  const voice = require('../src/reels/voice');
  voice.useGameVoice = () => {};
  voice.narrateLines = async (lines) => {
    const clips = [];
    for (const [i, l] of lines.entries()) {
      const secs = Math.max(0.8, l.text.split(/\s+/).length / 2.6);
      const f = path.join(require('os').tmpdir(), `game-check-voice-${i}.mp3`);
      await ff.ffmpeg(['-y', '-f', 'lavfi', '-i', `sine=frequency=${220 + 40 * i}:duration=${secs}`, '-af', 'volume=0.4', f]);
      clips.push(fs.readFileSync(f));
    }
    return { provider: 'offline', label: 'offline tone', ext: 'mp3', clips };
  };
  const cat = require('../src/reels/r2-catalogue');
  cat.loadCatalogue = async () => ({ tracks: ['offline-bed.mp3'] });
  cat.downloadObject = async (key, dest) => {
    await ff.ffmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=262:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=12',
      '-filter_complex', 'amix=inputs=2,volume=0.3', dest]);
    return dest;
  };
}

const { buildGameVideo } = require('../src/joyscroll');

const SAMPLES = {
  joyword: {
    narration: 'Think you can find today’s happy word? We got so close. Your turn — play free on Joyscroll.',
    game: { type: 'joyword', word: 'grace', definition: 'Simple elegance, or kindness freely given' },
  },
  crossjoy: {
    narration: 'A crossword made from today’s good news. One letter off! Can you finish it?',
    game: { type: 'crossjoy', grid: ['hope#', 'a#mat', 'pride', 'py#ok', '#yes#'], clues: [
      { dir: 'across', row: 0, col: 0, clue: 'What a seed bank gives a dying species' },
      { dir: 'across', row: 1, col: 2, clue: 'Yoga ___' },
      { dir: 'across', row: 2, col: 0, clue: 'Parade that filled the streets of São Paulo' },
      { dir: 'across', row: 3, col: 3, clue: 'All good' },
      { dir: 'across', row: 4, col: 1, clue: 'The town said ___ to a four-day week' },
      { dir: 'down', row: 0, col: 0, clue: 'Cheerful' },
      { dir: 'down', row: 1, col: 2, clue: 'Rescue pup, for one' },
      { dir: 'down', row: 0, col: 3, clue: 'Flower part' },
      { dir: 'down', row: 1, col: 4, clue: 'Elephant tusk material, once traded' },
    ] },
  },
  trivia: {
    narration: '',
    game: { type: 'trivia', questions: [
      { question: 'Which animal returned to Yellowstone after 70 years?', options: ['Grey wolves', 'Bison', 'Lynx', 'Beavers'], answer_index: 0 },
      { question: 'How many trees did volunteers plant along the river?', options: ['Ten thousand', 'One million', 'Fifty', 'Two hundred'], answer_index: 1 },
      { question: 'What became the cheapest power in 40 countries?', options: ['Wind', 'Solar', 'Hydro', 'Nuclear'], answer_index: 1 },
      { question: 'Who earned a university degree at 92?', options: ['A farmer', 'A grandmother', 'A pilot', 'A chef'], answer_index: 1 },
      { question: 'What did the town turn its parking lots into?', options: ['Skate parks', 'Community gardens', 'Markets', 'Playgrounds'], answer_index: 1 },
    ] },
  },
};

(async () => {
  for (const [type, s] of Object.entries(SAMPLES)) {
    if (only && type !== only) continue;
    console.log(`\n🎮 ${type}`);
    const out = await buildGameVideo({ kind: 'game', title: type, game: s.game, narration: s.narration });
    const file = path.join(outDir, `game-check-${type}.mp4`);
    fs.writeFileSync(file, out.buffer);
    const { stdout } = await new Promise((resolve, reject) => require('child_process').execFile(ff.FFPROBE,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'csv=p=0', file],
      (err, stdout) => (err ? reject(err) : resolve({ stdout }))));
    const [w, h] = stdout.trim().split(',').map(Number);
    assert.strictEqual(w, 1080); assert.strictEqual(h, 1920);
    assert.ok(out.duration >= 19.9 && out.duration <= 30.1, `duration ${out.duration}`);
    console.log(`   ✓ ${file} — ${w}×${h}, ${out.duration.toFixed(1)}s, voice: ${out.voice}`);
  }
  console.log('\nall game videos built\n');
})().catch(e => { console.error(e); process.exit(1); });
