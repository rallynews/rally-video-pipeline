const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeReelScript } = require('./script-writer');
const { planShots } = require('./shot-planner');
const { narrateLines, isConfigured: voiceConfigured } = require('./voice');
const { renderOverlays, renderFollowCard } = require('./caption-renderer');
const { buildTimeline } = require('./timeline');
const catalogue = require('./r2-catalogue');
const ff = require('./ffmpeg');
const asm = require('./assembler');

// The reel: the same story the carousel tells, as a 9:16 MP4.
//
//   1. Mistral writes a 20–30s spoken script from the fact-checked carousel copy
//   2. Mistral plans the cuts and names the R2 keywords each one lands on
//   3. a cheap European neural voice records it, line by line
//   4. a Creative Commons track is drawn at random from the R2 catalogue
//   5. ffmpeg cuts it together: motion, transitions, Lora captions, Follow Us
//
// Everything is disposable — assets are pulled fresh from R2 into a temp dir
// and the dir is removed on the way out, whether or not the run succeeded.

function storyKeywordsFor(story, slideCopy, vocabulary) {
  const vocab = new Set(vocabulary);
  const tokens = catalogue.tokenize(
    `${story.headline} ${slideCopy.pillar} ${slideCopy.resultHeading}`
  );
  const hits = [...new Set(tokens)].filter(t => vocab.has(t));
  // If nothing in the story's own words exists in the library, fall back to the
  // library's most common keywords so shots still resolve to something.
  return hits.length ? hits.slice(0, 6) : vocabulary.slice(0, 4);
}

// Why a run can't happen, or null if it can.
function missingPrerequisite() {
  if (!process.env.R2_BUCKET || !process.env.R2_ACCOUNT_ID) {
    return 'R2 is not configured (R2_BUCKET / R2_ACCOUNT_ID) — the reel pulls its footage and music from there';
  }
  if (!voiceConfigured()) {
    return 'no text-to-speech provider configured (set AZURE_SPEECH_KEY, ELEVENLABS_API_KEY or OPENAI_API_KEY)';
  }
  return null;
}

function isConfigured() {
  return missingPrerequisite() === null;
}

async function generateReel(story, slideCopy, raw) {
  const blocked = missingPrerequisite();
  if (blocked) throw new Error(blocked);
  if (!(await ff.isAvailable())) {
    throw new Error('ffmpeg/ffprobe not found on PATH — install ffmpeg to build reels');
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-reel-'));

  try {
    console.log('  [reel] reading the R2 asset catalogue...');
    const lib = await catalogue.loadCatalogue();
    console.log(`  [reel] ${lib.images.length} images, ${lib.tracks.length} music tracks, ${lib.vocabulary.length} keywords`);
    if (!lib.images.length) {
      throw new Error(`no images under ${catalogue.IMAGE_PREFIX()} in R2 — upload b-roll before enabling reels`);
    }

    // 1 · script
    console.log('  [reel] writing the 20–30s script...');
    const { script, lines, mood, wordCount } = await writeReelScript(story, slideCopy, raw);
    console.log(`  [reel] ${wordCount} words across ${lines.length} lines (mood: ${mood})`);

    // 2 · cuts
    console.log('  [reel] planning the cuts...');
    const storyKeywords = storyKeywordsFor(story, slideCopy, lib.vocabulary);
    const plannedShots = await planShots(story, slideCopy, script, lines, lib, storyKeywords);

    // 3 · voice
    const voice = await narrateLines(lines);
    const { files: voiceFiles, durations } = await asm.normalizeVoiceClips(
      workDir, voice.clips, voice.ext
    );
    const spoken = durations.reduce((a, b) => a + b, 0);
    console.log(`  [reel] narration recorded — ${spoken.toFixed(1)}s of speech`);

    // The edit, timed against the voice that will actually play.
    const timeline = buildTimeline(lines, plannedShots, durations, lib);
    console.log(
      `  [reel] timeline: ${timeline.shots.length} shots over ` +
      `${timeline.videoDuration.toFixed(1)}s, ${timeline.captions.length} captions`
    );

    const narrationPath = await asm.buildNarration(workDir, timeline.segments, voiceFiles);

    // 4 · music
    const track = catalogue.pickTrack(lib.tracks);
    let musicPath = null;
    if (track) {
      musicPath = await catalogue.downloadObject(
        track, path.join(workDir, `music${path.extname(track) || '.mp3'}`)
      );
      console.log(`  [reel] music bed: ${track}`);
    } else {
      console.warn(`  [reel] no tracks under ${catalogue.AUDIO_PREFIX()} — reel will run voice-only`);
    }

    // 5 · pictures
    console.log('  [reel] downloading footage...');
    const imagePaths = new Map();
    for (const shot of timeline.shots) {
      if (imagePaths.has(shot.key)) continue;
      const dest = path.join(
        workDir, `img-${imagePaths.size}${path.extname(shot.key) || '.jpg'}`
      );
      imagePaths.set(shot.key, await catalogue.downloadObject(shot.key, dest));
    }

    const overlays = await renderOverlays(timeline.captions.map(c => c.text));

    const captionFiles = overlays.captions.map((buf, i) => {
      const file = path.join(workDir, `caption-${i}.png`);
      fs.writeFileSync(file, buf);
      return file;
    });
    const brandFile = path.join(workDir, 'brand.png');
    fs.writeFileSync(brandFile, overlays.brand);

    console.log(`  [reel] rendering ${timeline.shots.length} moving shots...`);
    const clipFiles = [];
    for (let i = 0; i < timeline.shots.length; i++) {
      const shot = timeline.shots[i];
      clipFiles.push(await asm.renderShotClip(workDir, shot, i, imagePaths.get(shot.key)));
    }

    console.log('  [reel] chaining transitions...');
    const montage = await asm.chainShots(workDir, clipFiles, timeline.shots);

    console.log('  [reel] burning in captions...');
    const main = await asm.overlayCaptions(
      workDir, montage, captionFiles, timeline.captions, brandFile, timeline.videoDuration
    );

    // 6 · the Follow Us ending
    let outroVideo = null;
    try {
      outroVideo = await catalogue.downloadObject(
        catalogue.OUTRO_KEY(), path.join(workDir, 'outro-src.mp4')
      );
    } catch (e) {
      console.warn(`  [reel] no Follow Us MP4 at ${catalogue.OUTRO_KEY()} (${e.name || e.message}) — rendering a card instead`);
    }
    let outroStill = null;
    if (!outroVideo) {
      outroStill = path.join(workDir, 'outro-still.png');
      fs.writeFileSync(outroStill, await renderFollowCard());
    }
    const outro = await asm.prepareOutro(workDir, outroVideo, outroStill);
    const video = await asm.appendOutro(workDir, main, timeline.videoDuration, outro);

    // 7 · sound
    console.log('  [reel] mixing audio...');
    const audio = await asm.buildAudio(
      workDir, narrationPath, musicPath, video.duration, timeline.narrationDuration
    );

    const reelPath = await asm.mux(workDir, video.path, audio);
    const buffer = fs.readFileSync(reelPath);
    const duration = await ff.ffprobeDuration(reelPath);

    console.log(
      `  [reel] built ${(buffer.length / 1024 / 1024).toFixed(1)} MB, ${duration.toFixed(1)}s`
    );

    return {
      buffer,
      duration,
      script,
      lines,
      mood,
      wordCount,
      shots: timeline.shots.map(s => ({
        key: s.key, motion: s.motion, transition: s.transition,
        start: Number(s.start.toFixed(2)), duration: Number(s.duration.toFixed(2)),
      })),
      captions: timeline.captions.map(c => c.text),
      voice: voice.label,
      track,
      outroSource: outroVideo ? catalogue.OUTRO_KEY() : 'rendered fallback card',
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { generateReel, isConfigured, missingPrerequisite };
