const fs = require('fs');
const path = require('path');
const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { filterToBank, siblingsOf, KEYWORD_SET } = require('./keywords');

// Reel assets live in their own bucket (default `rally-news-videos`), flat, in
// four folders:
//
//   images/   one still per keyword, no sub-folders. The FILENAME *is* the
//             keyword: forest.jpg, river.jpg, volunteers.jpg. Words must come
//             from the keyword bank (./keywords.js); anything else is ignored.
//   generic/  happy-planet stills with no particular subject, used whenever a
//             requested keyword has nothing better to offer.
//   audio/    Creative Commons music beds.
//   outro/    the "Follow Us" card as an MP4.
//
// Credentials are the same R2 account as the carousel; only the bucket differs.

const VIDEO_BUCKET = () => process.env.R2_VIDEO_BUCKET || 'rally-news-videos';
const IMAGE_PREFIX = () => process.env.R2_REELS_IMAGE_PREFIX || 'images/';
const GENERIC_PREFIX = () => process.env.R2_REELS_GENERIC_PREFIX || 'generic/';
const AUDIO_PREFIX = () => process.env.R2_REELS_AUDIO_PREFIX || 'audio/';
const OUTRO_PREFIX = () => process.env.R2_REELS_OUTRO_PREFIX || 'outro/';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.flac']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm']);

function getClient() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error('Missing R2 credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)');
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
}

// Split a filename into candidate words. Trailing counters (`-01`) are dropped
// so `river-02.jpg` and `river-17.jpg` both read as `river`.
function tokenize(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .split(/[^a-z0-9]+/)
    .map(t => t.replace(/\d+$/, ''))
    .filter(Boolean);
}

async function listAll(prefix) {
  const bucket = VIDEO_BUCKET();
  const client = getClient();

  const keys = [];
  let token;
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: token,
      MaxKeys: 1000,
    }));
    for (const obj of page.Contents || []) {
      if (obj.Size > 0) keys.push(obj.Key);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  return keys;
}

// Read the whole library: keyworded stills, the generic fallback pool, music,
// and the Follow Us card.
async function loadCatalogue() {
  const [imageKeys, genericKeys, audioKeys, outroKeys] = await Promise.all([
    listAll(IMAGE_PREFIX()),
    listAll(GENERIC_PREFIX()),
    listAll(AUDIO_PREFIX()),
    listAll(OUTRO_PREFIX()),
  ]);

  const images = [];
  const unknownWords = new Set();
  const unkeyworded = [];

  for (const key of imageKeys) {
    if (!IMAGE_EXT.has(path.extname(key).toLowerCase())) continue;
    const words = tokenize(path.basename(key));
    const keywords = filterToBank(words);
    for (const w of words) {
      if (w.length > 2 && !KEYWORD_SET.has(w)) unknownWords.add(w);
    }
    if (keywords.length) images.push({ key, keywords });
    else unkeyworded.push(key);
  }

  const generic = genericKeys.filter(k => IMAGE_EXT.has(path.extname(k).toLowerCase()));
  const tracks = audioKeys.filter(k => AUDIO_EXT.has(path.extname(k).toLowerCase()));
  const outros = outroKeys.filter(k => VIDEO_EXT.has(path.extname(k).toLowerCase()));

  // Surface naming problems rather than silently dropping the file: an image
  // named off-bank is invisible to the planner, and that's worth knowing.
  if (unkeyworded.length) {
    console.warn(
      `  [reel] ${unkeyworded.length} image(s) under ${IMAGE_PREFIX()} match no bank keyword ` +
      `and will never be picked — e.g. ${unkeyworded.slice(0, 3).map(k => path.basename(k)).join(', ')}`
    );
  }
  if (unknownWords.size) {
    console.warn(
      `  [reel] filename words not in the keyword bank (ignored): ` +
      `${[...unknownWords].slice(0, 15).join(', ')}`
    );
  }

  // Which bank words actually have a photo behind them — used to tell the
  // planner what it can realistically ask for.
  const stocked = new Set();
  const claimedBy = new Map();
  for (const img of images) {
    for (const k of img.keywords) {
      stocked.add(k);
      // One photo per keyword is the convention; a second file claiming the
      // same word isn't fatal, but it's almost always an accident.
      if (claimedBy.has(k)) {
        console.warn(
          `  [reel] keyword "${k}" is claimed by two files ` +
          `(${path.basename(claimedBy.get(k))}, ${path.basename(img.key)})`
        );
      } else {
        claimedBy.set(k, img.key);
      }
    }
  }

  return { images, generic, tracks, outros, stocked };
}

// How many of the requested keywords an image answers. Both sides come from
// the same fixed vocabulary, so this is an exact-match count with no fuzzy
// matching to go wrong.
function scoreImage(image, keywords) {
  let score = 0;
  for (const kw of keywords) {
    if (image.keywords.includes(kw)) score += 1;
  }
  return score;
}

// Best unused image answering any of `keywords`, or null.
function bestMatch(images, keywords, used, previous) {
  if (!keywords.length) return null;
  const scored = images
    .filter(img => img.key !== previous && !used.has(img.key) && scoreImage(img, keywords) > 0)
    .map(img => ({ key: img.key, score: scoreImage(img, keywords) + Math.random() * 0.5 }))
    .sort((a, b) => b.score - a.score);
  return scored.length ? scored[0].key : null;
}

function randomFrom(pool, used, previous) {
  const eligible = pool.filter(k => k !== previous);
  if (!eligible.length) return null;
  const fresh = eligible.filter(k => !used.has(k));
  const from = fresh.length ? fresh : eligible;
  return from[Math.floor(Math.random() * from.length)];
}

// Resolve a shot's keywords to an object key.
//
// The library is one photo per keyword, so a keyword can only be spent once
// per reel. That makes the ladder below matter: when the exact photo is gone,
// the next best thing is another photo from the SAME theme group, which is
// still on-topic, rather than a generic filler.
//
//   1. exact keyword match, not yet used
//   2. a sibling keyword from the same bank group, not yet used
//   3. the generic pool
//   4. the exact match again, even though it's been used
//   5. anything at all
//
// `previous` is the key on screen right now, and is excluded at every rung so
// two consecutive shots are never the same photo.
function pickImage(catalogue, keywords, used, previous) {
  const wanted = filterToBank(keywords);

  const exact = bestMatch(catalogue.images, wanted, used, previous);
  if (exact) return exact;

  const sibling = bestMatch(catalogue.images, siblingsOf(wanted), used, previous);
  if (sibling) return sibling;

  const generic = randomFrom(catalogue.generic, used, previous);
  if (generic) return generic;

  const repeat = catalogue.images
    .filter(img => img.key !== previous && scoreImage(img, wanted) > 0)
    .map(img => img.key);
  if (repeat.length) return repeat[Math.floor(Math.random() * repeat.length)];

  return randomFrom(catalogue.images.map(img => img.key), used, previous);
}

function pickTrack(tracks) {
  if (!tracks.length) return null;
  return tracks[Math.floor(Math.random() * tracks.length)];
}

// The Follow Us card. Whatever MP4 is in the outro folder — if there's more
// than one, the newest name wins, so `follow-us-v2.mp4` supersedes
// `follow-us.mp4` without deleting anything.
function pickOutro(outros) {
  if (!outros.length) return null;
  return [...outros].sort().pop();
}

// Finished reels go back into the same bucket under out/<date>/<slug>.mp4.
async function uploadReel(buffer, slug) {
  const client = getClient();
  const stamp = new Date().toISOString().slice(0, 10);
  const key = `out/${stamp}/${slug}.mp4`;

  await client.send(new PutObjectCommand({
    Bucket: VIDEO_BUCKET(),
    Key: key,
    Body: buffer,
    ContentType: 'video/mp4',
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  console.log(`  [r2] uploaded ${key}`);

  const base = (process.env.R2_VIDEO_PUBLIC_URL || process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
  return base ? `${base}/${key}` : null;
}

async function downloadObject(key, destPath) {
  const client = getClient();
  const res = await client.send(new GetObjectCommand({ Bucket: VIDEO_BUCKET(), Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  fs.writeFileSync(destPath, Buffer.concat(chunks));
  return destPath;
}

module.exports = {
  loadCatalogue,
  uploadReel,
  pickImage,
  pickTrack,
  pickOutro,
  downloadObject,
  tokenize,
  getClient,
  VIDEO_BUCKET,
  IMAGE_PREFIX,
  GENERIC_PREFIX,
  AUDIO_PREFIX,
  OUTRO_PREFIX,
};
