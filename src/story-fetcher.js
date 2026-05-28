const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { chatCompletion, parseJSON } = require('./openrouter');

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

  // Step 2: Ask AI to pick the most virally positive story
  const storySummaries = stories.map((item, i) => ({
    index: i,
    headline: item.title,
    summary: item.description
      ? item.description.replace(/<[^>]*>/g, '').slice(0, 200)
      : item.title
  }));

  const content = await chatCompletion({
    max_tokens: 200,
    messages: [
      {
        role: 'system',
        content: `You select the most shareable, uplifting, positive news story from a list.
Prioritise stories of worldwide or broad international interest — science, environment, health, humanity, space, animals, global policy.
Reject stories that are specific to a single city, town, local community, or country unless the impact is clearly global.
Consider: emotional impact, broad appeal, feel-good factor, and shareability.
Return only a JSON object like: {"index": 3}`
      },
      {
        role: 'user',
        content: `Which of these stories would go most viral as positive news on Instagram with a global audience?
Avoid stories that are only relevant to one specific place or country.
Return the index of the best one.

${JSON.stringify(storySummaries, null, 2)}`
      }
    ]
  });

  const result = parseJSON(content);
  const selected = stories[result.index];

  const thumbnail =
    selected['media:content']?.['@_url'] ||
    selected['media:thumbnail']?.['@_url'] ||
    selected['enclosure']?.['@_url'] ||
    null;

  return {
    headline: selected.title,
    summary: selected.description
      ? selected.description.replace(/<[^>]*>/g, '').slice(0, 600)
      : selected.title,
    publisher: selected['dc:creator'] || selected.author || 'Rally News',
    url: selected.link,
    thumbnail
  };
}

module.exports = { getMostViralStory };
