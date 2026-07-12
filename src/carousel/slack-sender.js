const { WebClient } = require('@slack/web-api');

// Slack delivery for the carousel. Requires a bot token with chat:write and
// files:write, invited to the target channel:
//   SLACK_BOT_TOKEN (xoxb-…), SLACK_CHANNEL_ID
function isConfigured() {
  return Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_CHANNEL_ID);
}

// Deliver a finished carousel to Slack.
// Message order mirrors Telegram:
//   1. The 5 images, shared with an info/header comment (story, links, sources)
//   2. Facebook caption ALONE (plain text — copy/paste ready)
//   3. Instagram caption ALONE (plain text — copy/paste ready)
async function sendCarousel({ story, pillar, style, images, captions, imageUrls, sources, verification }) {
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
    urlLines +
    srcLines +
    `\n\n⬇️ Save the 5 images, then paste the Facebook and Instagram captions (the next two messages) straight into each app.`;

  await client.files.uploadV2({
    channel_id: channel,
    initial_comment: header,
    file_uploads: images.map((buf, i) => ({
      file: buf,
      filename: `slide-${i + 1}.png`,
    })),
  });

  // The two captions are posted as their own messages with mrkdwn disabled, so
  // nothing (asterisks, underscores) is reinterpreted and they copy verbatim.
  await client.chat.postMessage({
    channel, text: captions.facebook, mrkdwn: false, unfurl_links: false, unfurl_media: false,
  });
  await client.chat.postMessage({
    channel, text: captions.instagram, mrkdwn: false, unfurl_links: false, unfurl_media: false,
  });

  console.log('  [slack] carousel delivered ✓');
}

module.exports = { sendCarousel, isConfigured };
