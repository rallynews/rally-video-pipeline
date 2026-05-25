const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

function parseJSON(text) {
  if (!text) throw new Error(`Empty content from model`);
  console.log('[parseJSON] raw content:', text);
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON object found in model response: ${text.slice(0, 300)}`);
  return JSON.parse(match[0]);
}

async function getMostViralStory() {
  // Step 1: Fetch and parse the RSS feed
  const response = await axios.get(process.env.RALLY_RSS_URL, {
    headers: { 'Accept': 'application/rss+xml, application/xml, text/xml' }
  });

  const parser = new XMLParser({ ignoreAttributes: false });
  const feed = parser.parse(response.data);

  const items = feed?.rss?.channel?.item;
  if (!items) throw new Error('Could not find any items in the RSS feed');

  const stories = (Array.isArray(items) ? items : [items]).slice(0, 10);

  // Step 2: Ask Mistral to pick the most virally positive story
  const storySummaries = stories.map((item, i) => ({
    index: i,
    headline: item.title,
    summary: item.description
      ? item.description.replace(/<[^>]*>/g, '').slice(0, 200)
      : item.title
  }));

  const scoringResponse = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model: 'mistralai/mistral-small-3.1-24b-instruct-2503',
      max_tokens: 100,
      messages: [
        {
          role: 'system',
          content: `You select the most shareable, uplifting, positive news story from a list.
Consider: emotional impact, broad appeal, feel-good factor, and shareability.
Return only a JSON object like: {"index": 3}`
        },
        {
          role: 'user',
          content: `Which of these stories would go most viral as positive news on Instagram?
Return the index of the best one.

${JSON.stringify(storySummaries, null, 2)}`
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

  if (!scoringResponse.data.choices?.length) {
    throw new Error(`OpenRouter error: ${JSON.stringify(scoringResponse.data)}`);
  }
  const result = parseJSON(scoringResponse.data.choices[0].message.content);
  const selected = stories[result.index];

  return {
    headline: selected.title,
    summary: selected.description
      ? selected.description.replace(/<[^>]*>/g, '').slice(0, 300)
      : selected.title,
    publisher: selected['dc:creator'] || selected.author || 'Rally News',
    url: selected.link
  };
}

module.exports = { getMostViralStory };
