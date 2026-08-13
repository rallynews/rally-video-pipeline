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
// Those four names are only the defaults. The folders can sit anywhere in the
// bucket — under a `videos/` parent, say — as long as the R2_REELS_*_PREFIX
// variables point at them. And if the configured image folder turns up empty,
// the catalogue scans the bucket and adopts whatever folder the b-roll is
// actually in rather than failing the run (see resolveByScanning below).
//
// Credentials are the same R2 account as the carousel; only the bucket differs.

const VIDEO_BUCKET = () => process.env.R2_VIDEO_BUCKET || 'rally-news-videos';
const IMAGE_PREFIX = () => normalizePrefix(process.env.R2_REELS_IMAGE_PREFIX, 'images/');
const GENERIC_PREFIX = () => normalizePrefix(process.env.R2_REELS_GENERIC_PREFIX, 'generic/');
const AUDIO_PREFIX = () => normalizePrefix(process.env.R2_REELS_AUDIO_PREFIX, 'audio/');
const OUTRO_PREFIX = () => normalizePrefix(process.env.R2_REELS_OUTRO_PREFIX, 'outro/');

// Folders the pipeline WRITES. They're full of images (carousel slides) and
// MP4s (yesterday's reels), so they'd poison any scan of the bucket.
const OUTPUT_PREFIXES = ['carousels/', 'reels/'];

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.flac']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm']);

// `videos` and `/videos` and `videos/` are all the same folder as far as the
// person typing them into a GitHub variable is concerned.
function normalizePrefix(value, fallback) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return fallback === undefined ? '' : fallback;
  const trimmed = raw.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed ? `${trimmed}/` : '';
}

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

const extOf = key => path.extname(String(key || '')).toLowerCase();
const isImageKey = key => IMAGE_EXT.has(extOf(key));
const isAudioKey = key => AUDIO_EXT.has(extOf(key));
const isVideoKey = key => VIDEO_EXT.has(extOf(key));

const isOutputKey = key => OUTPUT_PREFIXES.some(p => String(key || '').startsWith(p));

// The folder a key sits directly in — `videos/aid.jpg` → `videos/`, a key at
// the bucket root → ''.
function folderOf(key) {
  const cut = String(key || '').lastIndexOf('/');
  return cut === -1 ? '' : key.slice(0, cut + 1);
}

// Keys under `prefix`, minus anything that belongs to one of the OTHER pools
// nested beneath it. Without this, an image prefix of `videos/` swallows
// `videos/generic/` and `videos/outro/` too, and the generic pool gets counted
// twice — once as fallback, once as unkeyworded b-roll.
function scopeTo(keys, prefix, siblings) {
  const nested = (siblings || []).filter(p => p && p !== prefix && p.startsWith(prefix));
  return keys.filter(key =>
    key.startsWith(prefix) && !nested.some(p => key.startsWith(p))
  );
}

// Split one flat key list into the four pools.
function partition(keys, prefixes) {
  const all = Object.values(prefixes);
  return {
    image: scopeTo(keys, prefixes.image, all).filter(isImageKey),
    generic: scopeTo(keys, prefixes.generic, all).filter(isImageKey),
    audio: scopeTo(keys, prefixes.audio, all).filter(isAudioKey),
    outro: scopeTo(keys, prefixes.outro, all).filter(isVideoKey),
  };
}

// How many images in a folder are named after a bank keyword — the signal that
// separates a b-roll library from a folder of carousel slides.
function keywordedCount(keys) {
  return keys.filter(k => isImageKey(k) && filterToBank(tokenize(path.basename(k))).length).length;
}

// Every folder in the bucket that could hold reel assets, with the counts that
// decide what it is. Pipeline output is excluded outright.
function surveyFolders(keys) {
  const byFolder = new Map();
  for (const key of keys) {
    if (isOutputKey(key)) continue;
    const folder = folderOf(key);
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push(key);
  }

  return [...byFolder.entries()]
    .map(([folder, ks]) => ({
      folder,
      keys: ks,
      images: ks.filter(isImageKey).length,
      keyworded: keywordedCount(ks),
      audio: ks.filter(isAudioKey).length,
      videos: ks.filter(isVideoKey).length,
    }))
    .sort((a, b) => a.folder.localeCompare(b.folder));
}

const lastSegment = folder => String(folder || '').replace(/\/$/, '').split('/').pop();

// Best guess at each pool from the survey. Names win when they're obvious
// (`.../audio/`), otherwise it's whichever folder holds the most of the right
// kind of file.
function guessPrefixes(survey) {
  const byName = (names, test) =>
    survey.filter(f => names.includes(lastSegment(f.folder)) && test(f))[0] || null;
  const byCount = (test, count) =>
    survey.filter(test).sort((a, b) => count(b) - count(a))[0] || null;

  const image = byName(['images', 'stills', 'broll', 'b-roll'], f => f.keyworded > 0)
    || byCount(f => f.keyworded > 0, f => f.keyworded);

  const generic = byName(['generic', 'fallback'], f => f.images > 0)
    || byCount(f => f.images > 0 && (!image || f.folder !== image.folder) && f.keyworded === 0, f => f.images);

  const audio = byName(['audio', 'music', 'tracks'], f => f.audio > 0)
    || byCount(f => f.audio > 0, f => f.audio);

  const outro = byName(['outro', 'outros', 'ending'], f => f.videos > 0)
    || byCount(f => f.videos > 0, f => f.videos);

  return {
    image: image && image.folder,
    generic: generic && generic.folder,
    audio: audio && audio.folder,
    outro: outro && outro.folder,
  };
}

// Read every key in the bucket once, so the survey and the pools come out of a
// single pass. Only used when something looks misconfigured.
async function scanBucket() {
  const keys = await listAll('');
  return { keys, survey: surveyFolders(keys) };
}

// The image folder came back empty. Before failing the run, look at what's
// actually in the bucket: nine times out of ten the library is there under a
// different prefix (uploaded to `videos/` rather than `images/`, say).
//
// A prefix the operator set by hand is never overridden — that's their
// decision, and silently using a different folder would hide the typo. Defaults
// are fair game, and every substitution is logged with the variable that makes
// it permanent.
async function resolveByScanning(prefixes, explicit) {
  const { keys, survey } = await scanBucket();
  const guess = guessPrefixes(survey);

  const resolved = { ...prefixes };
  const adopted = [];
  const VARS = {
    image: 'R2_REELS_IMAGE_PREFIX',
    generic: 'R2_REELS_GENERIC_PREFIX',
    audio: 'R2_REELS_AUDIO_PREFIX',
    outro: 'R2_REELS_OUTRO_PREFIX',
  };

  const before = partition(keys, prefixes);
  for (const pool of ['image', 'generic', 'audio', 'outro']) {
    const found = guess[pool];
    if (!found || found === prefixes[pool] || before[pool].length) continue;
    if (explicit[pool]) {
      console.warn(
        `  [reel] ${VARS[pool]}=${prefixes[pool]} is empty, but ${describeFolder(survey, found)} ` +
        `looks like the ${pool} folder — leaving your setting alone`
      );
      continue;
    }
    resolved[pool] = found;
    adopted.push({ pool, from: prefixes[pool], to: found });
  }

  if (adopted.length) {
    console.warn(`  [reel] the expected folders are empty — using what's in the bucket instead:`);
    for (const a of adopted) {
      console.warn(`  [reel]   ${a.pool}: ${a.from || '(bucket root)'} → ${a.to || '(bucket root)'}`);
    }
    console.warn(
      `  [reel] set ${adopted.map(a => `${VARS[a.pool]}=${a.to}`).join(', ')} ` +
      `(GitHub → Settings → Secrets and variables → Actions → Variables) to make this explicit`
    );
  } else {
    const folders = survey.filter(f => f.keys.length).map(f => `${f.folder || '(root)'} (${f.keys.length})`);
    console.warn(
      `  [reel] nothing usable found by scanning either — folders in ${VIDEO_BUCKET()}: ` +
      `${folders.join(', ') || '(bucket is empty)'}`
    );
  }

  return { prefixes: resolved, pools: partition(keys, resolved), survey };
}

function describeFolder(survey, folder) {
  const f = survey.find(x => x.folder === folder);
  const name = folder || '(bucket root)';
  if (!f) return name;
  return `${name} (${f.images} image(s), ${f.audio} audio, ${f.videos} video)`;
}

// Read the whole library: keyworded stills, the generic fallback pool, music,
// and the Follow Us card.
async function loadCatalogue() {
  let prefixes = {
    image: IMAGE_PREFIX(),
    generic: GENERIC_PREFIX(),
    audio: AUDIO_PREFIX(),
    outro: OUTRO_PREFIX(),
  };
  const explicit = {
    image: Boolean(String(process.env.R2_REELS_IMAGE_PREFIX || '').trim()),
    generic: Boolean(String(process.env.R2_REELS_GENERIC_PREFIX || '').trim()),
    audio: Boolean(String(process.env.R2_REELS_AUDIO_PREFIX || '').trim()),
    outro: Boolean(String(process.env.R2_REELS_OUTRO_PREFIX || '').trim()),
  };

  const listed = await Promise.all(
    ['image', 'generic', 'audio', 'outro'].map(pool => listAll(prefixes[pool]))
  );
  let pools = partition([...new Set(listed.flat())], prefixes);

  // No b-roll where we looked: find out why before giving up.
  if (!pools.image.length && !pools.generic.length) {
    const rescued = await resolveByScanning(prefixes, explicit);
    prefixes = rescued.prefixes;
    pools = rescued.pools;
  }

  const imageKeys = pools.image;
  const images = [];
  const unknownWords = new Set();
  const unkeyworded = [];

  for (const key of imageKeys) {
    const words = tokenize(path.basename(key));
    const keywords = filterToBank(words);
    for (const w of words) {
      if (w.length > 2 && !KEYWORD_SET.has(w)) unknownWords.add(w);
    }
    if (keywords.length) images.push({ key, keywords });
    else unkeyworded.push(key);
  }

  const generic = pools.generic;
  const tracks = pools.audio;
  const outros = pools.outro;

  // Surface naming problems rather than silently dropping the file: an image
  // named off-bank is invisible to the planner, and that's worth knowing.
  if (unkeyworded.length) {
    console.warn(
      `  [reel] ${unkeyworded.length} image(s) under ${prefixes.image || '(bucket root)'} ` +
      `match no bank keyword and will never be picked — ` +
      `e.g. ${unkeyworded.slice(0, 3).map(k => path.basename(k)).join(', ')}`
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

  // `prefixes` travels with the catalogue so callers report the folders that
  // were actually read, not the ones that were configured.
  return { images, generic, tracks, outros, stocked, prefixes };
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

// Resolve keywords that came back from REVIEW rather than from the planner.
// There a keyword is a decision, not a suggestion — the editor picked it off a
// list of real photos, or the draft resolved it and showed them the result — so
// the exact photo wins even when another shot has already spent it. Only the
// frame on screen right now is excluded, so a cut never lands on the picture
// it is cutting from. Anything genuinely unmatched falls back to the ladder.
function pickRequested(catalogue, keywords, used, previous) {
  const wanted = filterToBank(keywords);

  const fresh = bestMatch(catalogue.images, wanted, used, previous);
  if (fresh) return fresh;

  const spent = catalogue.images
    .filter(img => img.key !== previous && scoreImage(img, wanted) > 0)
    .sort((a, b) => scoreImage(b, wanted) - scoreImage(a, wanted))[0];
  if (spent) return spent.key;

  return pickImage(catalogue, wanted, used, previous);
}

// The filename, minus folder and extension — how an image is named in the
// review app's picker. `videos/forest.jpg` → `forest`.
const labelOf = key => path.basename(String(key || '')).replace(/\.[a-z0-9]+$/i, '');

// Every image the reel could possibly cut to — the keyworded stills AND the
// generic pool — as the review app needs them: a stable object key, a label to
// search on, and the bank keywords behind it.
//
// The picker is built from this list and the builder honours the key it hands
// back, so the images offered in review are exactly the images that can reach
// the finished reel. Anything missing here is a photo the editor could end up
// with but never saw, which is the whole reason this list exists. Note that
// it's per-FILE, not per-keyword: two files claiming `forest` are two entries,
// and a generic still with no keyword at all is still choosable.
function libraryEntries(lib) {
  const entries = [
    ...(lib.images || []).map(img => ({
      key: img.key, label: labelOf(img.key), keywords: img.keywords, pool: 'keyword',
    })),
    ...(lib.generic || []).map(key => ({
      key, label: labelOf(key), keywords: [], pool: 'generic',
    })),
  ];
  // Keyworded first, alphabetical within each pool — the order the picker lists.
  entries.sort((a, b) =>
    (a.pool === b.pool ? 0 : a.pool === 'keyword' ? -1 : 1) ||
    a.label.localeCompare(b.label)
  );
  return entries;
}

// Is this exact object still in the library? Images can be renamed, replaced or
// deleted between the morning draft and the approval, so a reviewed choice is
// checked before it's trusted.
function hasKey(lib, key) {
  if (!key) return false;
  return (lib.images || []).some(img => img.key === key) ||
         (lib.generic || []).includes(key);
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

// Every day's finished reel is archived back into the same bucket, mirroring
// how the carousel archives its slides (carousels/<date>/<slug>/slide-N.png):
//
//   reels/<date>/<slug>.mp4
//
// One file per run, dated and named after the story, so the whole back
// catalogue is browsable by date without ever overwriting yesterday's.
async function uploadReel(buffer, slug) {
  const client = getClient();
  const stamp = new Date().toISOString().slice(0, 10);
  const key = `reels/${stamp}/${slug}.mp4`;

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
  pickRequested,
  libraryEntries,
  labelOf,
  hasKey,
  pickTrack,
  pickOutro,
  downloadObject,
  tokenize,
  getClient,
  listAll,
  scanBucket,
  surveyFolders,
  guessPrefixes,
  partition,
  normalizePrefix,
  keywordedCount,
  isImageKey,
  isAudioKey,
  isVideoKey,
  isOutputKey,
  OUTPUT_PREFIXES,
  VIDEO_BUCKET,
  IMAGE_PREFIX,
  GENERIC_PREFIX,
  AUDIO_PREFIX,
  OUTRO_PREFIX,
};
