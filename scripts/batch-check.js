#!/usr/bin/env node
// Offline checks for the Studio batch half of the pipeline — no credentials,
// no network, no ffmpeg:
//
//   node scripts/batch-check.js
//
//   (a) the draft sent to Studio carries everything Studio's script editor
//       edits, and the opening shot shows the article photo with its library
//       stand-in underneath
//   (b) the proofreader reads and writes exactly the fields Studio lets an
//       editor type into: the opening headline, the lines, both captions
//   (c) the ready messages say what happened and carry the batch's link
//   (d) a batch run against a stubbed Studio: job → finish, one message only
//   (e) every link handed out is UTM-tagged without disturbing the story URL

const assert = require('assert');
const http = require('http');

process.env.R2_VIDEO_PUBLIC_URL = 'https://videos.example';
const { buildDraft } = require('../src/batch/draft');
const { collectFields } = require('../src/batch/proofreader');
const notify = require('../src/batch/notify');
const { captionLinks, feedLink } = require('../src/tracking');

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

const story = { headline: 'Otters return', summary: 's', publisher: 'BBC', url: 'https://rally.news/?article=Otters&id=1' };
const reelPlan = {
  script: 'a b', hook: 'Otters Are Back', mood: 'uplifting', wordCount: 2,
  lines: [{ text: 'Did you hear?' }, { text: 'They came back.' }],
  shots: [
    { line: 0, keywords: ['forest'], key: 'images/forest.jpg', image: 'forest', motion: 'push-in', transition: 'cut' },
    { line: 1, keywords: ['river'], key: 'images/river.jpg', image: 'river', motion: 'pan-left', transition: 'flash' },
  ],
  stockedKeywords: ['forest', 'river'],
  library: [
    { key: 'images/forest.jpg', label: 'forest', keywords: ['forest'], pool: 'keyword' },
    { key: 'images/river.jpg', label: 'river', keywords: ['river'], pool: 'keyword' },
    { key: 'generic/sun.jpg', label: 'sun', keywords: [], pool: 'generic' },
  ],
};
const captions = { facebook: 'FB', instagram: 'IG', link: story.url, links: captionLinks(story.url, 3, 2) };

(async () => {
  console.log('\nbatch-check');

  await check('(a) draft has the editable fields, cover first with its stand-in', () => {
    const d = buildDraft({ story, raw: { researchBrief: ' notes ' }, pillar: 'P', sources: [], verification: { ran: true, report: [] },
      captions, reelPlan, coverUrl: 'https://videos.example/drafts/cover.jpg' });
    assert.strictEqual(d.reel.hook, 'Otters Are Back');
    assert.strictEqual(d.reel.noMusic, false);
    assert.strictEqual(d.captions.facebook, 'FB');
    assert.deepStrictEqual(d.captions.links, captions.links);
    assert.strictEqual(d.captions.link, captions.links.facebook, 'the plain link is the tracked Facebook one');
    assert.strictEqual(d.researchBrief, 'notes');
    assert.strictEqual(d.reel.shots[0].cover, true);
    assert.strictEqual(d.reel.shots[0].thumb, 'https://videos.example/drafts/cover.jpg');
    assert.strictEqual(d.reel.shots[0].fallbackThumb, 'https://videos.example/images/forest.jpg');
    assert.strictEqual(d.reel.shots[1].thumb, 'https://videos.example/images/river.jpg');
    assert.strictEqual(d.reel.library.length, 3, 'whole library offered, generic included');
    assert.ok(d.reel.library.every(e => e.url));
  });

  await check('(b) proofreader fields are the Studio-editable ones', () => {
    const d = buildDraft({ story, raw: {}, pillar: 'P', sources: [], verification: {}, captions, reelPlan, coverUrl: null });
    assert.deepStrictEqual(Object.keys(collectFields(d)).sort(),
      ['captions.facebook', 'captions.instagram', 'reel.hook', 'reel.line.0', 'reel.line.1']);
  });

  await check('(c) ready messages', () => {
    const base = { url: 'https://rally.news/studio/promotion/carousel/?batch=7', items: [
      { slot: 1, headline: 'A', theme: 'Animals', failed: false, duration_s: 26.6 },
      { slot: 2, headline: 'B', theme: 'Energy', failed: true } ] };
    const s = notify.compose({ ...base, mode: 'script' });
    assert.match(s.title, /1 of 2 scripts ready, 1 needs a retry/);
    assert.strictEqual(s.url, base.url);
    const p = notify.compose({ ...base, mode: 'produce', items: [base.items[0]] });
    assert.strictEqual(p.title, 'Carousel: 1 video ready');
    assert.match(p.body, /1\. A \(Animals\) · 27s/);
  });

  await check('(e) tracked links keep the story URL and name the platform and video', () => {
    const l = captionLinks('https://rally.news/categories/world/?article=A%2BB&id=5&utm_source=old', 7, 3);
    assert.strictEqual(l.facebook, 'https://rally.news/categories/world/?article=A%2BB&id=5&utm_source=facebook&utm_medium=social&utm_campaign=carousel&utm_content=b7-v3');
    assert.ok(l.instagram.includes('utm_source=instagram'));
    assert.strictEqual(feedLink('https://rally.news/?article=X&id=1', 'daily-video'), 'https://rally.news/?article=X&id=1&utm_source=rss&utm_medium=rss&utm_campaign=daily-video');
  });

  await check('(d) job and finish against a stubbed Studio', async () => {
    const calls = [];
    const server = http.createServer((req, res) => {
      let body = ''; req.on('data', c => body += c);
      req.on('end', () => {
        calls.push({ method: req.method, url: req.url, key: req.headers['x-carousel-key'], body: body ? JSON.parse(body) : null });
        res.setHeader('Content-Type', 'application/json');
        if (req.url.includes('action=job')) return res.end(JSON.stringify({ items: [11, 12] }));
        if (body.includes('"finish"')) return res.end(JSON.stringify({ notify: false, reason: 'already sent' }));
        res.statusCode = 400; res.end('{}');
      });
    });
    await new Promise(r => server.listen(0, r));
    process.env.STUDIO_API_URL = `http://127.0.0.1:${server.address().port}/api/carousel.php`;
    process.env.CAROUSEL_API_KEY = 'k';
    const studio = require('../src/studio');
    const job = await studio.job(5, 'script');
    assert.deepStrictEqual(job.items, [11, 12]);
    const fin = await studio.finish(5, 'script', [11, 12]);
    assert.strictEqual(fin.notify, false);
    assert.ok(calls.every(c => c.key === 'k'), 'key sent on every call');
    assert.deepStrictEqual(calls[1].body, { action: 'finish', batch: 5, mode: 'script', items: [11, 12] });
    await assert.rejects(() => studio.scriptDone(1, {}), /HTTP 400/, 'a 400 is not retried');
    server.close();
  });

  console.log(failures ? `\n${failures} check(s) failed\n` : '\nall batch checks passed\n');
  process.exit(failures ? 1 : 0);
})();
