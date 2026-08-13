const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const catalogue = require('../reels/r2-catalogue');

// The morning review draft.
//
// Instead of producing the carousel and reel outright, the daily run writes an
// outline — everything the models decided, before any of it is rendered — to
// `review/pending/<date>.json` in the repo, and the workflow commits it. The
// editor opens the review app (a static page in this repo, served from R2),
// edits, and approves; the approval is a commit to `review/approved/<date>.json`
// made by the app through the GitHub API, and THAT push triggers the produce
// workflow. GitHub is the source of truth for every draft and approval; the
// page is just an editor over it.

const PENDING_DIR = path.join(__dirname, '..', '..', 'review', 'pending');

function today() {
  return new Date().toISOString().slice(0, 10);
}

function publicUrl(key) {
  const base = (process.env.R2_VIDEO_PUBLIC_URL || process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
  return base ? `${base}/${key}` : null;
}

// Stage the article's cover photo in the videos bucket so the review app can
// show it and the produce run can fetch the exact same image later — the
// article page itself may change between draft and approval.
async function stageCover(coverUri, date) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(String(coverUri || ''));
  if (!match || match[1].includes('svg')) return null;

  const ext = match[1].includes('png') ? 'png' : match[1].includes('webp') ? 'webp' : 'jpg';
  const key = `drafts/${date}/cover.${ext}`;
  const client = catalogue.getClient();
  await client.send(new PutObjectCommand({
    Bucket: catalogue.VIDEO_BUCKET(),
    Key: key,
    Body: Buffer.from(match[2], 'base64'),
    ContentType: match[1],
    CacheControl: 'public, max-age=86400',
  }));
  return publicUrl(key);
}

// Keep the served copy of the review app current. The page is committed in the
// repo (review/index.html); every draft run pushes it to the bucket so app
// changes ship with the next morning's draft, no separate deploy.
async function publishReviewApp() {
  const file = path.join(__dirname, '..', '..', 'review', 'index.html');
  let html;
  try {
    html = fs.readFileSync(file);
  } catch {
    console.warn('  [review] review/index.html missing — app not published');
    return null;
  }
  const client = catalogue.getClient();
  await client.send(new PutObjectCommand({
    Bucket: catalogue.VIDEO_BUCKET(),
    Key: 'review/index.html',
    Body: html,
    ContentType: 'text/html; charset=utf-8',
    // The app must never be cached stale: it's the thing being iterated on.
    CacheControl: 'no-cache',
  }));
  return publicUrl('review/index.html');
}

// Assemble and write the draft file the workflow commits. Returns
// { file, date, reviewUrl }.
async function writeDraft({ story, raw, pillar, style, slideCopy, sources, verification, reelPlan, coverUri }) {
  const date = today();

  let coverUrl = null;
  try {
    coverUrl = await stageCover(coverUri, date);
  } catch (e) {
    console.warn(`  [review] cover staging failed (${e.message}) — draft continues without it`);
  }

  // The image picker's whole catalogue: one entry per FILE the reel could cut
  // to — keyworded stills and the generic pool alike — each with the object key
  // the builder will honour and a thumbnail to show it by. Entries with no
  // public URL are dropped, since the picker must never offer an image it can't
  // display. Everything that can reach the reel is in here; nothing else can.
  const library = (reelPlan ? reelPlan.library || [] : [])
    .map(entry => ({ ...entry, url: publicUrl(entry.key) }))
    .filter(entry => entry.url);

  const reel = reelPlan
    ? {
        script: reelPlan.script,
        hook: reelPlan.hook || '',
        // Editor-facing switch; the reel is built with a music bed unless
        // this is ticked in review.
        noMusic: false,
        mood: reelPlan.mood,
        wordCount: reelPlan.wordCount,
        lines: reelPlan.lines.map(l => ({ text: l.text })),
        shots: reelPlan.shots.map((s, i) => {
          // The first shot is always replaced by the article photo at build
          // time; the draft shows that honestly — and still carries the library
          // image underneath, which is what opens the reel if the article's
          // photo turns out to be unusable. Both are shown in review, so there
          // is no image in the finished reel the editor didn't see.
          const cover = i === 0 && Boolean(coverUrl);
          return {
            ...s,
            cover,
            thumb: cover ? coverUrl : publicUrl(s.key),
            fallbackThumb: cover ? publicUrl(s.key) : null,
          };
        }),
        stockedKeywords: reelPlan.stockedKeywords,
        library,
      }
    : null;

  const draft = {
    version: 1,
    date,
    createdAt: new Date().toISOString(),
    story: {
      headline: story.headline,
      summary: story.summary,
      publisher: story.publisher,
      url: story.url,
    },
    researchBrief: String(raw.researchBrief || '').trim(),
    sources,
    verification,
    pillar,
    style,
    // The raw fact-checked fields are what the editor edits; captions and
    // slide copy are rebuilt from them at produce time.
    raw,
    cover: coverUrl ? { url: coverUrl } : null,
    reel,
  };

  fs.mkdirSync(PENDING_DIR, { recursive: true });
  const file = path.join(PENDING_DIR, `${date}.json`);
  fs.writeFileSync(file, JSON.stringify(draft, null, 2) + '\n');
  console.log(`  [review] draft written to review/pending/${date}.json`);

  let appUrl = null;
  try {
    appUrl = await publishReviewApp();
  } catch (e) {
    console.warn(`  [review] app publish failed (${e.message})`);
  }
  const reviewUrl = appUrl ? `${appUrl}?d=${date}` : null;

  return { file, date, reviewUrl, draft };
}

function readApproved(relPath) {
  const file = path.resolve(relPath);
  const draft = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!draft || !draft.raw || !draft.story) {
    throw new Error(`${relPath} does not look like an approved draft (missing raw/story)`);
  }
  return draft;
}

// Fetch the staged cover back as a data URI for the renderer, or null.
async function fetchCover(draft) {
  const url = draft.cover && draft.cover.url;
  if (!url) return null;
  try {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
    const type = (res.headers['content-type'] || 'image/jpeg').split(';')[0];
    return `data:${type};base64,${Buffer.from(res.data).toString('base64')}`;
  } catch (e) {
    console.warn(`  [review] staged cover fetch failed (${e.message})`);
    return null;
  }
}

module.exports = { writeDraft, readApproved, fetchCover, publishReviewApp, today };
