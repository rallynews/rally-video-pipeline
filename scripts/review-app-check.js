#!/usr/bin/env node
// Drives review/index.html in a real browser, with the GitHub API stubbed:
//
//   node scripts/review-app-check.js
//
// `review-check` proves the BUILDER honours what was approved. This proves the
// other half — that the page commits what it displayed. It signs in, picks
// images out of the library, approves, and reads the JSON the page would have
// pushed to review/approved/<date>.json.
//
// It renders with puppeteer's Chromium, the same one the carousel slides are
// rendered with, so there's nothing extra to install. Set
// PUPPETEER_EXECUTABLE_PATH to use a browser that's already on the machine.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch {
  console.log('\npuppeteer is not installed — run `npm install` first.\n');
  process.exit(1);
}

const HTML = fs.readFileSync(path.join(__dirname, '..', 'review', 'index.html'), 'utf8');

// A library shaped like a real one: keyworded stills, one file carrying two
// keywords, and a generic pool with no keywords at all.
const LIBRARY = [
  { key: 'images/forest.jpg', label: 'forest', url: 'about:blank#forest', pool: 'keyword', keywords: ['forest'] },
  { key: 'images/forest-river.jpg', label: 'forest-river', url: 'about:blank#fr', pool: 'keyword', keywords: ['forest', 'river'] },
  { key: 'images/solar.jpg', label: 'solar', url: 'about:blank#solar', pool: 'keyword', keywords: ['solar'] },
  { key: 'images/city.jpg', label: 'city', url: 'about:blank#city', pool: 'keyword', keywords: ['city'] },
  { key: 'generic/light-02.jpg', label: 'light-02', url: 'about:blank#l2', pool: 'generic', keywords: [] },
  { key: 'generic/sunrise-01.jpg', label: 'sunrise-01', url: 'about:blank#s1', pool: 'generic', keywords: [] },
];

const DRAFT = {
  version: 1,
  date: '2026-08-13',
  createdAt: '2026-08-13T06:00:00.000Z',
  story: { headline: 'A river came back', publisher: 'The Guardian', url: 'https://example.test/a' },
  researchBrief: 'brief',
  sources: ['https://example.test/s'],
  verification: { ran: true, report: [{ verdict: 'ok' }] },
  pillar: 'Climate & Environment',
  style: '1a',
  raw: {
    headline: 'H', challenge: 'C', solution: 'S', resultHeading: 'RH', resultLine: 'RL',
    whyMatters: 'W', engagementQuestion: 'Q', captionLead: 'L', storyHashtag: 'rivers',
    originalSource: 'The Guardian',
  },
  cover: { url: 'about:blank#cover' },
  reel: {
    script: 'x', hook: 'A River Came Back', noMusic: false, mood: 'uplifting', wordCount: 60,
    lines: [{ text: 'Line one.' }, { text: 'Line two.' }],
    shots: [
      { line: 0, keywords: ['forest'], key: 'images/forest.jpg', image: 'forest', motion: 'push-in',
        transition: 'cut', cover: true, thumb: 'about:blank#cover', fallbackThumb: 'about:blank#forest' },
      { line: 0, keywords: ['solar'], key: 'images/solar.jpg', image: 'solar', motion: 'pan-left',
        transition: 'cut', cover: false, thumb: 'about:blank#solar', fallbackThumb: null },
      { line: 1, keywords: [], key: 'generic/light-02.jpg', image: 'light-02', motion: 'pan-up',
        transition: 'dissolve', cover: false, thumb: 'about:blank#l2', fallbackThumb: null },
    ],
    stockedKeywords: ['forest', 'river', 'solar', 'city'],
    library: LIBRARY,
  },
};

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); }
  catch (e) { failures++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

// Load the page with the GitHub API stubbed and sign in.
async function open(page, state) {
  await page.setContent(HTML, { waitUntil: 'domcontentloaded' });
  await page.type('#token', 'github_pat_stub');
  await page.click('#signin');
  await page.waitForSelector('#rlines .rline');
  if (state) state.dialogs.length = 0;
}

// Type into a picker and take the first match the list offers.
async function pick(page, index, text) {
  const input = (await page.$$('[data-role=image]'))[index];
  await input.click({ clickCount: 3 });
  await input.type(text);
  await page.waitForSelector('.picker-list:not(.hidden) .picker-opt');
  await page.evaluate(() => {
    const opt = document.querySelector('.picker-list:not(.hidden) .picker-opt');
    opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  });
}

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const state = { committed: [], dialogs: [] };

  // The page is served from about:blank here, so every call to the stub is
  // cross-origin: the preflight has to be answered and the CORS headers have to
  // come back on everything, or fetch refuses to hand the body to the app.
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };

  await page.setRequestInterception(true);
  page.on('request', req => {
    const url = req.url();
    if (url.indexOf('api.github.com') !== -1) {
      if (req.method() === 'OPTIONS') {
        return req.respond({ status: 204, headers: CORS });
      }
      if (req.method() === 'PUT') {
        state.committed.push(
          JSON.parse(Buffer.from(JSON.parse(req.postData()).content, 'base64').toString())
        );
        return req.respond({ status: 200, headers: CORS, contentType: 'application/json', body: '{"commit":{}}' });
      }
      if (url.indexOf('review/pending/') !== -1) {
        return req.respond({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(DRAFT) });
      }
      return req.respond({ status: 404, headers: CORS, contentType: 'application/json', body: '{}' });
    }
    if (url.indexOf('fonts.googleapis.com') !== -1 || url.indexOf('fonts.gstatic.com') !== -1) {
      return req.respond({ status: 200, contentType: 'text/css', body: '' });
    }
    return req.continue();
  });

  page.on('dialog', async d => { state.dialogs.push(d.message()); await d.accept(); });
  page.on('pageerror', e => { failures++; console.log(`  ❌ page error: ${e.message}`); });

  await open(page, state);

  console.log('\nEvery shot, and every image, is on the page\n');

  const cards = await page.$$('.shot');
  check('one card per planned shot', () => assert.strictEqual(cards.length, DRAFT.reel.shots.length));

  const pickers = await page.$$('[data-role=image]');
  check('every shot has a picker, the cover shot included', () => {
    assert.strictEqual(pickers.length, DRAFT.reel.shots.length,
      'the cover shot must expose the stand-in that plays if the article photo fails');
  });

  const fallbacks = await page.$$('.fallbackthumb');
  check('the cover shot shows its stand-in thumbnail too', () => {
    assert.strictEqual(fallbacks.length, 1);
  });

  const prefilled = await page.$$eval('[data-role=image]',
    els => els.map(e => ({ value: e.dataset.value, key: e.dataset.key })));
  check('each picker is pre-filled with the file actually on screen', () => {
    assert.deepStrictEqual(prefilled, [
      { value: 'forest', key: 'images/forest.jpg' },
      { value: 'solar', key: 'images/solar.jpg' },
      { value: 'light-02', key: 'generic/light-02.jpg' },
    ]);
  });

  await (await page.$$('[data-role=image]'))[2].click();
  await page.waitForSelector('.picker-list:not(.hidden)');
  const listed = await page.$$eval('.picker-list:not(.hidden) .picker-opt .name',
    els => els.map(e => e.textContent));
  check('opening a picker offers the whole library, generic stills included', () => {
    assert.deepStrictEqual(listed.slice().sort(), LIBRARY.map(e => e.label).sort());
  });

  console.log('\nWhat you picked is what gets committed\n');

  await open(page, state);
  await pick(page, 2, 'city');

  const status = await page.$eval('#status', el => el.textContent);
  check('the page says out loud that there are unsaved edits', () => {
    assert.ok(/made edits/.test(status), `status read "${status}"`);
  });

  await page.click('#asis');
  await new Promise(r => setTimeout(r, 250));
  check('"Approve as-is" asks before discarding those edits', () => {
    assert.strictEqual(state.dialogs.length, 1, 'no confirmation was shown');
    assert.ok(/discard your edits/i.test(state.dialogs[0]), state.dialogs[0]);
  });

  await open(page, state);
  await pick(page, 2, 'city');
  state.committed.length = 0;
  await page.click('#approve');
  await page.waitForSelector('#donebox:not(.hidden)');

  const out = state.committed[0];
  check('the approval carries the chosen file, not just a keyword', () => {
    assert.ok(out, 'nothing was committed');
    assert.strictEqual(out.reel.shots[2].key, 'images/city.jpg');
    assert.strictEqual(out.reel.shots[2].image, 'city');
    assert.deepStrictEqual(out.reel.shots[2].keywords, ['city']);
  });
  check('untouched shots keep the exact file the draft showed', () => {
    assert.strictEqual(out.reel.shots[0].key, 'images/forest.jpg');
    assert.strictEqual(out.reel.shots[1].key, 'images/solar.jpg');
  });
  check('the approval is flagged as edited, so it gets proofread', () => {
    assert.strictEqual(out.approvedWithEdits, true);
  });

  await browser.close();

  if (failures) {
    console.error(`\n❌ ${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log('\n✅ The review app commits exactly what it displayed.\n');
})().catch(err => {
  console.error(`\n❌ The review app check failed to run: ${err.message}\n`);
  process.exit(1);
});
