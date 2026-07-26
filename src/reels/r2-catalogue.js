const fs = require('fs');
const path = require('path');
const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { filterToBank, KEYWORD_SET } = require('./keywords');

// Reel assets live in their own bucket (default `rally-news-videos`), flat, in
// three folders:
//
//   images/   every keyworded still, no sub-folders. The FILENAME carries the
//             keywords: solar-panels-01.jpg → solar, panels. Words must come
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

  // Which bank words actually have images behind them — used to tell the
  // planner what it can realistically ask for.
  const stocked = new Set();
  for (const img of images) for (const k of img.keywords) stocked.add(k);

  return { images, generic, tracks, outros, stocked };
}

// How well an image answers a set of requested keywords. Only exact bank
// matches count — there is no fuzzy matching to go wrong, because both sides
// of the comparison are drawn from the same fixed vocabulary.
function scoreImage(image, keywords) {
  let score = 0;
  for (const kw of keywords) {
    if (image.keywords.includes(kw)) score += 3;
  }
  // A photo of exactly the thing asked for beats one that merely includes it.
  if (score > 0) score += 1 / image.keywords.length;
  return score;
}

// Resolve a shot's keywords to an object key.
//   1. best keyworded image that isn't already on screen
//   2. generic pool, if nothing in the library matches
//   3. any keyworded image, if there is no generic pool either
// `used` holds keys already spent in this reel so the same photo doesn't come
// round twice while unused ones are still available.
function pickImage(catalogue, keywords, used, previous) {
  const wanted = filterToBank(keywords);

  if (wanted.length) {
    const scored = catalogue.images
      .filter(img => img.key !== previous && scoreImage(img, wanted) > 0)
      .map(img => ({
        key: img.key,
        score: scoreImage(img, wanted) - (used.has(img.key) ? 2.5 : 0) + Math.random() * 0.3,
      }))
      .sort((a, b) => b.score - a.score);

    if (scored.length) return scored[0].key;
  }

  const genericPool = catalogue.generic.filter(k => k !== previous);
  if (genericPool.length) {
    const fresh = genericPool.filter(k => !used.has(k));
    const pool = fresh.length ? fresh : genericPool;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  const anyPool = catalogue.images.filter(img => img.key !== previous);
  if (!anyPool.length) return null;
  const fresh = anyPool.filter(img => !used.has(img.key));
  const pool = fresh.length ? fresh : anyPool;
  return pool[Math.floor(Math.random() * pool.length)].key;
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
