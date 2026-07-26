const fs = require('fs');
const path = require('path');
const { ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getClient } = require('../carousel/r2-uploader');

// The reel pulls its b-roll, music and closing card straight out of R2, so the
// creative library can grow without a code change. Layout (all prefixes are
// overridable, defaults shown):
//
//   reels/images/<keyword>/<keyword>-<n>.jpg   → b-roll stills
//   reels/audio/<mood>-<name>.mp3              → Creative Commons music beds
//   reels/outro/follow-us.mp4                  → the "Follow Us" Rally card
//
// Keywords come from the object key itself: every folder and filename segment
// under the prefix is tokenised, so `reels/images/solar/rooftop-panels-02.jpg`
// is findable as solar, rooftop, panels.
const IMAGE_PREFIX = () => process.env.R2_REELS_IMAGE_PREFIX || 'reels/images/';
const AUDIO_PREFIX = () => process.env.R2_REELS_AUDIO_PREFIX || 'reels/audio/';
const OUTRO_KEY = () => process.env.R2_REELS_OUTRO_KEY || 'reels/outro/follow-us.mp4';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.flac']);

// Tokens that carry no meaning for matching — filenames are full of them.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'the', 'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by',
  'from', 'img', 'image', 'photo', 'pic', 'stock', 'final', 'copy', 'v', 'jpg',
  'jpeg', 'png', 'webp', 'reels', 'reel', 'broll', 'b',
]);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(t => t.replace(/\d+$/, ''))
    .filter(t => t.length > 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

// Every object under a prefix, following pagination.
async function listAll(prefix) {
  const bucket = process.env.R2_BUCKET;
  if (!bucket) throw new Error('Missing R2_BUCKET');
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

// Read the image + music library and build the keyword index the shot planner
// picks from.
async function loadCatalogue() {
  const imagePrefix = IMAGE_PREFIX();
  const audioPrefix = AUDIO_PREFIX();

  const [imageKeys, audioKeys] = await Promise.all([
    listAll(imagePrefix),
    listAll(audioPrefix),
  ]);

  const images = imageKeys
    .filter(k => IMAGE_EXT.has(path.extname(k).toLowerCase()))
    .map(key => ({ key, tokens: tokenize(key.slice(imagePrefix.length)) }))
    .filter(img => img.tokens.length);

  const tracks = audioKeys.filter(k => AUDIO_EXT.has(path.extname(k).toLowerCase()));

  // Vocabulary handed to the model, most common keyword first, so it only ever
  // asks for keywords that actually resolve to a file.
  const counts = new Map();
  for (const img of images) {
    for (const t of new Set(img.tokens)) counts.set(t, (counts.get(t) || 0) + 1);
  }
  const vocabulary = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t);

  return { images, tracks, vocabulary };
}

// Score one image against a set of requested keywords. Exact token hits weigh
// most; prefix hits ("solar" vs "solarfarm") still count so near-misses from
// the model resolve to something sensible.
function scoreImage(image, keywords) {
  let score = 0;
  for (const kw of keywords) {
    const k = String(kw || '').toLowerCase().trim();
    if (!k) continue;
    if (image.tokens.includes(k)) score += 3;
    else if (image.tokens.some(t => t.startsWith(k) || k.startsWith(t))) score += 1.5;
    else if (image.key.toLowerCase().includes(k)) score += 1;
  }
  return score;
}

// Resolve a shot's keywords to a concrete object key. `used` holds keys already
// spent in this reel and `previous` is the key on screen right now — we never
// repeat an image back-to-back, and we prefer one that hasn't been used yet so
// a 20-shot reel doesn't cycle through the same four photos.
function pickImage(catalogue, keywords, used, previous) {
  const candidates = catalogue.images
    .filter(img => img.key !== previous)
    .map(img => ({
      img,
      score: scoreImage(img, keywords) + (used.has(img.key) ? -2.5 : 0) + Math.random() * 0.4,
    }))
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) return null;
  return candidates[0].img.key;
}

async function downloadObject(key, destPath) {
  const bucket = process.env.R2_BUCKET;
  const client = getClient();
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  const buf = Buffer.concat(chunks);
  fs.writeFileSync(destPath, buf);
  return destPath;
}

function pickTrack(tracks) {
  if (!tracks.length) return null;
  return tracks[Math.floor(Math.random() * tracks.length)];
}

module.exports = {
  loadCatalogue,
  pickImage,
  pickTrack,
  downloadObject,
  tokenize,
  IMAGE_PREFIX,
  AUDIO_PREFIX,
  OUTRO_KEY,
};
