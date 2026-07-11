const { getMostViralStory } = require('./src/story-fetcher');
const { generateCarouselCopy } = require('./src/carousel/copy-generator');
const { getCoverImage } = require('./src/carousel/cover-image');
const { renderCarousel } = require('./src/carousel/renderer');
const { uploadCarousel } = require('./src/carousel/r2-uploader');
const { sendCarousel } = require('./src/carousel/carousel-telegram');
const { updateRSSFeed } = require('./src/rss-updater');
const axios = require('axios');

async function sendErrorAlert(error) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: `⚠️ *Rally News carousel pipeline failed*\n\n${error.message}\n\nCheck GitHub Actions for details.`,
        parse_mode: 'Markdown',
      }
    );
    if (process.env.BREVO_API_KEY && process.env.ALERT_EMAIL) {
      await axios.post(
        'https://api.brevo.com/v3/smtp/email',
        {
          sender: { name: 'Rally News Pipeline', email: 'pipeline@rallynews.com' },
          to: [{ email: process.env.ALERT_EMAIL }],
          subject: '⚠️ Rally News carousel pipeline failed',
          textContent: `Failed on ${new Date().toISOString()}\n\nError: ${error.message}\n\nCheck your GitHub Actions logs for details.`,
        },
        { headers: { 'api-key': process.env.BREVO_API_KEY } }
      );
    }
  } catch (e) {
    console.error('Could not send alert:', e.message);
  }
}

function slugify(text) {
  return String(text || 'story')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'story';
}

async function run() {
  try {
    console.log(`\n🚀 Carousel pipeline started — ${new Date().toISOString()}\n`);

    console.log('📰 Selecting most viral story from RSS...');
    const story = await getMostViralStory();
    console.log(`   Selected: "${story.headline}"`);

    console.log('\n✍️  Researching story and writing carousel copy...');
    const { pillar, slideCopy, captions, sources } = await generateCarouselCopy(story);
    console.log(`   Pillar: ${pillar}`);
    console.log(`   Headline: ${slideCopy.headline}`);
    console.log(`   Sources: ${sources.length ? sources.join(', ') : '(none returned)'}`);

    console.log('\n🖼️  Fetching cover image...');
    const coverUri = await getCoverImage(story);

    console.log('\n🎨 Rendering 5 carousel slides...');
    const { style, images } = await renderCarousel(slideCopy, coverUri);
    console.log(`   Rendered ${images.length} slides in style ${style}`);

    console.log('\n☁️  Uploading slides to Cloudflare R2...');
    let imageUrls = [];
    try {
      imageUrls = await uploadCarousel(images, slugify(story.headline));
    } catch (e) {
      console.warn(`   R2 upload failed (${e.message}) — continuing with Telegram delivery only.`);
    }

    console.log('\n📱 Sending carousel to Telegram...');
    await sendCarousel({ story, pillar, style, images, captions, imageUrls, sources });

    console.log('\n📡 Updating RSS feed...');
    updateRSSFeed(story);

    console.log('\n✅ Done! 5 slides, Facebook copy, and Instagram copy delivered to Telegram.\n');
  } catch (error) {
    console.error('\n❌ Carousel pipeline failed:', error.message);
    await sendErrorAlert(error);
    process.exit(1);
  }
}

run();
