// Carousel slide templates, ported 1:1 from the attached Rally News Carousel
// deck (styles 1a–1d). Each style renders the 5 content slides the pipeline
// exports as PNGs:
//   1 · Headline   2 · The Challenge   3 · The Solution
//   4 · Results & Impact   5 · Why It Matters
//
// Canvas is 1080×1350 (Instagram/Facebook 4:5 portrait). Fonts are Lora
// (serif) + Outfit (sans), matching rally.news. The Rally "R" logo and the
// cover photo are injected as data URIs so rendering never depends on the
// network for its own assets.

const STYLE_KEYS = ['1a', '1b', '1c', '1d'];

function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Bottom-left "rally.news" wordmark used on the content slides. `light` flips
// the mark white for dark backgrounds.
function footer(logo, color, light) {
  const filter = light ? 'filter:brightness(0) invert(1);' : '';
  return `<div style="position:absolute; bottom:32px; left:64px; display:flex; align-items:center; gap:10px;">` +
    `<img src="${logo}" style="width:28px;height:28px;${filter}">` +
    `<span style="font-family:'Outfit',sans-serif; font-weight:700; font-style:italic; font-size:22px; color:${color};">rally.news</span>` +
    `</div>`;
}

// Small white photo credit crediting the original source. Rendered white with a
// soft shadow so it stays legible over any cover photo.
function attribution(source) {
  if (!source) return '';
  return `<div style="position:absolute; bottom:14px; right:20px; font-family:'Outfit',sans-serif; font-size:15px; font-weight:500; letter-spacing:0.02em; color:rgba(255,255,255,0.9); text-shadow:0 1px 3px rgba(0,0,0,0.6);">Photo: ${esc(source)}</div>`;
}

// Cover slide (slide 1) photo block. The top-right mark sits over the article
// photo (any colour), so it is always rendered white with a soft drop-shadow
// to stay legible regardless of the image behind it. `source` adds a small
// white photo credit in the bottom-right of the photo.
function cover(cover, logo, height, source) {
  return `<div style="height:${height}px; width:100%; position:relative; background:#0000000a;">` +
    `<div style="position:absolute; inset:0; background-image:url('${cover}'); background-size:cover; background-position:center;"></div>` +
    attribution(source) +
    `</div>` +
    `<img src="${logo}" style="position:absolute; top:32px; right:32px; width:48px; height:48px; filter:brightness(0) invert(1) drop-shadow(0 2px 5px rgba(0,0,0,0.5));">`;
}

// Slide 6 · "Follow Rally News" closer. Centered mark + title + subtitle.
function followSlide(logo, bg, logoLight, titleColor, subColor) {
  const filter = logoLight ? 'filter:brightness(0) invert(1);' : '';
  return `<section class="slide follow" style="background:${bg};">
      <img src="${logo}" style="width:96px; height:96px; margin-bottom:40px; ${filter}">
      <div style="font-family:'Lora',serif; font-size:44px; color:${titleColor}; font-weight:600; margin-bottom:16px;">Follow Rally News</div>
      <div style="font-family:'Outfit',sans-serif; font-size:24px; color:${subColor};">for more good news, every day</div>
    </section>`;
}

// ── 1a · Editorial Cream ──────────────────────────────────────────────────
function style1a(c, coverUri, logo) {
  return [
    // 1 · Headline — full-bleed photo with the cream background as a banner
    // behind only the headline.
    `<section class="slide" style="background:#1B1A17; flex-direction:column; justify-content:flex-end;">
      <div style="position:absolute; inset:0; background-image:url('${coverUri}'); background-size:cover; background-position:center;"></div>
      <img src="${logo}" style="position:absolute; top:32px; right:32px; width:48px; height:48px; filter:brightness(0) invert(1) drop-shadow(0 2px 5px rgba(0,0,0,0.5));">
      ${attribution(c.source)}
      <div style="position:relative; background:#F7F4EE; margin:0 56px 132px; padding:44px 52px;">
        <div style="font-family:'Lora',serif; font-size:50px; line-height:1.15; color:#1B1A17; font-weight:600;">${esc(c.headline)}</div>
      </div>
      <div style="position:absolute; bottom:32px; left:64px;"><span style="font-family:'Outfit',sans-serif; font-weight:700; font-style:italic; font-size:24px; color:#F7F4EE; text-shadow:0 1px 3px rgba(0,0,0,0.5);">rally.news</span></div>
    </section>`,
    // 2 · Challenge
    `<section class="slide pad" style="background:#F7F4EE;">
      <div style="width:80px; height:3px; background:#5A775E; margin-bottom:36px;"></div>
      <div style="font-family:'Lora',serif; font-size:42px; line-height:1.32; color:#1B1A17; font-weight:500;">${esc(c.challenge)}</div>
      ${footer(logo, '#1B1A17', false)}
    </section>`,
    // 3 · Solution
    `<section class="slide pad" style="background:#F7F4EE;">
      <div style="width:80px; height:3px; background:#5A775E; margin-bottom:36px;"></div>
      <div style="font-family:'Lora',serif; font-size:42px; line-height:1.32; color:#1B1A17; font-weight:500;">${esc(c.solution)}</div>
      ${footer(logo, '#1B1A17', false)}
    </section>`,
    // 4 · Results & Impact
    `<section class="slide pad" style="background:#F7F4EE;">
      <div style="width:80px; height:3px; background:#5A775E; margin-bottom:36px;"></div>
      <div style="font-family:'Lora',serif; font-size:60px; line-height:1.15; color:#1B1A17; font-weight:600;">${esc(c.resultHeading)}</div>
      <div style="font-family:'Outfit',sans-serif; font-size:24px; color:#4A4942; margin-top:20px;">${esc(c.resultLine)}</div>
      ${footer(logo, '#1B1A17', false)}
    </section>`,
    // 5 · Why It Matters
    `<section class="slide pad" style="background:#EBE3D3;">
      <div style="font-family:'Lora',serif; font-size:38px; line-height:1.4; color:#1B1A17; font-style:italic; font-weight:500;">${esc(c.whyMatters)}</div>
      ${footer(logo, '#4A4942', false)}
    </section>`,
  ];
}

// ── 1b · Deep Green ───────────────────────────────────────────────────────
function style1b(c, coverUri, logo) {
  return [
    `<section class="slide" style="background:#5A775E; flex-direction:column;">
      ${cover(coverUri, logo, 820, c.source)}
      <div style="padding:56px 64px; flex:1; display:flex; flex-direction:column; justify-content:center;">
        <div style="font-family:'Lora',serif; font-size:50px; line-height:1.15; color:#F7F4EE; font-weight:600;">${esc(c.headline)}</div>
      </div>
      <div style="position:absolute; bottom:32px; left:64px;"><span style="font-family:'Outfit',sans-serif; font-weight:700; font-style:italic; font-size:24px; color:#F7F4EE;">rally.news</span></div>
    </section>`,
    `<section class="slide pad" style="background:#F7F4EE;">
      <div style="font-family:'Lora',serif; font-size:42px; line-height:1.32; color:#1B1A17; font-weight:500;">${esc(c.challenge)}</div>
      <div style="margin-top:40px; height:2px; background:#EBE3D3;"></div>
      ${footer(logo, '#1B1A17', false)}
    </section>`,
    `<section class="slide pad" style="background:#5A775E;">
      <div style="font-family:'Lora',serif; font-size:42px; line-height:1.32; color:#F7F4EE; font-weight:500;">${esc(c.solution)}</div>
      <div style="margin-top:40px; height:2px; background:#4a6650;"></div>
      ${footer(logo, '#F7F4EE', true)}
    </section>`,
    `<section class="slide pad" style="background:#F7F4EE;">
      <div style="font-family:'Lora',serif; font-size:58px; line-height:1.15; color:#1B1A17; font-weight:600;">${esc(c.resultHeading)}</div>
      <div style="font-family:'Outfit',sans-serif; font-size:24px; color:#4A4942; margin-top:20px;">${esc(c.resultLine)}</div>
      ${footer(logo, '#1B1A17', false)}
    </section>`,
    `<section class="slide pad" style="background:#5A775E;">
      <div style="font-family:'Lora',serif; font-size:36px; line-height:1.4; color:#F7F4EE; font-style:italic; font-weight:500;">${esc(c.whyMatters)}</div>
      ${footer(logo, '#F7F4EE', true)}
    </section>`,
  ];
}

// ── 1c · Tan Accent Block ─────────────────────────────────────────────────
function style1c(c, coverUri, logo) {
  return [
    `<section class="slide" style="background:#F7F4EE; flex-direction:column;">
      ${cover(coverUri, logo, 750, c.source)}
      <div style="background:#EBE3D3; padding:56px 64px; flex:1; display:flex; flex-direction:column; justify-content:center;">
        <div style="font-family:'Lora',serif; font-size:48px; line-height:1.18; color:#1B1A17; font-weight:600;">${esc(c.headline)}</div>
      </div>
      <div style="position:absolute; bottom:32px; left:64px;"><span style="font-family:'Outfit',sans-serif; font-weight:700; font-style:italic; font-size:24px; color:#1B1A17;">rally.news</span></div>
    </section>`,
    `<section class="slide pad" style="background:#EBE3D3;">
      <div style="font-family:'Lora',serif; font-size:42px; line-height:1.32; color:#1B1A17; font-weight:500;">${esc(c.challenge)}</div>
      ${footer(logo, '#4A4942', false)}
    </section>`,
    `<section class="slide pad" style="background:#F7F4EE;">
      <div style="font-family:'Lora',serif; font-size:42px; line-height:1.32; color:#1B1A17; font-weight:500;">${esc(c.solution)}</div>
      ${footer(logo, '#1B1A17', false)}
    </section>`,
    `<section class="slide pad" style="background:#EBE3D3;">
      <div style="font-family:'Lora',serif; font-size:58px; line-height:1.15; color:#1B1A17; font-weight:600;">${esc(c.resultHeading)}</div>
      <div style="font-family:'Outfit',sans-serif; font-size:24px; color:#4A4942; margin-top:20px;">${esc(c.resultLine)}</div>
      ${footer(logo, '#4A4942', false)}
    </section>`,
    `<section class="slide pad" style="background:#F7F4EE;">
      <div style="font-family:'Lora',serif; font-size:36px; line-height:1.4; color:#1B1A17; font-style:italic; font-weight:500;">${esc(c.whyMatters)}</div>
      ${footer(logo, '#1B1A17', false)}
    </section>`,
  ];
}

// ── 1d · Ink Dark ─────────────────────────────────────────────────────────
function style1d(c, coverUri, logo) {
  return [
    `<section class="slide" style="background:#1B1A17; flex-direction:column;">
      ${cover(coverUri, logo, 820, c.source)}
      <div style="padding:56px 64px; flex:1; display:flex; flex-direction:column; justify-content:center;">
        <div style="font-family:'Lora',serif; font-size:50px; line-height:1.15; color:#F7F4EE; font-weight:600;">${esc(c.headline)}</div>
      </div>
      <div style="position:absolute; bottom:32px; left:64px;"><span style="font-family:'Outfit',sans-serif; font-weight:700; font-style:italic; font-size:24px; color:#F7F4EE;">rally.news</span></div>
    </section>`,
    `<section class="slide pad" style="background:#1B1A17;">
      <div style="width:80px; height:3px; background:#7AAB7F; margin-bottom:36px;"></div>
      <div style="font-family:'Lora',serif; font-size:42px; line-height:1.32; color:#F7F4EE; font-weight:500;">${esc(c.challenge)}</div>
      ${footer(logo, '#F7F4EE', true)}
    </section>`,
    `<section class="slide pad" style="background:#1B1A17;">
      <div style="width:80px; height:3px; background:#7AAB7F; margin-bottom:36px;"></div>
      <div style="font-family:'Lora',serif; font-size:42px; line-height:1.32; color:#F7F4EE; font-weight:500;">${esc(c.solution)}</div>
      ${footer(logo, '#F7F4EE', true)}
    </section>`,
    `<section class="slide pad" style="background:#1B1A17;">
      <div style="font-family:'Lora',serif; font-size:58px; line-height:1.15; color:#F7F4EE; font-weight:600;">${esc(c.resultHeading)}</div>
      <div style="font-family:'Outfit',sans-serif; font-size:24px; color:#9A9D94; margin-top:20px;">${esc(c.resultLine)}</div>
      ${footer(logo, '#F7F4EE', true)}
    </section>`,
    `<section class="slide pad" style="background:#1B1A17;">
      <div style="font-family:'Lora',serif; font-size:36px; line-height:1.4; color:#F7F4EE; font-style:italic; font-weight:500;">${esc(c.whyMatters)}</div>
      ${footer(logo, '#F7F4EE', true)}
    </section>`,
  ];
}

const BUILDERS = { '1a': style1a, '1b': style1b, '1c': style1c, '1d': style1d };

// Per-style "Follow Rally News" closer (slide 6), colours from the deck.
const FOLLOW = {
  '1a': (logo) => followSlide(logo, '#5A775E', true, '#F7F4EE', '#EBE3D3'),
  '1b': (logo) => followSlide(logo, '#1B1A17', true, '#F7F4EE', '#9A9D94'),
  '1c': (logo) => followSlide(logo, '#EBE3D3', false, '#1B1A17', '#4A4942'),
  '1d': (logo) => followSlide(logo, '#7AAB7F', true, '#1B1A17', '#1B1A17'),
};

// Build a single HTML document holding the 6 slides for the chosen style (the
// 5 content slides plus the Follow closer). The renderer screenshots each
// `<section class="slide">` individually.
function buildDeck(styleKey, copy, coverUri, logoUri) {
  const builder = BUILDERS[styleKey];
  if (!builder) throw new Error(`Unknown carousel style: ${styleKey}`);
  const slides = [
    ...builder(copy, coverUri, logoUri),
    FOLLOW[styleKey](logoUri),
  ].join('\n');

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500;1,600&family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#ffffff; }
  .slide { width:1080px; height:1350px; position:relative; display:flex; box-sizing:border-box; overflow:hidden; }
  .slide.pad { flex-direction:column; justify-content:center; padding:80px 64px; }
  .slide.follow { flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:80px; }
</style>
</head><body>
${slides}
</body></html>`;
}

module.exports = { buildDeck, STYLE_KEYS };
