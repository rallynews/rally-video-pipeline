const axios = require('axios');
const { WebClient } = require('@slack/web-api');

// Morning draft notice: a short message to Telegram and Slack with what the
// models chose and the link into the review app. Deliberately compact — the
// review page is where the detail lives.

function draftText({ draft, reviewUrl }) {
  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
  const reelLine = draft.reel
    ? `${draft.reel.wordCount} words · ${draft.reel.shots.length} shots planned`
    : 'not planned (assets or voice missing)';
  const brief = draft.researchBrief
    ? `\n\n${draft.researchBrief}`
    : '';
  const link = reviewUrl
    ? `\n\n✏️ Review and approve:\n${reviewUrl}`
    : `\n\n✏️ Review app URL unavailable — approve by copying review/pending/${draft.date}.json to review/approved/ in the repo.`;

  return (
    `📝 Rally News draft — ${today}\n\n` +
    `Story: ${draft.story.headline}\n` +
    `Source: ${draft.story.publisher}\n` +
    `Pillar: ${draft.pillar}   Style: ${draft.style}\n` +
    `Reel: ${reelLine}` +
    brief +
    link +
    `\n\nNothing is produced or posted until you approve. Edit anything on the page first, or approve as-is.`
  );
}

async function sendDraftNotice(payload) {
  const text = draftText(payload);

  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    await axios.post(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }
    );
    console.log('  [review] draft notice sent to Telegram');
  }

  if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_CHANNEL_ID) {
    try {
      const client = new WebClient(process.env.SLACK_BOT_TOKEN);
      await client.chat.postMessage({
        channel: process.env.SLACK_CHANNEL_ID,
        text,
        mrkdwn: false,
        unfurl_links: false,
        unfurl_media: false,
      });
      console.log('  [review] draft notice sent to Slack');
    } catch (e) {
      console.warn(`  [review] Slack draft notice failed (${e.message})`);
    }
  }
}

module.exports = { sendDraftNotice };
