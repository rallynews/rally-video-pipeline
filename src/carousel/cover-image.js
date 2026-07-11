const axios = require('axios');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Brand-green fallback used only if no usable photo can be found anywhere.
const FALLBACK =
  'data:image/svg+xml;base64,' +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="820">` +
    `<rect width="1080" height="820" fill="#5A775E"/>` +
    `<text x="540" y="430" font-family="serif" font-size="120" font-style="italic" ` +
    `font-weight="700" fill="#F7F4EE" text-anchor="middle">R</text></svg>`
  ).toString('base64');

function extractOgImage(html) {
  const patterns = [
    /<meta[^>]+property=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::url)?["']/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

async function toDataUri(url) {
  if (!url) return null;
  try {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 20000,
      maxContentLength: 25 * 1024 * 1024,
      headers: { 'User-Agent': UA, Accept: 'image/*' },
    });
    const contentType = (res.headers['content-type'] || 'image/jpeg').split(';')[0];
    if (!contentType.startsWith('image/')) return null;
    const b64 = Buffer.from(res.data).toString('base64');
    return `data:${contentType};base64,${b64}`;
  } catch (err) {
    console.warn(`  [cover] could not download ${url}: ${err.message}`);
    return null;
  }
}

// Resolve a cover photo for the story as a data: URI.
// Order: the article's og:image (the "image from the article, pulled from the
// original source"), then the RSS thumbnail, then a brand fallback.
async function getCoverImage(story) {
  let ogUrl = null;
  if (story.url) {
    try {
      const res = await axios.get(story.url, {
        timeout: 20000,
        maxContentLength: 10 * 1024 * 1024,
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        responseType: 'text',
      });
      ogUrl = extractOgImage(res.data);
      if (ogUrl && ogUrl.startsWith('//')) ogUrl = 'https:' + ogUrl;
      if (ogUrl && ogUrl.startsWith('/')) {
        ogUrl = new URL(ogUrl, story.url).href;
      }
    } catch (err) {
      console.warn(`  [cover] could not fetch article page: ${err.message}`);
    }
  }

  const fromArticle = await toDataUri(ogUrl);
  if (fromArticle) {
    console.log('  [cover] using article og:image');
    return fromArticle;
  }

  const fromThumb = await toDataUri(story.thumbnail);
  if (fromThumb) {
    console.log('  [cover] using RSS thumbnail');
    return fromThumb;
  }

  console.warn('  [cover] no photo found — using brand fallback');
  return FALLBACK;
}

module.exports = { getCoverImage };
