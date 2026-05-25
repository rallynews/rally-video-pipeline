const axios = require('axios');

async function generateScriptAndCaption(story) {
  const response = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model: 'mistralai/mistral-small-3.1-24b-instruct-2503',
      max_tokens: 300,
      messages: [
        {
          role: 'system',
          content: `You write short UGC video scripts and Instagram captions for Rally News,
a positive news aggregator. Tone: warm, genuine, straight-to-camera —
like a real woman in her early 50s sharing great news with a friend.
No intro phrases like Hi, Hey, or Hello. and then continue to a description of the positive news. Return valid JSON only, no extra text.`
        },
        {
          role: 'user',
          content: `Story headline: "${story.headline}"
Story summary: "${story.summary}"
Publisher: ${story.publisher}

Return a JSON object with exactly these two fields:
{
  "script": "A natural spoken script for a 10–15 second straight-to-camera video. Maximum 40 words. Always start with an excited "Good News!" End with: link in the comments.",
  "caption": "An Instagram caption. Two sentences maximum. Warm and conversational, written for women in their 50s and 60s. Ends with: Full story in comments 👇 #goodnews #rallynews #positivenews"
}`
        }
      ]
    },
    {
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://rallynews.com',
        'X-Title': 'Rally News Pipeline'
      }
    }
  );

  return JSON.parse(response.data.choices[0].message.content);
}

module.exports = { generateScriptAndCaption };
