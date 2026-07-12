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

// Resolve a possibly-relative image URL against the page it came from.
function absolutize(url, base) {
  if (!url) return null;
  let u = url.trim();
  if (u.startsWith('//')) return 'https:' + u;
  try {
    return new URL(u, base).href;
  } catch {
    return u;
  }
}

// Pull the featured image out of the article page — the <img> tagged with the
// class "rv-figure-img". Handles class lists in any order and lazy-loaded
// images (src / data-src / srcset). This is the authoritative cover source.
function extractFigureImage(html, base) {
  // Find each <img ...> and keep the one whose class list contains the token.
  const imgTags = html.match(/<img\b[^>]*>/gi) || [];
  for (const tag of imgTags) {
    const cls = tag.match(/\bclass\s*=\s*["']([^"']*)["']/i);
    if (!cls || !/\brv-figure-img\b/.test(cls[1])) continue;

    // Candidate URLs in priority order. Lazy-loaded images often carry a tiny
    // data: placeholder in src and the real URL in data-src/srcset, so skip
    // data: URIs and take the first real one.
    const srcsetFirst = (attr) => {
      const v = (tag.match(new RegExp(`\\b${attr}\\s*=\\s*["']([^"']+)["']`, 'i')) || [])[1];
      return v ? v.split(',')[0].trim().split(/\s+/)[0] : null;
    };
    const candidates = [
      (tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1],
      (tag.match(/\bdata-src\s*=\s*["']([^"']+)["']/i) || [])[1],
      (tag.match(/\bdata-lazy-src\s*=\s*["']([^"']+)["']/i) || [])[1],
      srcsetFirst('srcset'),
      srcsetFirst('data-srcset'),
    ];
    const pick = candidates.find(u => u && !u.startsWith('data:'));
    if (pick) return absolutize(pick, base);
  }
  return null;
}

async function fetchArticleHtml(url) {
  const res = await axios.get(url, {
    timeout: 20000,
    maxContentLength: 10 * 1024 * 1024,
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    responseType: 'text',
  });
  return res.data;
}

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

// Resolve the cover photo for the story as a data: URI.
// Primary (and intended) source: the article page's featured image, i.e. the
// <img class="rv-figure-img"> on the story's rally.news URL. Falls back to the
// feed image, then the page's og:image, then a brand card — only if the tagged
// image genuinely can't be found or downloaded.
async function getCoverImage(story) {
  if (story.url) {
    let html = null;
    try {
      html = await fetchArticleHtml(story.url);
    } catch (err) {
      console.warn(`  [cover] could not fetch article page: ${err.message}`);
    }

    if (html) {
      const figureUrl = extractFigureImage(html, story.url);
      const fromFigure = await toDataUri(figureUrl);
      if (fromFigure) {
        console.log(`  [cover] using article rv-figure-img (${figureUrl})`);
        return fromFigure;
      }
      console.warn('  [cover] rv-figure-img not found/downloadable — trying fallbacks');

      // og:image is only meaningful on non-rally pages (rally.news serves the
      // brand card as og:image).
      let ogUrl = extractOgImage(html);
      ogUrl = ogUrl ? absolutize(ogUrl, story.url) : null;
      if (ogUrl && !/(^|\.)rally\.news$/i.test(new URL(story.url).hostname)) {
        const fromOg = await toDataUri(ogUrl);
        if (fromOg) {
          console.log('  [cover] using article og:image');
          return fromOg;
        }
      }
    }
  }

  const fromFeed = await toDataUri(story.thumbnail);
  if (fromFeed) {
    console.log('  [cover] using feed image');
    return fromFeed;
  }

  console.warn('  [cover] no article image found — using brand fallback');
  return FALLBACK;
}

module.exports = { getCoverImage, extractFigureImage };
