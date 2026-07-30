const { WebClient } = require('@slack/web-api');

// Slack delivery for the carousel. Requires a bot token with chat:write and
// files:write, invited to the target channel:
//   SLACK_BOT_TOKEN (xoxb-…), SLACK_CHANNEL_ID
function isConfigured() {
  return Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_CHANNEL_ID);
}

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

// Everything about the reel worth reading before posting it.
function reelSummary(reel) {
  if (!reel) return '';
  const link = reel.url ? `\n*Reel (R2):* ${reel.url}` : '';
  return (
    `\n\n🎬 *Reels / Shorts cut* — ${reel.duration.toFixed(0)}s · 1080×1920 · ` +
    `${reel.shots.length} shots · ${reel.captions.length} captions\n` +
    `*Voice:* ${reel.voice}\n` +
    `*Music:* ${reel.track || '(none — voice only)'}` +
    link +
    `\n*Script:* ${reel.script}`
  );
}

// Deliver a finished carousel to Slack.
// Message order mirrors Telegram:
//   1. The 5 images, shared with an info/header comment (story, links, sources)
//   2. The 9:16 reel, if one was built
//   3. Facebook caption ALONE (plain text — copy/paste ready)
//   4. Instagram caption ALONE (plain text — copy/paste ready)
//   5. The article link ALONE, for pasting as the first comment
async function sendCarousel({ story, pillar, style, images, captions, imageUrls, sources, verification, reel, proofreading }) {
  const client = new WebClient(process.env.SLACK_BOT_TOKEN);
  const channel = process.env.SLACK_CHANNEL_ID;

  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
  const checkLine = verification && verification.ran
    ? `\n✅ *Fact-checked* — ${verification.report.filter(r => r.verdict === 'corrected').length} field(s) rewritten after cross-referencing.`
    : '';
  const srcLines = (sources && sources.length)
    ? `\n*Corroborated with:*\n${sources.map(s => `• ${s}`).join('\n')}`
    : '';
  const urlLines = (imageUrls && imageUrls.length)
    ? `\n*Slides (R2):*\n${imageUrls.map((u, i) => `${i + 1}. ${u}`).join('\n')}`
    : '';

  const header =
    `🖼️ *Rally News Carousel — ${today}*\n` +
    `*Story:* ${story.headline}\n` +
    `*Source:* ${story.publisher}\n` +
    `*Pillar:* ${pillar}   *Style:* ${style}\n` +
    `*Link:* ${story.url}` +
    checkLine +
    proofLine(proofreading) +
    urlLines +
    srcLines +
    reelSummary(reel) +
    `\n\n⬇️ Save the images, then paste the Facebook and Instagram captions (the next two messages) straight into each app. The message after those is the article link on its own — post it as the FIRST COMMENT, not in the caption.`;

  await client.files.uploadV2({
    channel_id: channel,
    initial_comment: header,
    file_uploads: images.map((buf, i) => ({
      file: buf,
      filename: `slide-${i + 1}.png`,
    })),
  });

  if (reel) {
    await client.files.uploadV2({
      channel_id: channel,
      initial_comment: `🎬 Reels / Shorts cut — ${reel.duration.toFixed(0)}s, 1080×1920`,
      file_uploads: [{ file: reel.buffer, filename: 'rally-reel.mp4' }],
    });
  }

  // The captions and the link are posted as their own messages with mrkdwn
  // disabled, so nothing (asterisks, underscores) is reinterpreted and each
  // copies verbatim.
  for (const text of [captions.facebook, captions.instagram, captions.link || story.url]) {
    await client.chat.postMessage({
      channel, text, mrkdwn: false, unfurl_links: false, unfurl_media: false,
    });
  }

  console.log('  [slack] carousel delivered ✓');
}

module.exports = { sendCarousel, isConfigured };
