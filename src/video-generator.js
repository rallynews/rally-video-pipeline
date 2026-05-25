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
          prompt: script,
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

    const { status, video_url } = statusResponse.data;
    console.log(`  Poll ${i + 1}: ${status}`);

    if (status === 'succeeded' && video_url) return video_url;
    if (status === 'failed') throw new Error(`Video generation failed: ${jobId}`);
  }

  throw new Error('Video generation timed out after 15 minutes');
}

module.exports = { generateVideo };
