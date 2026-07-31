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
    `*Music:* ${reel.track || '(none — voice only)'}` +
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

module.exports = { proofLine, reelSummary, checkLine, sourceLines, slideLines };
