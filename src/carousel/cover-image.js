const axios = require('axios');
const puppeteer = require('puppeteer');

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
  const u = url.trim();
  if (u.startsWith('//')) return 'https:' + u;
  try {
    return new URL(u, base).href;
  } catch {
    return u;
  }
}

// The rally.news article pages are a client-rendered SPA: /script.js reads the
// ?article= param and injects the article (and its featured <img class=
// "rv-figure-img">) into the DOM after load. A plain HTTP GET only sees the
// empty shell, so we render the page in a headless browser, wait for the
// featured image, and read its resolved URL.
async function figureUrlViaBrowser(url) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('.rv-figure-img', { timeout: 20000 });

    return await page.evaluate(() => {
      const fromEl = (el) => {
        if (!el) return null;
        if (el.tagName === 'IMG') {
          return el.currentSrc || el.src || el.getAttribute('data-src') || null;
        }
        const bg = getComputedStyle(el).backgroundImage;
        const m = bg && bg.match(/url\(["']?([^"')]+)["']?\)/);
        if (m) return m[1];
        const img = el.querySelector('img');
        return img ? (img.currentSrc || img.src) : null;
      };
      return fromEl(
        document.querySelector('img.rv-figure-img') ||
        document.querySelector('.rv-figure-img')
      );
    });
  } finally {
    await browser.close();
  }
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
// Primary source: the article's featured image (<img class="rv-figure-img">)
// on the story's rally.news page, read after the SPA renders it. Falls back to
// the feed image, then a brand card — only if the featured image genuinely
// can't be found or downloaded.
async function getCoverImage(story) {
  if (story.url) {
    let figUrl = null;
    try {
      figUrl = await figureUrlViaBrowser(story.url);
    } catch (err) {
      console.warn(`  [cover] rv-figure-img lookup failed: ${err.message}`);
    }
    const fromFigure = await toDataUri(absolutize(figUrl, story.url));
    if (fromFigure) {
      console.log(`  [cover] using article rv-figure-img (${figUrl})`);
      return fromFigure;
    }
    console.warn('  [cover] rv-figure-img not found/downloadable — trying feed image');
  }

  const fromFeed = await toDataUri(story.thumbnail);
  if (fromFeed) {
    console.log('  [cover] using feed image');
    return fromFeed;
  }

  console.warn('  [cover] no article image found — using brand fallback');
  return FALLBACK;
}

module.exports = { getCoverImage, figureUrlViaBrowser };
