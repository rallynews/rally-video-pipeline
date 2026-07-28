const fs = require('fs');
const path = require('path');
const { ffmpeg, ffprobeDuration } = require('./ffmpeg');

// Step 5: cut the whole thing together.
//
// The edit is built in passes rather than one monstrous filter graph — each
// pass writes a real file, so when something goes wrong the intermediate is
// there to look at:
//
//   1. voice clips  → 48kHz stereo WAV, one per line, measured
//   2. narration    → those clips concatenated with their pauses
//   3. shot clips   → one moving 1080×1920 clip per image
//   4. montage      → the shots chained together with their transitions
//   5. main         → captions and the brand mark overlaid
//   6. video        → the Follow Us card dissolved on the end
//   7. audio        → narration mixed over the music bed
//   8. reel.mp4     → video + audio muxed, faststart

const FPS = 30;
const W = 1080;
const H = 1920;
// Every still is cover-cropped to 2× the output before it moves, so the
// zoom/pan is resampled down rather than up and never crawls.
const SRC_W = W * 2;
const SRC_H = H * 2;

const OUTRO_DISSOLVE = 0.45;
const CAPTION_FADE = 0.18;

// The mix contract: while the narrator speaks, the music sits at ~60% of her
// perceived loudness — i.e. 40% quieter. Raw gain can't promise that (every CC
// track and every TTS voice arrives at a different level), so both buses are
// loudness-normalised to the same LUFS first and the music is then offset by
// a fixed dB amount. −7.5 dB ≈ 60% perceived loudness on the ~10dB-per-
// doubling rule. Over the Follow Us card, with no voice to defer to, it rises
// to −3 dB.
const VOICE_LUFS = -15;
const MUSIC_UNDER_VOICE = 0.42;  // −7.5 dB after normalisation → ~40% quieter
const MUSIC_UNDER_OUTRO = 0.7;   // −3 dB over the outro
const MUSIC_RAMP = 0.8;

const XFADE = {
  'cut': 'fade',
  'whip-left': 'slideleft',
  'whip-right': 'slideright',
  'dissolve': 'fade',
  'flash': 'fadewhite',
  'zoom-punch': 'zoomin',
};

const round = (n) => Number(n.toFixed(3));

// ── 1 · voice ──────────────────────────────────────────────────────────────

// Whatever the TTS provider hands back (WAV from Azure, MP3 elsewhere) becomes
// one uniform format, so the concat demuxer can stitch the narration without
// re-encoding and every duration is measured off the file that actually plays.
async function normalizeVoiceClips(workDir, clips, ext) {
  const files = [];
  const durations = [];

  for (let i = 0; i < clips.length; i++) {
    const raw = path.join(workDir, `voice-raw-${i}.${ext}`);
    const out = path.join(workDir, `voice-${i}.wav`);
    fs.writeFileSync(raw, clips[i]);
    await ffmpeg([
      '-y', '-i', raw,
      // Trim the dead air providers leave on the head and tail, otherwise the
      // pauses we place ourselves land on top of theirs. Done as head-trim →
      // reverse → head-trim → reverse, so pauses INSIDE the line — the commas
      // that make the delivery sound human — are left alone.
      '-af',
      'silenceremove=start_periods=1:start_silence=0.06:start_threshold=-45dB,areverse,' +
      'silenceremove=start_periods=1:start_silence=0.10:start_threshold=-45dB,areverse,' +
      'aresample=48000',
      '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le',
      out,
    ]);
    files.push(out);
    durations.push(await ffprobeDuration(out));
  }

  return { files, durations };
}

async function makeSilence(workDir, duration, tag) {
  const out = path.join(workDir, `silence-${tag}.wav`);
  await ffmpeg([
    '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-t', String(round(duration)), '-c:a', 'pcm_s16le', out,
  ]);
  return out;
}

// ── 2 · narration ──────────────────────────────────────────────────────────

async function buildNarration(workDir, segments, voiceFiles) {
  const entries = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.type === 'voice') {
      entries.push(voiceFiles[seg.index]);
    } else if (seg.duration > 0.01) {
      entries.push(await makeSilence(workDir, seg.duration, i));
    }
  }

  const listPath = path.join(workDir, 'narration.txt');
  fs.writeFileSync(listPath, entries.map(f => `file '${f}'`).join('\n') + '\n');

  const out = path.join(workDir, 'narration.wav');
  await ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', out]);
  return out;
}

// ── 3 · shot clips ─────────────────────────────────────────────────────────

// The Ken Burns move for one shot, as a zoompan expression over a known frame
// count. `frames` is fixed here in JS so the expressions can use a literal
// end point instead of zoompan's (unavailable) total-frame variable.
function motionFilter(motion, frames) {
  const n = Math.max(1, frames - 1);
  const p = `on/${n}`;
  const cx = `iw/2-(iw/zoom/2)`;
  const cy = `ih/2-(ih/zoom/2)`;

  let z = '1.0';
  let x = cx;
  let y = cy;

  // Pans hold a fixed zoom so the whole move is travel; the extra headroom
  // (1.22) is what they travel across.
  const PAN_ZOOM = '1.22';

  switch (motion) {
    case 'pull-out':
      z = `1.18-0.18*${p}`;
      break;
    case 'pan-left':
      z = PAN_ZOOM;
      x = `(iw-iw/zoom)*(1-${p})`;
      break;
    case 'pan-right':
      z = PAN_ZOOM;
      x = `(iw-iw/zoom)*(${p})`;
      break;
    case 'pan-up':
      z = PAN_ZOOM;
      y = `(ih-ih/zoom)*(1-${p})`;
      break;
    case 'pan-down':
      z = PAN_ZOOM;
      y = `(ih-ih/zoom)*(${p})`;
      break;
    case 'push-in':
    default:
      z = `1.0+0.18*${p}`;
      break;
  }

  return (
    `scale=${SRC_W}:${SRC_H}:force_original_aspect_ratio=increase,` +
    `crop=${SRC_W}:${SRC_H},` +
    `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${W}x${H}:fps=${FPS},` +
    `setsar=1,format=yuv420p`
  );
}

// A clip is rendered long enough to cover its own time on screen PLUS the
// transition that brings it in, because xfade consumes that overlap from the
// outgoing clip. See the offset maths in chainShots().
async function renderShotClip(workDir, shot, index, imagePath) {
  const length = shot.duration + (shot.transitionDuration || 0);
  const frames = Math.max(2, Math.round(length * FPS));
  const out = path.join(workDir, `clip-${String(index).padStart(2, '0')}.mp4`);

  await ffmpeg([
    '-y',
    '-loop', '1', '-framerate', String(FPS), '-i', imagePath,
    '-vf', motionFilter(shot.motion, frames),
    '-frames:v', String(frames),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-an',
    out,
  ]);

  return out;
}

// ── 4 · montage ────────────────────────────────────────────────────────────

// Chain the clips with xfade. With clip i rendered at (dᵢ + Tᵢ) and the i-th
// transition offset at (Sᵢ − Tᵢ), every shot lands on screen at exactly its
// planned start Sᵢ and the montage comes out at Σdᵢ — the narration's length.
async function chainShots(workDir, clipFiles, shots) {
  const out = path.join(workDir, 'montage.mp4');

  if (clipFiles.length === 1) {
    fs.copyFileSync(clipFiles[0], out);
    return out;
  }

  const args = ['-y'];
  for (const file of clipFiles) args.push('-i', file);

  const parts = [];
  let last = '[0:v]';
  let planned = shots[0].duration;

  for (let i = 1; i < clipFiles.length; i++) {
    const t = shots[i].transitionDuration;
    const offset = Math.max(0, planned - t);
    const label = i === clipFiles.length - 1 ? '[vout]' : `[v${i}]`;
    const type = XFADE[shots[i].transition] || 'fade';

    parts.push(
      `${last}[${i}:v]xfade=transition=${type}:duration=${round(t)}:offset=${round(offset)}${label}`
    );
    last = label;
    planned += shots[i].duration;
  }

  args.push(
    '-filter_complex', parts.join(';'),
    '-map', '[vout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an',
    out
  );

  await ffmpeg(args, { timeout: 900000 });
  return out;
}

// ── 5 · captions + brand ───────────────────────────────────────────────────

// Overlay the timed layers — the Lora headlines on their line's timing, and
// the photo credit over the opening shot — plus the rally.news mark that stays
// up for the whole reel. Each timed layer fades its alpha in and out so it
// arrives with the cut rather than snapping on.
// `overlays` is [{ file, start, end }] in the order they should stack.
async function overlayTimedLayers(workDir, montagePath, overlays, brandFile, duration) {
  const out = path.join(workDir, 'main.mp4');

  const args = ['-y', '-i', montagePath];
  if (brandFile) args.push('-loop', '1', '-i', brandFile);
  for (const layer of overlays) args.push('-loop', '1', '-i', layer.file);

  const overlayInputBase = brandFile ? 2 : 1;
  const parts = [];
  let last = '[0:v]';

  if (brandFile) {
    parts.push(`${last}[1:v]overlay=0:0:format=auto[b0]`);
    last = '[b0]';
  }

  overlays.forEach((layer, i) => {
    const input = overlayInputBase + i;
    const fadeOut = Math.max(layer.start + 0.05, layer.end - CAPTION_FADE);
    parts.push(
      `[${input}:v]format=rgba,` +
      `fade=t=in:st=${round(layer.start)}:d=${CAPTION_FADE}:alpha=1,` +
      `fade=t=out:st=${round(fadeOut)}:d=${CAPTION_FADE}:alpha=1[c${i}]`
    );
    const label = i === overlays.length - 1 ? '[vout]' : `[o${i}]`;
    parts.push(
      `${last}[c${i}]overlay=0:0:format=auto:` +
      `enable='between(t,${round(Math.max(0, layer.start - 0.05))},${round(layer.end + 0.05)})'${label}`
    );
    last = label;
  });

  if (!overlays.length) {
    // Nothing to relabel through the overlay chain — rename the last link.
    parts.push(`${last}null[vout]`);
  }

  args.push(
    '-filter_complex', parts.join(';'),
    '-map', '[vout]',
    '-t', String(round(duration)),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an',
    out
  );

  await ffmpeg(args, { timeout: 900000 });
  return out;
}

// ── 6 · the Follow Us ending ───────────────────────────────────────────────

// The closing card comes out of R2 as an MP4 (or, if that's missing, as a
// rendered still). Its own audio is dropped: the reel's music carries straight
// through the ending.
async function prepareOutro(workDir, outroVideoPath, outroStillPath, stillDuration = 3.2) {
  const out = path.join(workDir, 'outro.mp4');

  if (outroVideoPath) {
    await ffmpeg([
      '-y', '-i', outroVideoPath,
      '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
             `fps=${FPS},setsar=1,format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-an',
      out,
    ]);
  } else {
    await ffmpeg([
      '-y', '-loop', '1', '-framerate', String(FPS), '-i', outroStillPath,
      '-vf', `scale=${W}:${H},setsar=1,format=yuv420p`,
      '-t', String(stillDuration),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-an',
      out,
    ]);
  }

  return { path: out, duration: await ffprobeDuration(out) };
}

async function appendOutro(workDir, mainPath, mainDuration, outro) {
  const out = path.join(workDir, 'video.mp4');
  const dissolve = Math.min(OUTRO_DISSOLVE, mainDuration * 0.5, outro.duration * 0.5);
  const offset = Math.max(0, mainDuration - dissolve);

  await ffmpeg([
    '-y', '-i', mainPath, '-i', outro.path,
    '-filter_complex',
    `[0:v][1:v]xfade=transition=fade:duration=${round(dissolve)}:offset=${round(offset)}[vout]`,
    '-map', '[vout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an',
    out,
  ], { timeout: 900000 });

  return { path: out, duration: mainDuration + outro.duration - dissolve };
}

// ── 7 · audio ──────────────────────────────────────────────────────────────

// Both buses are brought to VOICE_LUFS with loudnorm before the offsets above
// are applied, so "40% quieter" holds regardless of how hot the TTS output or
// the chosen CC track happens to be. loudnorm resamples internally, hence the
// aresample straight after it.
const NORM = `loudnorm=I=${VOICE_LUFS}:TP=-1.5:LRA=11,aresample=48000`;

async function buildAudio(workDir, narrationPath, musicPath, totalDuration, voiceEndsAt) {
  const out = path.join(workDir, 'audio.wav');
  const total = round(totalDuration);

  if (!musicPath) {
    await ffmpeg([
      '-y', '-i', narrationPath,
      '-af', `${NORM},apad=whole_dur=${total},atrim=0:${total},alimiter=limit=0.95`,
      '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le',
      out,
    ]);
    return out;
  }

  const rampEnd = round(Math.min(totalDuration, voiceEndsAt + MUSIC_RAMP));
  const ve = round(voiceEndsAt);
  // Hold the bed under the voice, then ride it up across MUSIC_RAMP seconds
  // once the narration is done and the Follow Us card is on screen.
  const volume =
    `if(lt(t,${ve}),${MUSIC_UNDER_VOICE},` +
    `if(gt(t,${rampEnd}),${MUSIC_UNDER_OUTRO},` +
    `${MUSIC_UNDER_VOICE}+${round(MUSIC_UNDER_OUTRO - MUSIC_UNDER_VOICE)}*(t-${ve})/${MUSIC_RAMP}))`;

  const fadeOutStart = round(Math.max(0, totalDuration - 1.4));

  await ffmpeg([
    '-y',
    '-i', narrationPath,
    '-stream_loop', '-1', '-i', musicPath,
    '-filter_complex',
    `[0:a]aformat=sample_rates=48000:channel_layouts=stereo,${NORM},` +
    `apad=whole_dur=${total},atrim=0:${total},asetpts=N/SR/TB[nar];` +
    // The music is trimmed to length BEFORE loudnorm so the normalisation
    // measures the stretch that actually plays, not the whole looped stream.
    `[1:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:${total},asetpts=N/SR/TB,${NORM},` +
    `atrim=0:${total},asetpts=N/SR/TB,` +
    `volume='${volume}':eval=frame,` +
    `afade=t=in:st=0:d=1.2,afade=t=out:st=${fadeOutStart}:d=1.4[mus];` +
    `[nar][mus]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`,
    '-map', '[aout]',
    '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le',
    out,
  ], { timeout: 300000 });

  return out;
}

// ── 8 · mux ────────────────────────────────────────────────────────────────

async function mux(workDir, videoPath, audioPath) {
  const out = path.join(workDir, 'reel.mp4');
  await ffmpeg([
    '-y', '-i', videoPath, '-i', audioPath,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', '-shortest',
    out,
  ]);
  return out;
}

module.exports = {
  normalizeVoiceClips,
  buildNarration,
  renderShotClip,
  chainShots,
  overlayTimedLayers,
  prepareOutro,
  appendOutro,
  buildAudio,
  mux,
  motionFilter,
  FPS,
  W,
  H,
};
