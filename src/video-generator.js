const axios = require('axios');

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

const UGC_PROMPT =
  'A woman in her early 50s speaking directly to camera with a warm, excited smile. ' +
  'Authentic talking-head UGC style, natural head and facial movements, English language. ' +
  'Vertical 9:16 portrait, realistic, well-lit indoor setting.';

function pickAvatar() {
  const avatars = [
    process.env.AVATAR_1,
    process.env.AVATAR_2,
    process.env.AVATAR_3,
    process.env.AVATAR_4
  ];
  const dayOfYear = Math.floor(Date.now() / 86400000);
  return avatars[dayOfYear % avatars.length];
}

async function generateVideo(script) {
  const avatar = pickAvatar();
  let jobId = null;
  let lastError;

  for (const model of VIDEO_MODELS) {
    try {
      console.log(`  Trying video model: ${model}`);
      const submitResponse = await axios.post(
        'https://openrouter.ai/api/v1/videos',
        {
          model,
          prompt: UGC_PROMPT,
          text: script,
          image_url: avatar,
          duration: 5,
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
