const axios = require('axios');
const FormData = require('form-data');

const TG_BASE = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendDailyVideo(videoUrl, caption, tweet, story) {
  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long'
  });

  // Message 1: header + caption (easy to copy)
  const captionMessage =
    `📱 *Rally News Daily — ${today}*\n\n` +
    `*Story:* ${story.headline}\n` +
    `*Source:* ${story.publisher}\n\n` +
    `━━━━━━━━━━━━━━━\n` +
    `*📋 CAPTION TO COPY:*\n\n` +
    `${caption}\n\n` +
    `━━━━━━━━━━━━━━━\n` +
    `*Story link:* ${story.url}`;

  await axios.post(`${TG_BASE}/sendMessage`, {
    chat_id: CHAT_ID,
    text: captionMessage,
    parse_mode: 'Markdown'
  });

  // Message 2: the video file (save to camera roll, then post to Instagram)
  await axios.post(`${TG_BASE}/sendVideo`, {
    chat_id: CHAT_ID,
    video: videoUrl,
    caption: '⬆️ Save this video to your camera roll, then post to Instagram with the caption above.'
  });

  // Message 3: Twitter/X copy
  const tweetMessage =
    `🐦 *TWEET TO COPY:*\n\n` +
    `${tweet}\n\n` +
    `🔗 ${story.url}`;

  await axios.post(`${TG_BASE}/sendMessage`, {
    chat_id: CHAT_ID,
    text: tweetMessage,
    parse_mode: 'Markdown'
  });

  console.log('  Telegram messages sent ✓');
}

module.exports = { sendDailyVideo };
