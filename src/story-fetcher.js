const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { chatCompletion, parseJSON } = require('./openrouter');

// Edit this list to boost stories about specific subjects during selection.
// Stories matching any of these subjects will be prioritised over others.
const PRIORITY_SUBJECTS = [
  'celebrities',
  'space',
];

// Pull a URL out of an RSS image node that may be a single object or an array
// of them. Prefers entries that look like images.
function urlFromMediaNode(node) {
  if (!node) return null;
  const list = Array.isArray(node) ? node : [node];
  const isImage = (n) => {
    const type = n['@_type'] || '';
    const medium = n['@_medium'] || '';
    return medium === 'image' || type.startsWith('image') || (!type && !medium);
  };
  const pick = list.find((n) => n && n['@_url'] && isImage(n)) ||
    list.find((n) => n && n['@_url']);
  return pick ? pick['@_url'] : null;
}

// Find the article's image across the tag shapes RSS feeds use for it:
// media:content, media:thumbnail, media:group, enclosure, or the first <img>
// embedded in the description / content:encoded.
function extractThumbnail(item) {
  const group = item['media:group'] || {};
  const candidate =
    urlFromMediaNode(item['media:content']) ||
    urlFromMediaNode(group['media:content']) ||
    urlFromMediaNode(item['media:thumbnail']) ||
    urlFromMediaNode(group['media:thumbnail']) ||
    urlFromMediaNode(item['enclosure']);
  if (candidate) return candidate;

  const html = item['content:encoded'] || item.description || '';
  const img = String(html).match(/<img[^>]+src=["']([^"']+)["']/i);
  return img ? img[1] : null;
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

  // Step 2: Ask AI to pick the most virally positive story
  const storySummaries = stories.map((item, i) => ({
    index: i,
    headline: item.title,
    summary: item.description
      ? item.description.replace(/<[^>]*>/g, '').slice(0, 200)
      : item.title
  }));

  const priorityNote = PRIORITY_SUBJECTS.length > 0
    ? `PRIORITY: If any story is about one of these subjects, strongly prefer it over others: ${PRIORITY_SUBJECTS.join(', ')}.`
    : '';

  const content = await chatCompletion({
    max_tokens: 200,
    messages: [
      {
        role: 'system',
        content: `You select the most shareable, uplifting, positive news story from a list.
${priorityNote}
Prioritise stories of worldwide or broad international interest — science, environment, health, humanity, space, animals, global policy.
Reject stories that are specific to a single city, town, local community, or country unless the impact is clearly global.
Consider: emotional impact, broad appeal, feel-good factor, and shareability.
Return only a JSON object like: {"index": 3}`
      },
      {
        role: 'user',
        content: `Which of these stories would go most viral as positive news on Instagram with a global audience?
Avoid stories that are only relevant to one specific place or country.
${priorityNote}
Return the index of the best one.

${JSON.stringify(storySummaries, null, 2)}`
      }
    ]
  });

  const result = parseJSON(content);
  const selected = stories[result.index];

  const thumbnail = extractThumbnail(selected);

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

module.exports = { getMostViralStory, extractThumbnail };
