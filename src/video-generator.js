const axios = require('axios');
const { describeBackground } = require('./backgrounds');

const VIDEO_MODELS = [
  'alibaba/wan-2.7',
  'kwaivgi/kling-video-o1',
  'kwaivgi/kling-v3.0-std',
];

const headers = {
  'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
  'Content-Type': 'application/json',
  'HTTP-Referer': 'https://rallynews.com',
  'X-Title': 'Rally News Pipeline'
};

// The character presenting the news rotates every day. Each entry is a full
// physical description so the video can be generated from scratch, prompt-only,
// with no reference image.
const CHARACTERS = [
  'a white woman in her early 50s with a friendly face',
  'a Latina woman in her 30s, a warm soccer mom',
  'a chubby Black woman around 45 years old with a bright smile',
  'a Chinese American woman in her mid-20s, a grad student with glasses',
  'a blonde college girl, 19 years old',
  'an Indian American grandmother, 68 years old, with silver hair',
  'an Arabic woman around 55 years old with an elegant look',
];

// Occasional splashes of extra color. An empty entry keeps the natural look so
// videos don't all look the same — colour is added "sometimes", not always.
const COLOR_VARIATIONS = [
  '',
  '',
  'The whole scene is vibrant and colorful with bright, saturated tones. ',
  'They wear a bright, colorful outfit that pops against the background. ',
  'Warm golden-hour lighting fills the frame with rich, colorful tones. ',
];

function pickCharacter() {
  const dayOfYear = Math.floor(Date.now() / 86400000);
  return CHARACTERS[dayOfYear % CHARACTERS.length];
}

function buildPrompt(script, backgroundKey) {
  const character = pickCharacter();
  const background = describeBackground(backgroundKey);
  const color = COLOR_VARIATIONS[Math.floor(Math.random() * COLOR_VARIATIONS.length)];

  return (
    `${character}, ${background}, speaking directly to camera with a warm, excited smile. ` +
    color +
    `Authentic talking-head UGC selfie-cam style, natural head and facial movements, English language. ` +
    `Single continuous uncut shot, no cuts, no multiple angles, no scene changes. ` +
    `Vertical 9:16 portrait, realistic, well-lit. ` +
    `Audio: only the character's spoken dialogue and quiet ambient background noise. No music, no background score, no soundtrack. ` +
    `They say exactly: "${script}"`
  );
}

async function generateVideo(script, backgroundKey) {
  const prompt = buildPrompt(script, backgroundKey);
  console.log(`  Video prompt: ${prompt}`);
  let jobId = null;
  let lastError;

  for (const model of VIDEO_MODELS) {
    try {
      console.log(`  Trying video model: ${model}`);
      const submitResponse = await axios.post(
        'https://openrouter.ai/api/v1/videos',
        {
          model,
          prompt,
          duration: 10,
          aspect_ratio: '9:16',
          resolution: '720p'
        },
        { headers }
      );
      jobId = submitResponse.data.id;
      console.log(`  Video job submitted with ${model}: ${jobId}`);
      break;
    } catch (err) {
      lastError = err;
      console.warn(`  ${model} failed (${err.response?.status ?? err.message}), trying next...`);
    }
  }

  if (!jobId) throw lastError || new Error('All video models failed to submit');

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 15000));

    const statusResponse = await axios.get(
      `https://openrouter.ai/api/v1/videos/${jobId}`,
      { headers }
    );

    const { status, unsigned_urls } = statusResponse.data;
    console.log(`  Poll ${i + 1}: ${status}`);

    if (status === 'failed') throw new Error(`Video generation failed: ${jobId}`);

    if ((status === 'completed' || status === 'succeeded') && unsigned_urls?.[0]) {
      const videoUrl = unsigned_urls[0];
      console.log(`  Downloading video...`);
      const download = await axios.get(videoUrl, {
        headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` },
        responseType: 'arraybuffer'
      });
      return Buffer.from(download.data);
    }
  }

  throw new Error('Video generation timed out after 15 minutes');
}

module.exports = { generateVideo };
