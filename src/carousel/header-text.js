// Shared fragments of the delivery header.
//
// Telegram and Slack post the same information with the same Markdown-ish
// emphasis, and these builders used to exist as hand-maintained copies in both
// senders. They drifted — a proofread line was added to one file's header and
// its function to the other's — and the mismatch only surfaced at delivery
// time, after a full render and reel build had already been paid for. One
// definition, imported twice, is the fix.

// What the post-edit proofread changed, if it ran. Silence when it found
// nothing — a clean pass is not news.
function proofLine(proofreading) {
  if (!proofreading || !proofreading.ran) return '';
  const fixed = (proofreading.changes || []).length;
  const kept = (proofreading.rejected || []).length;
  if (!fixed && !kept) return '\n📝 *Proofread* — no spelling or grammar errors in your edits.';

  const parts = [];
  if (fixed) {
    parts.push(
      `\n📝 *Proofread* — ${fixed} fix(es) after your edits:\n` +
      proofreading.changes.map(c => `• ${c.field}: "${c.before}" → "${c.after}"`).join('\n')
    );
  }
  if (kept) {
    parts.push(`\n⚠️ ${kept} suggested change(s) looked like a rewrite, not a fix — your text was kept.`);
  }
  return parts.join('');
}

// Everything about the reel worth reading before posting it: how long it runs,
// how it was cut, the voice, the music, and the script it speaks.
function reelSummary(reel) {
  if (!reel) return '';
  const link = reel.url ? `\n*Reel (R2):* ${reel.url}` : '';
  const hook = reel.hook ? `\n*Opening headline:* ${reel.hook}` : '';
  return (
    `\n\n🎬 *Reels / Shorts cut* — ${reel.duration.toFixed(0)}s · 1080×1920 · ` +
    `${reel.shots.length} shots · ${reel.captions.length} captions\n` +
    `*Voice:* ${reel.voice}\n` +
    `*Music:* ${reel.track || (reel.musicMuted ? '(muted in review — voice only)' : '(none — voice only)')}` +
    hook +
    link +
    `\n*Script:* ${reel.script}`
  );
}

// The fact-check verdict summary.
function checkLine(verification) {
  if (!verification || !verification.ran) return '';
  const corrected = (verification.report || []).filter(r => r.verdict === 'corrected').length;
  return `\n✅ *Fact-checked* — ${corrected} field(s) rewritten after cross-referencing.`;
}

function sourceLines(sources) {
  return (sources && sources.length)
    ? `\n*Corroborated with:*\n${sources.map(s => `• ${s}`).join('\n')}`
    : '';
}

function slideLines(imageUrls) {
  return (imageUrls && imageUrls.length)
    ? `\n*Slides (R2):*\n${imageUrls.map((u, i) => `${i + 1}. ${u}`).join('\n')}`
    : '';
}

// Telegram's legacy Markdown parser rejects the ENTIRE message with HTTP 400
// when an emphasis character is unbalanced — and this header interpolates
// arbitrary text: story headlines, URLs, proofread diffs, and voice names like
// `casual_female`, which carries exactly one underscore. That single character
// lost a whole day's delivery.
//
// The emphasis is cosmetic, so the Telegram copy is sent as plain text with
// the markers stripped and no parse_mode at all. That makes the failure
// impossible rather than merely unlikely. Slack keeps the markers: its mrkdwn
// renders an unmatched character literally instead of failing the request.
function toPlainText(markdown) {
  return String(markdown == null ? '' : markdown).replace(/\*/g, '');
}

// Telegram caps a message at 4096 characters and answers 400 past it. Split on
// paragraph, then line, then hard — a header that grows past the cap should
// arrive in two parts rather than not at all.
const TELEGRAM_LIMIT = 4096;

function chunk(text, limit = TELEGRAM_LIMIT) {
  const source = String(text == null ? '' : text);
  if (source.length <= limit) return [source];

  const parts = [];
  let rest = source;

  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // Prefer the last paragraph break, then the last line break, then give up
    // and cut at the limit.
    let cut = window.lastIndexOf('\n\n');
    if (cut < limit * 0.5) cut = window.lastIndexOf('\n');
    if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

module.exports = {
  proofLine, reelSummary, checkLine, sourceLines, slideLines,
  toPlainText, chunk, TELEGRAM_LIMIT,
};
