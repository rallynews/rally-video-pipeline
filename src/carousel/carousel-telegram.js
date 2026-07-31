const axios = require('axios');
const FormData = require('form-data');
const { proofLine, reelSummary, checkLine, sourceLines, slideLines } = require('./header-text');

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

// Telegram bots can't upload more than 50 MB. Past that the reel goes out as
// its R2 link instead of the file.
const TG_FILE_LIMIT = 49 * 1024 * 1024;

// The 9:16 Reels/Shorts cut of the same story, sent as a streamable video.
async function sendReel(reel) {
  const form = new FormData();
  form.append('chat_id', CHAT_ID);
  form.append('video', reel.buffer, { filename: 'rally-reel.mp4', contentType: 'video/mp4' });
  form.append('width', '1080');
  form.append('height', '1920');
  form.append('duration', String(Math.round(reel.duration)));
  form.append('supports_streaming', 'true');
  form.append('caption', `🎬 Reels / Shorts cut — ${reel.duration.toFixed(0)}s, 1080×1920`);
  await axios.post(`${TG_BASE}/sendVideo`, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
}

// Deliver a finished carousel to Telegram.
// Message order:
//   1. Info/header (story, source, pillar, links) — safe to skip past
//   2. The 5 images as an album
//   3. The 9:16 reel, if one was built
//   4. Facebook caption ALONE (plain text, nothing else — copy/paste ready)
//   5. Instagram caption ALONE (plain text, nothing else — copy/paste ready)
//   6. The article link ALONE, for pasting as the first comment
async function sendCarousel({ story, pillar, style, images, captions, imageUrls, sources, verification, reel, proofreading }) {
  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
  });

  const header =
    `🖼️ *Rally News Carousel — ${today}*\n\n` +
    `*Story:* ${story.headline}\n` +
    `*Source:* ${story.publisher}\n` +
    `*Pillar:* ${pillar}\n` +
    `*Style:* ${style}\n` +
    `*Link:* ${story.url}` +
    checkLine(verification) +
    proofLine(proofreading) +
    slideLines(imageUrls) +
    sourceLines(sources) +
    reelSummary(reel) +
    `\n\n⬇️ Save the images below, then paste the Facebook and Instagram captions (the next two messages) straight into each app. The message after those is the article link on its own — post it as the FIRST COMMENT, not in the caption.`;

  await sendMessage(header, 'Markdown');
  await sendAlbum(images);

  if (reel) {
    if (reel.buffer.length > TG_FILE_LIMIT) {
      await sendMessage(`🎬 The reel is ${(reel.buffer.length / 1024 / 1024).toFixed(0)} MB — too large for Telegram. Download it here: ${reel.url || '(no R2 link)'}`);
    } else {
      await sendReel(reel);
    }
  }

  // The captions and the link are sent as their OWN messages, plain text, with
  // no title or extra characters, so each can be copied verbatim on a phone.
  await sendMessage(captions.facebook);
  await sendMessage(captions.instagram);
  await sendMessage(captions.link || story.url);

  console.log('  [telegram] carousel delivered ✓');
}

module.exports = { sendCarousel };
