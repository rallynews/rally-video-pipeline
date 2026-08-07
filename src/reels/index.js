const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeReelScript } = require('./script-writer');
const { planShots, resolveDraftShots } = require('./shot-planner');
const { narrateLines, isConfigured: voiceConfigured, describeProvider } = require('./voice');
const { renderOverlays, renderFollowCard } = require('./caption-renderer');
const { buildTimeline } = require('./timeline');
const { filterToBank } = require('./keywords');
const catalogue = require('./r2-catalogue');
const ff = require('./ffmpeg');
const asm = require('./assembler');

// The reel: the same story the carousel tells, as a 9:16 MP4.
//
//   1. Mistral writes a 20–30s spoken script from the fact-checked carousel copy
//   2. Mistral plans the cuts and names the bank keywords each one lands on
//   3. a cheap European neural voice records it, line by line
//   4. a Creative Commons track is drawn at random from the R2 catalogue
//   5. ffmpeg cuts it together: motion, transitions, Lora captions, Follow Us
//
// The reel always OPENS on the article's own featured photo — the same image
// the carousel puts on its cover — credited to the outlet that published it.
// Everything after that comes from the R2 library.
//
// Assets are pulled fresh into a temp dir which is removed on the way out,
// whether or not the run succeeded.

// How long the "Photo: <outlet>" credit stays up over the opening shot.
const CREDIT_MIN = 2.4;

// A sentinel key for the opening shot, which isn't a library object.
const COVER_KEY = '__article-cover__';

function storyKeywordsFor(story, slideCopy, stocked) {
  const words = catalogue.tokenize(
    `${story.headline} ${slideCopy.pillar} ${slideCopy.resultHeading}`
  );
  const hits = filterToBank(words).filter(w => stocked.has(w));
  if (hits.length) return hits.slice(0, 6);
  // Nothing in the story's own words is stocked — hand back whatever the
  // library does have so shots resolve to something rather than all-generic.
  return [...stocked].slice(0, 4);
}

// Decode the carousel's cover photo (a data: URI) to a file the encoder can read.
function writeCoverImage(workDir, coverUri) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(String(coverUri || ''));
  if (!match) return null;
  const ext = match[1].includes('png') ? '.png'
    : match[1].includes('webp') ? '.webp'
    : match[1].includes('svg') ? '.svg'
    : '.jpg';
  // ffmpeg won't decode SVG, and the SVG cover is only ever the brand fallback
  // card — not worth opening the reel on.
  if (ext === '.svg') return null;
  const file = path.join(workDir, `cover${ext}`);
  fs.writeFileSync(file, Buffer.from(match[2], 'base64'));
  return file;
}

// Why a run can't happen, or null if it can.
function missingPrerequisite() {
  if (!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID) {
    return 'R2 is not configured (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID) — the reel pulls its footage and music from there';
  }
  if (!voiceConfigured()) {
    return 'no text-to-speech provider configured (set OPENROUTER_API_KEY, AZURE_SPEECH_KEY, ELEVENLABS_API_KEY or OPENAI_API_KEY)';
  }
  return null;
}

function isConfigured() {
  return missingPrerequisite() === null;
}

// Plan today's reel without building it: the script, the cuts, and the images
// they resolve to right now. This is what goes into the morning review draft.
async function planReel(story, slideCopy, raw) {
  const blocked = missingPrerequisite();
  if (blocked) throw new Error(blocked);

  const lib = await catalogue.loadCatalogue();
  if (!lib.images.length && !lib.generic.length) {
    throw new Error(
      `no images under ${catalogue.IMAGE_PREFIX()} or ${catalogue.GENERIC_PREFIX()} ` +
      `in ${catalogue.VIDEO_BUCKET()} — upload b-roll before enabling reels`
    );
  }

  const { script, hook, lines, mood, wordCount } = await writeReelScript(story, slideCopy, raw);
  const storyKeywords = storyKeywordsFor(story, slideCopy, lib.stocked);
  const shots = await planShots(story, slideCopy, script, lines, lib, storyKeywords);

  // keyword → object key for every stocked keyword, so the review app can
  // offer a picker of real images (and their thumbnails) instead of free text.
  const library = {};
  for (const img of lib.images) {
    for (const k of img.keywords) {
      if (!library[k]) library[k] = img.key;
    }
  }

  // The keyword the resolved file is actually named after — what the review
  // app's picker must show, as opposed to the keywords the planner ASKED for
  // (which, on a fallback, can be something else entirely).
  const keywordOfKey = key =>
    filterToBank(catalogue.tokenize(path.basename(String(key || ''))))[0] || null;

  return {
    script,
    hook,
    mood,
    wordCount,
    lines,
    shots: shots.map(s => ({
      line: s.line, keywords: s.keywords, key: s.key,
      image: keywordOfKey(s.key),
      motion: s.motion, transition: s.transition,
    })),
    stockedKeywords: [...lib.stocked].sort(),
    library,
  };
}

// `approved` (optional) is a reviewed draft: { lines, shots, mood } with the
// editor's changes. When present, the script/plan steps are skipped and the
// reel is built from exactly what was approved — keywords re-resolved against
// today's library, empty lines dropped along with their shots.
async function generateReel(story, slideCopy, raw, coverUri, approved) {
  const blocked = missingPrerequisite();
  if (blocked) throw new Error(blocked);
  if (!(await ff.isAvailable())) {
    throw new Error('ffmpeg/ffprobe not found on PATH — install ffmpeg to build reels');
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-reel-'));

  try {
    console.log(`  [reel] reading the ${catalogue.VIDEO_BUCKET()} catalogue...`);
    const lib = await catalogue.loadCatalogue();
    console.log(
      `  [reel] ${lib.images.length} keyworded images (${lib.stocked.size} keywords stocked) ` +
      `from ${lib.prefixes.image || '(bucket root)'}, ${lib.generic.length} generic, ` +
      `${lib.tracks.length} tracks, ${lib.outros.length} outro(s)`
    );
    if (!lib.images.length && !lib.generic.length) {
      throw new Error(
        `no images under ${lib.prefixes.image || '(bucket root)'} or ` +
        `${lib.prefixes.generic || '(bucket root)'} in ${catalogue.VIDEO_BUCKET()} — ` +
        `upload b-roll, or point R2_REELS_IMAGE_PREFIX at the folder it's in ` +
        `(npm run reel-assets shows what the bucket holds)`
      );
    }

    const storyKeywords = storyKeywordsFor(story, slideCopy, lib.stocked);
    let script, hook, lines, mood, wordCount, plannedShots;

    if (approved && Array.isArray(approved.lines)) {
      // The editor's cut. Blanked lines are dropped and shot indexes remapped
      // so the remaining shots stay glued to the lines they were planned for.
      const keptIndex = new Map();
      lines = [];
      approved.lines.forEach((l, i) => {
        const text = String((l && l.text) || '').replace(/\s+/g, ' ').trim();
        if (!text) return;
        keptIndex.set(i, lines.length);
        lines.push({ text });
      });
      if (!lines.length) throw new Error('Approved reel has no script lines left');

      const remapped = (approved.shots || [])
        .filter(s => keptIndex.has(Number(s && s.line)))
        .map(s => ({ ...s, line: keptIndex.get(Number(s.line)) }));

      script = lines.map(l => l.text).join(' ');
      hook = String(approved.hook || '').trim();
      mood = String(approved.mood || 'uplifting');
      wordCount = script.split(/\s+/).length;
      plannedShots = resolveDraftShots(remapped, lines.length, lib, storyKeywords);
      console.log(`  [reel] building from the approved draft — ${lines.length} lines, ${plannedShots.length} shots`);
    } else {
      // 1 · script
      console.log('  [reel] writing the 20–30s script...');
      ({ script, hook, lines, mood, wordCount } = await writeReelScript(story, slideCopy, raw));
      console.log(`  [reel] ${wordCount} words across ${lines.length} lines (mood: ${mood})`);

      // 2 · cuts
      console.log('  [reel] planning the cuts...');
      plannedShots = await planShots(story, slideCopy, script, lines, lib, storyKeywords);
    }

    // The reel opens on the article's own photo, so the first shot is swapped
    // for it. Counts and pacing are untouched — only what shot 1 shows.
    const coverFile = writeCoverImage(workDir, coverUri);
    if (coverFile) {
      plannedShots[0] = {
        ...plannedShots[0],
        key: COVER_KEY,
        // A slow establishing push on the photo the story is actually about.
        motion: 'push-in',
        transition: 'cut',
      };
    } else if (coverUri) {
      console.warn('  [reel] article cover photo unusable — opening on library footage instead');
    }

    // 3 · voice
    const voice = await narrateLines(lines);
    const { files: voiceFiles, durations } = await asm.normalizeVoiceClips(
      workDir, voice.clips, voice.ext
    );
    const spoken = durations.reduce((a, b) => a + b, 0);
    console.log(`  [reel] narration recorded — ${spoken.toFixed(1)}s of speech`);

    // The edit, timed against the voice that will actually play.
    const timeline = buildTimeline(lines, plannedShots, durations, lib, hook);
    console.log(
      `  [reel] timeline: ${timeline.shots.length} shots over ` +
      `${timeline.videoDuration.toFixed(1)}s, ${timeline.captions.length} captions`
    );

    const narrationPath = await asm.buildNarration(workDir, timeline.segments, voiceFiles);

    // 4 · music
    // The editor can mute the bed for a story that plays better dry — a
    // sombre subject, or narration that a track fights rather than lifts.
    const muted = Boolean(approved && approved.noMusic);
    const track = muted ? null : catalogue.pickTrack(lib.tracks);
    let musicPath = null;
    if (muted) {
      console.log('  [reel] music muted in review — voice only');
    } else if (track) {
      musicPath = await catalogue.downloadObject(
        track, path.join(workDir, `music${path.extname(track) || '.mp3'}`)
      );
      console.log(`  [reel] music bed: ${track}`);
    } else {
      console.warn(
        `  [reel] no tracks under ${lib.prefixes.audio || '(bucket root)'} — reel will run voice-only`
      );
    }

    // 5 · pictures
    console.log('  [reel] downloading footage...');
    const imagePaths = new Map();
    if (coverFile) imagePaths.set(COVER_KEY, coverFile);
    for (const shot of timeline.shots) {
      if (imagePaths.has(shot.key)) continue;
      const dest = path.join(
        workDir, `img-${imagePaths.size}${path.extname(shot.key) || '.jpg'}`
      );
      imagePaths.set(shot.key, await catalogue.downloadObject(shot.key, dest));
    }

    // The photo credit belongs to the opening shot, but is held for a readable
    // minimum in case the first cut is a fast one.
    const photoCredit = coverFile ? slideCopy.source : '';
    const overlays = await renderOverlays(
      timeline.captions.map(c => ({ text: c.text, hook: c.hook })), photoCredit
    );

    const timedLayers = timeline.captions.map((cap, i) => {
      const file = path.join(workDir, `caption-${i}.png`);
      fs.writeFileSync(file, overlays.captions[i]);
      return { file, start: cap.start, end: cap.end };
    });

    if (overlays.credit) {
      const file = path.join(workDir, 'credit.png');
      fs.writeFileSync(file, overlays.credit);
      // Stacked last so it sits above the captions if they ever overlap.
      timedLayers.push({
        file,
        start: 0.15,
        end: Math.min(timeline.videoDuration, Math.max(CREDIT_MIN, timeline.shots[0].duration)),
      });
    }

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
    const main = await asm.overlayTimedLayers(
      workDir, montage, timedLayers, brandFile, timeline.videoDuration
    );

    // 6 · the Follow Us ending
    const outroKey = catalogue.pickOutro(lib.outros);
    let outroVideo = null;
    if (outroKey) {
      try {
        outroVideo = await catalogue.downloadObject(
          outroKey, path.join(workDir, `outro-src${path.extname(outroKey) || '.mp4'}`)
        );
      } catch (e) {
        console.warn(`  [reel] could not fetch ${outroKey} (${e.message}) — rendering a card instead`);
      }
    } else {
      console.warn(
        `  [reel] no MP4 under ${lib.prefixes.outro || '(bucket root)'} — rendering a Follow Us card instead`
      );
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
      hook,
      lines,
      mood,
      wordCount,
      shots: timeline.shots.map(s => ({
        key: s.key === COVER_KEY ? `article photo (${slideCopy.source || 'uncredited'})` : s.key,
        motion: s.motion,
        transition: s.transition,
        start: Number(s.start.toFixed(2)),
        duration: Number(s.duration.toFixed(2)),
      })),
      captions: timeline.captions.map(c => c.text),
      voice: voice.label,
      track,
      musicMuted: muted,
      outroSource: outroVideo ? outroKey : 'rendered fallback card',
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { generateReel, planReel, isConfigured, missingPrerequisite, describeProvider };
