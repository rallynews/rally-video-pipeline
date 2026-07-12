const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { buildDeck, STYLE_KEYS } = require('./templates');

const LOGO_PATH = path.join(__dirname, '..', '..', 'assets', 'rally-logo.png');

function pickStyle() {
  return STYLE_KEYS[Math.floor(Math.random() * STYLE_KEYS.length)];
}

// Inline SVG mark used only if the logo PNG can't be read, so branding never
// silently disappears.
const LOGO_FALLBACK =
  'data:image/svg+xml;base64,' +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">` +
    `<text x="60" y="82" font-family="Georgia,serif" font-size="90" font-style="italic" ` +
    `font-weight="700" fill="#5A775E" text-anchor="middle">R</text></svg>`
  ).toString('base64');

function logoDataUri() {
  try {
    const buf = fs.readFileSync(LOGO_PATH);
    if (buf && buf.length) return `data:image/png;base64,${buf.toString('base64')}`;
  } catch (err) {
    console.warn(`  [renderer] logo asset unreadable (${err.message}) — using SVG fallback`);
  }
  return LOGO_FALLBACK;
}

// Render the 5 carousel slides for `copy` in the given style to PNG buffers.
// `coverUri` is a data: URI for the cover photo (see cover-image.js).
// Returns { style, images: Buffer[] } — one 1080×1350 PNG per slide (@2x).
async function renderCarousel(copy, coverUri, style = pickStyle()) {
  const html = buildDeck(style, copy, coverUri, logoDataUri());

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--force-color-profile=srgb'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1350, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 });

    // Make sure the webfonts have actually loaded before we screenshot,
    // otherwise slides render in the fallback face.
    try {
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => Promise.all([
        document.fonts.load("600 52px 'Lora'"),
        document.fonts.load("italic 500 38px 'Lora'"),
        document.fonts.load("700 24px 'Outfit'"),
      ]));
    } catch (e) {
      console.warn(`  [renderer] font wait warning: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 300));

    const slides = await page.$$('.slide');
    if (slides.length !== 6) {
      throw new Error(`Expected 6 slides, rendered ${slides.length}`);
    }

    const images = [];
    for (let i = 0; i < slides.length; i++) {
      const buf = await slides[i].screenshot({ type: 'png' });
      images.push(buf);
      console.log(`  [renderer] slide ${i + 1}/6 captured (${(buf.length / 1024).toFixed(0)} KB)`);
    }

    return { style, images };
  } finally {
    await browser.close();
  }
}

module.exports = { renderCarousel, pickStyle };
