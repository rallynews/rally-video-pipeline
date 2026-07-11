const axios = require('axios');
const FormData = require('form-data');

const TG_BASE = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendMessage(text, parseMode) {
  const body = { chat_id: CHAT_ID, text, disable_web_page_preview: true };
  if (parseMode) body.parse_mode = parseMode;
  await axios.post(`${TG_BASE}/sendMessage`, body);
}

// Send the 5 slides as a single album so they arrive together and each can be
// saved individually.
async function sendAlbum(images) {
  const form = new FormData();
  form.append('chat_id', CHAT_ID);
  const media = images.map((_, i) => ({ type: 'photo', media: `attach://photo${i}` }));
  form.append('media', JSON.stringify(media));
  images.forEach((buf, i) => {
    form.append(`photo${i}`, buf, { filename: `slide-${i + 1}.png`, contentType: 'image/png' });
  });
  await axios.post(`${TG_BASE}/sendMediaGroup`, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
}

// Deliver a finished carousel to Telegram.
// Message order:
//   1. Info/header (story, source, pillar, links) — safe to skip past
//   2. The 5 images as an album
//   3. Facebook caption ALONE (plain text, nothing else — copy/paste ready)
//   4. Instagram caption ALONE (plain text, nothing else — copy/paste ready)
async function sendCarousel({ story, pillar, style, images, captions, imageUrls, sources }) {
  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
  });

  const srcLines = (sources && sources.length)
    ? `\n*Corroborated with:*\n${sources.map(s => `• ${s}`).join('\n')}`
    : '';
  const urlLines = (imageUrls && imageUrls.length)
    ? `\n*Slides (R2):*\n${imageUrls.map((u, i) => `${i + 1}. ${u}`).join('\n')}`
    : '';

  const header =
    `🖼️ *Rally News Carousel — ${today}*\n\n` +
    `*Story:* ${story.headline}\n` +
    `*Source:* ${story.publisher}\n` +
    `*Pillar:* ${pillar}\n` +
    `*Style:* ${style}\n` +
    `*Link:* ${story.url}` +
    urlLines +
    srcLines +
    `\n\n⬇️ Save the 5 images below, then paste the Facebook and Instagram captions (sent as separate messages) straight into each app.`;

  await sendMessage(header, 'Markdown');
  await sendAlbum(images);

  // The two captions are sent as their OWN messages, plain text, with no title
  // or extra characters, so they can be copied verbatim on a phone.
  await sendMessage(captions.facebook);
  await sendMessage(captions.instagram);

  console.log('  [telegram] carousel delivered ✓');
}

module.exports = { sendCarousel };
