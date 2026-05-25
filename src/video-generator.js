const axios = require('axios');

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
  const submitResponse = await axios.post(
    'https://openrouter.ai/api/v1/videos/generations',
    {
      model: 'alibaba/wan-2.6',
      prompt: script,
      image_url: pickAvatar(),
      duration: 15,
      aspect_ratio: '9:16',
      resolution: '720p'
    },
    { headers }
  );

  const jobId = submitResponse.data.id;
  console.log(`  Video job submitted: ${jobId}`);

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 15000));

    const statusResponse = await axios.get(
      `https://openrouter.ai/api/v1/videos/generations/${jobId}`,
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
