const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const plan = require('./plan');
const voice = require('../reels/voice');
const catalogue = require('../reels/r2-catalogue');
const ff = require('../reels/ffmpeg');
const asm = require('../reels/assembler');

// A Joyscroll Game video: 1080×1920, 20–30 seconds. One game playing itself to
// a near miss (plan.js), drawn frame by frame in a browser (page.html), with
// the editor's narration voiced line by line and captioned in time, a music
// bed from the reels' library, the game's own sound effects, and the orange
// Joyscroll end card.
//
// buildGameVideo(draft) takes the draft Studio confirmed —
//   { kind: 'game', game: { type, … }, narration, captions, title }
// — and returns { buffer, duration, voice, track }.

const FPS = 30;
const PAGE = path.join(__dirname, 'page.html');
const SOUNDS = path.join(__dirname, '..', '..', 'assets', 'joyscroll', 'sounds');
const LINE_GAP = 0.22;            // silence between narration sentences
const CAPTION_WORDS = 8;          // longest caption shown at once
const SFX_LEVEL = 0.55;           // game sounds under the music and voice

// Sentences to voice, each split into short caption chunks.
function narrationLines(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?…]+[.!?…]+["'”’)]*|[^.!?…]+$/g) || [clean];
  return sentences.map(s => s.trim()).filter(Boolean).map(sentence => {
    const words = sentence.split(' ');
    const n = Math.ceil(words.length / CAPTION_WORDS);
    const per = Math.ceil(words.length / n);
    const chunks = [];
    for (let i = 0; i < words.length; i += per) chunks.push(words.slice(i, i + per).join(' '));
    return { text: sentence, chunks };
  });
}

// Captions for each sentence, its chunks sharing its time by word count.
function captionTimes(lines, durations, start) {
  const caps = [];
  let t = start;
  lines.forEach((line, i) => {
    const dur = durations[i];
    const total = line.chunks.reduce((n, c) => n + c.split(' ').length, 0);
    let at = t;
    line.chunks.forEach(chunk => {
      const d = dur * chunk.split(' ').length / total;
      caps.push({ start: +at.toFixed(3), end: +(at + d + 0.08).toFixed(3), text: chunk });
      at += d;
    });
    t += dur + LINE_GAP;
  });
  return caps;
}

// Film the page: one screenshot per frame, piped straight into x264.
async function filmFrames(workDir, script) {
  const puppeteer = require('puppeteer');
  const out = path.join(workDir, 'game.mp4');
  const frames = Math.round(script.total * FPS);
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 360, height: 640, deviceScaleFactor: 3 });
    await page.goto('file://' + PAGE, { waitUntil: 'load' });
    await page.evaluate(s => window.setScript(s), script);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => Promise.all([...document.images].map(i => i.complete ? null : new Promise(r => { i.onload = r; i.onerror = r; }))));

    const enc = spawn(ff.FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p',
      '-r', String(FPS), '-movflags', '+faststart', out,
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    enc.stderr.on('data', d => { stderr += d; });
    const finished = new Promise((resolve, reject) => {
      enc.on('error', reject);
      enc.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg (frames) failed: ${stderr.slice(-400)}`))));
    });

    for (let i = 0; i < frames; i++) {
      await page.evaluate(t => window.renderAt(t), i / FPS);
      const jpg = await page.screenshot({ type: 'jpeg', quality: 92 });
      if (!enc.stdin.write(jpg)) await new Promise(r => enc.stdin.once('drain', r));
      if (i % (FPS * 5) === 0) console.log(`  [game] filmed ${i}/${frames} frames`);
    }
    enc.stdin.end();
    await finished;
  } finally {
    await browser.close();
  }
  return out;
}

// The game's sound effects on one track: every key, flip, chime and miss at
// its moment.
async function buildSfx(workDir, cues, total) {
  const out = path.join(workDir, 'sfx.wav');
  const used = cues.filter(c => fs.existsSync(path.join(SOUNDS, `${c.sfx}.wav`)));
  if (!used.length) {
    await ff.ffmpeg(['-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', String(total), out]);
    return out;
  }
  const inputs = [];
  const parts = [];
  used.forEach((c, i) => {
    inputs.push('-i', path.join(SOUNDS, `${c.sfx}.wav`));
    const ms = Math.max(0, Math.round(c.t * 1000));
    parts.push(`[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${c.volume},adelay=${ms}|${ms}[s${i}]`);
  });
  const mix = used.map((_, i) => `[s${i}]`).join('') +
    `amix=inputs=${used.length}:normalize=0:dropout_transition=0,apad=whole_dur=${total},atrim=0:${total}[sfx]`;
  await ff.ffmpeg(['-y', ...inputs, '-filter_complex', parts.join(';') + ';' + mix, '-map', '[sfx]',
                   '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', out], { timeout: 300000 });
  return out;
}

async function buildGameVideo(draft) {
  if (!draft || draft.kind !== 'game' || !draft.game) throw new Error('This is not a Joyscroll Game draft');
  if (!(await ff.isAvailable())) throw new Error('ffmpeg/ffprobe not found on PATH — install ffmpeg to build videos');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'joyscroll-game-'));
  try {
    // 1 · narration, if there is any
    const lines = narrationLines(draft.narration);
    let voiceFiles = [], durations = [], voiceLabel = 'no narration';
    if (lines.length) {
      voice.useGameVoice();
      const spoken = await voice.narrateLines(lines.map(l => ({ text: l.text })));
      ({ files: voiceFiles, durations } = await asm.normalizeVoiceClips(workDir, spoken.clips, spoken.ext));
      voiceLabel = spoken.label;
    }
    const voiceSeconds = durations.length ? durations.reduce((a, b) => a + b, 0) + LINE_GAP * (durations.length - 1) : 0;
    const captions = captionTimes(lines, durations, plan.VOICE_START);

    // 2 · the script, fitted to 20–30 seconds around the narration
    const script = plan.buildScript(draft.game, { voiceSeconds, captions });
    console.log(`  [game] ${draft.game.type}: ${script.total.toFixed(1)}s (game ${script.endAt.toFixed(1)}s + end card), ` +
                `${lines.length} narration line(s), ${captions.length} caption(s)`);

    // 3 · the picture
    const videoPath = await filmFrames(workDir, script);

    // 4 · the sound: voice, music, game effects
    const segments = [{ type: 'silence', duration: plan.VOICE_START }];
    voiceFiles.forEach((_, i) => {
      segments.push({ type: 'voice', index: i });
      if (i < voiceFiles.length - 1) segments.push({ type: 'silence', duration: LINE_GAP });
    });
    if (!voiceFiles.length) segments.push({ type: 'silence', duration: script.total - plan.VOICE_START });
    const narrationPath = await asm.buildNarration(workDir, segments, voiceFiles);

    let musicPath = null, track = null;
    try {
      const lib = await catalogue.loadCatalogue();
      track = catalogue.pickTrack(lib.tracks);
      if (track) musicPath = await catalogue.downloadObject(track, path.join(workDir, `music${path.extname(track) || '.mp3'}`));
    } catch (e) {
      console.warn(`  [game] no music (${e.message}) — voice and game sounds only`);
    }
    const voiceEndsAt = voiceFiles.length ? plan.VOICE_START + voiceSeconds : 0;
    const bed = await asm.buildAudio(workDir, narrationPath, musicPath, script.total, voiceEndsAt);
    const sfx = await buildSfx(workDir, plan.sfxCues(script), script.total);
    const audio = path.join(workDir, 'final-audio.wav');
    await ff.ffmpeg(['-y', '-i', bed, '-i', sfx, '-filter_complex',
      `[1:a]volume=${SFX_LEVEL}[fx];[0:a][fx]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]`,
      '-map', '[a]', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', audio]);

    const reelPath = await asm.mux(workDir, videoPath, audio);
    const buffer = fs.readFileSync(reelPath);
    const duration = await ff.ffprobeDuration(reelPath);
    console.log(`  [game] built ${(buffer.length / 1024 / 1024).toFixed(1)} MB, ${duration.toFixed(1)}s`);
    return { buffer, duration, voice: voiceLabel, track, musicMuted: !musicPath };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { buildGameVideo, narrationLines, captionTimes };
