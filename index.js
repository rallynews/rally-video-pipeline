const { getMostViralStory } = require('./src/story-fetcher');
const { generateScriptAndCaption } = require('./src/script-generator');
const { generateVideo } = require('./src/video-generator');
const { sendDailyVideo } = require('./src/telegram-sender');
const axios = require('axios');

async function sendErrorAlert(error) {
  try {
    // Error alert via Telegram first (fastest)
    await axios.post(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: `⚠️ *Rally News pipeline failed*\n\n${error.message}\n\nCheck GitHub Actions for details.`,
        parse_mode: 'Markdown'
      }
    );

    // Also send email via Brevo as backup
    await axios.post(
      'https://api.brevo.com/v3/smtp/email',
      {
        sender: { name: 'Rally News Pipeline', email: 'pipeline@rallynews.com' },
        to: [{ email: process.env.ALERT_EMAIL }],
        subject: '⚠️ Rally News video pipeline failed',
        textContent: `Failed on ${new Date().toISOString()}\n\nError: ${error.message}\n\nCheck your GitHub Actions logs for details.`
      },
      { headers: { 'api-key': process.env.BREVO_API_KEY } }
    );
  } catch (e) {
    console.error('Could not send alert:', e.message);
  }
}

async function run() {
  try {
    console.log(`\n🚀 Pipeline started — ${new Date().toISOString()}\n`);

    console.log('📰 Selecting most viral story from RSS...');
    const story = await getMostViralStory();
    console.log(`   Selected: "${story.headline}"`);

    console.log('\n✍️  Writing script and caption...');
    const { script, caption } = await generateScriptAndCaption(story);
    console.log(`   Script: ${script}`);

    console.log('\n🎬 Generating video via Wan 2.6...');
    const videoUrl = await generateVideo(script);
    console.log(`   Video ready: ${videoUrl}`);

    console.log('\n📱 Sending to Telegram...');
    await sendDailyVideo(videoUrl, caption, story);

    console.log('\n✅ Done! Video and caption delivered to Telegram.\n');

  } catch (error) {
    console.error('\n❌ Pipeline failed:', error.message);
    await sendErrorAlert(error);
    process.exit(1);
  }
}

run();
