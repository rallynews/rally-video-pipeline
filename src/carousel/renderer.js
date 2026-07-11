const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { buildDeck, STYLE_KEYS } = require('./templates');

const LOGO_PATH = path.join(__dirname, '..', '..', 'assets', 'rally-logo.png');

function pickStyle() {
  return STYLE_KEYS[Math.floor(Math.random() * STYLE_KEYS.length)];
}

function logoDataUri() {
  const buf = fs.readFileSync(LOGO_PATH);
  return `data:image/png;base64,${buf.toString('base64')}`;
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
    if (slides.length !== 5) {
      throw new Error(`Expected 5 slides, rendered ${slides.length}`);
    }

    const images = [];
    for (let i = 0; i < slides.length; i++) {
      const buf = await slides[i].screenshot({ type: 'png' });
      images.push(buf);
      console.log(`  [renderer] slide ${i + 1}/5 captured (${(buf.length / 1024).toFixed(0)} KB)`);
    }

    return { style, images };
  } finally {
    await browser.close();
  }
}

module.exports = { renderCarousel, pickStyle };
