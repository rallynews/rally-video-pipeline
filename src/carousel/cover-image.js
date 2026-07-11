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

// rally.news article pages serve the Rally brand card as their og:image, so
// scraping og:image from them yields the logo, not the story photo. The real
// article image is the one carried in the feed item (story.thumbnail).
function isRallyUrl(url) {
  try {
    return /(^|\.)rally\.news$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Resolve a cover photo for the story as a data: URI.
// Order: the image included in the feed item for this article
// (story.thumbnail), then — only for non-rally.news links — the article's
// og:image, then a brand fallback.
async function getCoverImage(story) {
  const fromFeed = await toDataUri(story.thumbnail);
  if (fromFeed) {
    console.log('  [cover] using feed image');
    return fromFeed;
  }

  if (story.url && !isRallyUrl(story.url)) {
    let ogUrl = null;
    try {
      const res = await axios.get(story.url, {
        timeout: 20000,
        maxContentLength: 10 * 1024 * 1024,
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        responseType: 'text',
      });
      ogUrl = extractOgImage(res.data);
      if (ogUrl && ogUrl.startsWith('//')) ogUrl = 'https:' + ogUrl;
      if (ogUrl && ogUrl.startsWith('/')) ogUrl = new URL(ogUrl, story.url).href;
    } catch (err) {
      console.warn(`  [cover] could not fetch article page: ${err.message}`);
    }
    const fromArticle = await toDataUri(ogUrl);
    if (fromArticle) {
      console.log('  [cover] using article og:image');
      return fromArticle;
    }
  }

  console.warn('  [cover] no feed image found — using brand fallback');
  return FALLBACK;
}

module.exports = { getCoverImage };
