const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

// On-screen headlines and the persistent brand mark are rendered in a headless
// browser as transparent 1080×1920 PNGs, then overlaid by ffmpeg at the right
// moment. Doing it in HTML rather than ffmpeg's drawtext means the reel uses
// the exact Lora/Outfit type and Rally colours as the carousel slides, with
// real webfont loading, wrapping and shadows.

const W = 1080;
const H = 1920;

const LOGO_PATH = path.join(__dirname, '..', '..', 'assets', 'rally-logo.png');

const CREAM = '#F7F4EE';
const GREEN = '#7AAB7F';

function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function logoDataUri() {
  try {
    const buf = fs.readFileSync(LOGO_PATH);
    if (buf && buf.length) return `data:image/png;base64,${buf.toString('base64')}`;
  } catch (err) {
    console.warn(`  [reel] logo asset unreadable (${err.message}) — brand mark omitted`);
  }
  return null;
}

// Captions are full narration lines now, so the scale runs from punchy
// three-word moments down to a size where a 14-word sentence sets in three
// comfortable lines.
function fontSizeFor(text) {
  const n = String(text).length;
  if (n <= 14) return 96;
  if (n <= 22) return 84;
  if (n <= 32) return 72;
  if (n <= 48) return 62;
  if (n <= 70) return 54;
  return 46;
}

// The opening HOOK is a different animal from a subtitle: it's the headline
// that has to stop the scroll, so it sits high and centred over the article
// photo at display size, not down in the subtitle band.
function hookSizeFor(text) {
  const n = String(text).length;
  if (n <= 18) return 128;
  if (n <= 28) return 112;
  if (n <= 40) return 96;
  return 82;
}

// The caption card. Subtitles sit in the lower third but clear of the bottom
// 320px, which Instagram and TikTok cover with their own UI; the hook takes
// the upper-middle of the frame instead.
function captionFrame(caption) {
  const text = typeof caption === 'string' ? caption : caption.text;
  const isHook = Boolean(caption && caption.hook);

  if (isHook) {
    return `<div class="frame">
      <div class="hook-scrim"></div>
      <div class="hook">
        <div class="hook-text" style="font-size:${hookSizeFor(text)}px;">${esc(text)}</div>
        <div class="hook-rule"></div>
      </div>
    </div>`;
  }

  return `<div class="frame">
    <div class="scrim"></div>
    <div class="caption">
      <div class="rule"></div>
      <div class="text" style="font-size:${fontSizeFor(text)}px;">${esc(text)}</div>
    </div>
  </div>`;
}

// Photo credit for the opening shot. The reel opens on the article's own
// featured image, so the outlet that published it is credited on screen —
// bottom-right, opposite the rally.news mark.
function creditFrame(source) {
  return `<div class="frame">
    <div class="credit">Photo: ${esc(source)}</div>
  </div>`;
}

function brandFrame(logo) {
  const mark = logo
    ? `<img src="${logo}" style="width:34px;height:34px;filter:brightness(0) invert(1) drop-shadow(0 2px 6px rgba(0,0,0,0.55));">`
    : '';
  return `<div class="frame">
    <div class="brand">
      ${mark}
      <span>rally.news</span>
    </div>
  </div>`;
}

function buildDocument(captions, logo, credit) {
  const frames = [
    ...captions.map(captionFrame),
    brandFrame(logo),
    ...(credit ? [creditFrame(credit)] : []),
  ].join('\n');
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,500;0,600;0,700&family=Outfit:ital,wght@1,700&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { background:transparent; }
  .frame { width:${W}px; height:${H}px; position:relative; overflow:hidden; }
  /* Soft dark band so cream type stays legible over any photograph. */
  .scrim {
    position:absolute; left:0; right:0; bottom:0; height:820px;
    background:linear-gradient(to top, rgba(15,14,12,0.78) 0%, rgba(15,14,12,0.55) 38%, rgba(15,14,12,0) 100%);
  }
  .caption {
    position:absolute; left:80px; right:80px; bottom:430px;
    display:flex; flex-direction:column; align-items:center; text-align:center;
  }
  .rule { width:72px; height:5px; background:${GREEN}; margin-bottom:28px; border-radius:3px; }
  /* Hook: the scroll-stopping headline over the opening photo. Darkens the
     whole frame rather than just the base, because it sits high. */
  .hook-scrim {
    position:absolute; inset:0;
    background:linear-gradient(to bottom, rgba(15,14,12,0.62) 0%, rgba(15,14,12,0.34) 55%, rgba(15,14,12,0.62) 100%);
  }
  .hook {
    position:absolute; left:72px; right:72px; top:430px;
    display:flex; flex-direction:column; align-items:center; text-align:center;
  }
  .hook-text {
    font-family:'Lora', serif; font-weight:700; line-height:1.06; color:${CREAM};
    letter-spacing:-0.02em; text-shadow:0 4px 26px rgba(0,0,0,0.72), 0 2px 5px rgba(0,0,0,0.6);
  }
  .hook-rule { width:110px; height:7px; background:${GREEN}; margin-top:36px; border-radius:4px; }
  .text {
    font-family:'Lora', serif; font-weight:600; line-height:1.14; color:${CREAM};
    letter-spacing:-0.01em; text-shadow:0 3px 18px rgba(0,0,0,0.6), 0 1px 3px rgba(0,0,0,0.5);
  }
  .brand {
    position:absolute; left:56px; bottom:150px;
    display:flex; align-items:center; gap:10px;
  }
  .brand span {
    font-family:'Outfit', sans-serif; font-weight:700; font-style:italic; font-size:26px;
    color:${CREAM}; text-shadow:0 2px 6px rgba(0,0,0,0.55);
  }
  .credit {
    position:absolute; right:56px; bottom:156px;
    font-family:'Outfit', sans-serif; font-weight:500; font-size:24px;
    letter-spacing:0.02em; color:rgba(247,244,238,0.9);
    text-shadow:0 2px 6px rgba(0,0,0,0.6);
  }
</style>
</head><body>
${frames}
</body></html>`;
}

// Render one transparent PNG per caption, plus the brand mark that stays on
// screen for the whole reel and (when the opening shot is the article's own
// photo) the credit for the outlet that published it.
// `captions` are { text, hook } — hook entries get the headline treatment.
// Returns { captions: Buffer[], brand: Buffer, credit: Buffer|null }.
async function renderOverlays(captions, credit) {
  const html = buildDocument(captions, logoDataUri(), credit);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--force-color-profile=srgb'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 });

    try {
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => Promise.all([
        document.fonts.load("600 96px 'Lora'"),
        document.fonts.load("700 128px 'Lora'"),
        document.fonts.load("italic 700 26px 'Outfit'"),
      ]));
    } catch (e) {
      console.warn(`  [reel] caption font wait warning: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 250));

    const expected = captions.length + 1 + (credit ? 1 : 0);
    const frames = await page.$$('.frame');
    if (frames.length !== expected) {
      throw new Error(`Expected ${expected} overlay frames, rendered ${frames.length}`);
    }

    const images = [];
    for (const frame of frames) {
      images.push(await frame.screenshot({ type: 'png', omitBackground: true }));
    }

    // Popped in reverse of the order they were appended in buildDocument.
    const creditImage = credit ? images.pop() : null;
    const brand = images.pop();
    console.log(
      `  [reel] rendered ${images.length} caption overlays + brand mark` +
      (credit ? ' + photo credit' : '')
    );
    return { captions: images, brand, credit: creditImage };
  } finally {
    await browser.close();
  }
}

// Safety net for the closing card. The real ending is a "Follow Us" MP4 kept in
// R2 (R2_REELS_OUTRO_KEY) so it can be redesigned without a deploy — this
// opaque frame is only used when that object is missing, so a reel never ends
// mid-sentence.
async function renderFollowCard() {
  const logo = logoDataUri();
  const mark = logo
    ? `<img src="${logo}" style="width:150px;height:150px;margin-bottom:56px;filter:brightness(0) invert(1);">`
    : '';
  const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@600&family=Outfit:ital,wght@0,500;1,700&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  .frame {
    width:${W}px; height:${H}px; background:#5A775E;
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    text-align:center; padding:96px;
  }
  .title { font-family:'Lora',serif; font-weight:600; font-size:88px; color:${CREAM}; margin-bottom:28px; }
  .sub { font-family:'Outfit',sans-serif; font-weight:500; font-size:38px; color:#EBE3D3; margin-bottom:64px; }
  .mark { font-family:'Outfit',sans-serif; font-weight:700; font-style:italic; font-size:40px; color:${CREAM}; }
</style>
</head><body>
<div class="frame">
  ${mark}
  <div class="title">Follow Us</div>
  <div class="sub">for more good news, every day</div>
  <div class="mark">rally.news</div>
</div>
</body></html>`;

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--force-color-profile=srgb'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 });
    try {
      await page.evaluate(() => document.fonts.ready);
    } catch { /* fall back to the default face rather than failing the reel */ }
    await new Promise(r => setTimeout(r, 200));
    const frame = await page.$('.frame');
    return await frame.screenshot({ type: 'png' });
  } finally {
    await browser.close();
  }
}

module.exports = { renderOverlays, renderFollowCard, W, H };
