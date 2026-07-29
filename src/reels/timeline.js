const { pickImage } = require('./r2-catalogue');

// Turns the shot plan plus the REAL measured length of every voice clip into
// an edit: when each line is spoken, when each caption is up, and exactly how
// long each image is on screen. Nothing here estimates speech rate — the voice
// that plays is the voice that was measured.

const LEAD_IN = 0.3;   // beat of music before the first word
const TAIL = 0.6;      // beat after the last word, before the Follow Us card

// Longest an image may sit on screen. Anything longer gets split into two
// shots so the picture keeps moving "every second or two".
const MAX_SHOT = 2.6;
const MIN_SHOT = 0.7;
const HARD_MAX_SHOTS = 25;

const TRANSITION_LENGTHS = {
  'cut': 0.06,
  'whip-left': 0.2,
  'whip-right': 0.2,
  'dissolve': 0.35,
  'flash': 0.18,
  'zoom-punch': 0.3,
};

// A natural pause after each line, taken from how the line ends.
function gapAfter(text) {
  const last = String(text || '').trim().slice(-1);
  if (last === '?') return 0.34;
  if (last === '.' || last === '!') return 0.28;
  if (last === ',' || last === ';' || last === '—') return 0.16;
  return 0.2;
}

// Split any shot that outstays MAX_SHOT into two, giving the back half a fresh
// image so the cut lands on something new rather than re-holding the same one.
function densify(shots, catalogue) {
  const used = new Set(shots.map(s => s.key));

  let guard = 0;
  while (shots.length < HARD_MAX_SHOTS && guard++ < 40) {
    let longest = -1;
    for (let i = 0; i < shots.length; i++) {
      if (shots[i].duration > MAX_SHOT &&
          (longest === -1 || shots[i].duration > shots[longest].duration)) {
        longest = i;
      }
    }
    if (longest === -1) break;

    const shot = shots[longest];
    const half = shot.duration / 2;
    const key = pickImage(catalogue, shot.keywords, used, shot.key);
    if (!key) break;
    used.add(key);

    shot.duration = half;
    shots.splice(longest + 1, 0, {
      line: shot.line,
      key,
      keywords: shot.keywords,
      // Alternate the direction so a split reads as a deliberate pair.
      motion: shot.motion === 'push-in' ? 'pull-out'
        : shot.motion === 'pan-left' ? 'pan-right'
        : shot.motion === 'pan-right' ? 'pan-left'
        : 'push-in',
      transition: 'cut',
      start: shot.start + half,
      duration: half,
    });
  }

  return shots;
}

// `durations[i]` is the measured length of the voice clip for `lines[i]`.
function buildTimeline(lines, shots, durations, catalogue) {
  if (lines.length !== durations.length) {
    throw new Error(`Timeline mismatch: ${lines.length} lines vs ${durations.length} voice clips`);
  }

  // 1. Lay the narration out on the audio timeline: lead-in, then each line
  //    followed by its pause, then the tail.
  const segments = [{ type: 'silence', duration: LEAD_IN }];
  const lineTimings = [];
  let t = LEAD_IN;

  for (let i = 0; i < lines.length; i++) {
    const start = t;
    segments.push({ type: 'voice', index: i, duration: durations[i] });
    t += durations[i];
    lineTimings.push({ start, end: t });

    const gap = i === lines.length - 1 ? TAIL : gapAfter(lines[i].text);
    segments.push({ type: 'silence', duration: gap });
    t += gap;
  }

  const narrationDuration = t;

  // 2. Each line owns a span of picture that runs from the end of the previous
  //    line's span to the end of its own pause, so the cutting carries on
  //    through the breaths rather than freezing on them.
  const spans = [];
  let spanStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const gap = i === lines.length - 1 ? TAIL : gapAfter(lines[i].text);
    const spanEnd = lineTimings[i].end + gap;
    spans.push({ start: spanStart, end: spanEnd });
    spanStart = spanEnd;
  }

  // 3. Divide each span evenly between the shots the planner gave that line.
  const timed = [];
  for (let i = 0; i < lines.length; i++) {
    const mine = shots.filter(s => s.line === i);
    if (!mine.length) continue;
    const span = spans[i];
    const each = (span.end - span.start) / mine.length;
    mine.forEach((shot, k) => {
      timed.push({ ...shot, start: span.start + k * each, duration: each });
    });
  }

  // Any shot the planner assigned to a line that produced no voice clip would
  // leave a hole; guard against a zero-length edit.
  if (!timed.length) throw new Error('Timeline produced no shots');

  densify(timed, catalogue);

  // Hold a floor on very short shots, then rescale the whole run so the
  // picture lands on exactly the same length as the narration — the audio and
  // the edit must not drift apart by even a frame.
  for (const shot of timed) shot.duration = Math.max(MIN_SHOT / 2, shot.duration);
  const rawTotal = timed.reduce((sum, s) => sum + s.duration, 0);
  const scale = narrationDuration / rawTotal;

  let cursor = 0;
  for (const shot of timed) {
    shot.duration *= scale;
    shot.start = cursor;
    cursor += shot.duration;
  }
  const videoDuration = cursor;

  // 4. Transition into each shot, clamped so it can never eat more than half of
  //    either neighbouring shot.
  timed.forEach((shot, i) => {
    if (i === 0) {
      shot.transitionDuration = 0;
      return;
    }
    const wanted = TRANSITION_LENGTHS[shot.transition] ?? TRANSITION_LENGTHS.cut;
    shot.transitionDuration = Math.max(
      0.04,
      Math.min(wanted, timed[i - 1].duration * 0.5, shot.duration * 0.5)
    );
  });

  // 5. Captions ARE the narration: each line's spoken text is shown while it
  //    plays, leading it very slightly so the words are already up as the
  //    line starts. The first line gets none — it plays over the article's
  //    own photo, which carries the credit and deserves to breathe.
  const captions = lines
    .map((line, i) => ({
      text: i === 0 ? '' : line.text,
      start: Math.max(0, lineTimings[i].start - 0.1),
      end: Math.min(videoDuration, lineTimings[i].end + 0.15),
    }))
    .filter(c => c.text && c.end - c.start > 0.35);

  return {
    segments,
    lineTimings,
    shots: timed,
    captions,
    narrationDuration,
    videoDuration,
  };
}

module.exports = { buildTimeline, LEAD_IN, TAIL, MAX_SHOT, TRANSITION_LENGTHS };
