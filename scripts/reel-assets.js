#!/usr/bin/env node
// What's actually in the reel bucket, and whether the reel builder can see it.
//
//   node scripts/reel-assets.js              # report only, touches nothing
//   node scripts/reel-assets.js --tidy       # show the moves that would put
//                                            # everything in the standard folders
//   node scripts/reel-assets.js --tidy --apply   # actually move them
//
// The report is the fast answer to "why did the reel say 0 images?": it lists
// every folder in the bucket, says which one the builder resolves each pool to,
// and prints the R2_REELS_*_PREFIX line that pins it.
//
// `--tidy` copies assets into the layout the README documents (images/,
// generic/, audio/, outro/) using server-side copies — no download, no upload,
// no egress — then deletes the originals. It never touches carousels/ or
// reels/, which are pipeline output.
//
// Needs: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.

const path = require('path');
const { CopyObjectCommand, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const cat = require('../src/reels/r2-catalogue');
const { ALL_KEYWORDS, filterToBank } = require('../src/reels/keywords');

const POOLS = ['image', 'generic', 'audio', 'outro'];
const VARS = {
  image: 'R2_REELS_IMAGE_PREFIX',
  generic: 'R2_REELS_GENERIC_PREFIX',
  audio: 'R2_REELS_AUDIO_PREFIX',
  outro: 'R2_REELS_OUTRO_PREFIX',
};
const STANDARD = { image: 'images/', generic: 'generic/', audio: 'audio/', outro: 'outro/' };

const argv = process.argv.slice(2);
const TIDY = argv.includes('--tidy');
const APPLY = argv.includes('--apply');

function configuredPrefixes() {
  return {
    image: cat.IMAGE_PREFIX(),
    generic: cat.GENERIC_PREFIX(),
    audio: cat.AUDIO_PREFIX(),
    outro: cat.OUTRO_PREFIX(),
  };
}

function show(folder) {
  return folder === '' ? '(bucket root)' : folder;
}

function reportFolders(survey) {
  console.log(`\nFolders in ${cat.VIDEO_BUCKET()} (pipeline output excluded):`);
  if (!survey.length) {
    console.log('  (nothing — the bucket holds no reel assets)');
    return;
  }
  for (const f of survey) {
    const bits = [
      `${f.keys.length} object(s)`,
      f.images ? `${f.images} image` : null,
      f.keyworded ? `${f.keyworded} keyworded` : null,
      f.audio ? `${f.audio} audio` : null,
      f.videos ? `${f.videos} video` : null,
    ].filter(Boolean);
    console.log(`  ${show(f.folder).padEnd(28)} ${bits.join(', ')}`);
  }
}

// What the builder will read today, and what it would read if the prefixes
// were left at their defaults — the difference is the misconfiguration.
function resolve(survey, keys) {
  const configured = configuredPrefixes();
  const guessed = cat.guessPrefixes(survey);
  const pools = cat.partition(keys, configured);

  const effective = { ...configured };
  for (const pool of POOLS) {
    // Mirrors loadCatalogue: an empty image folder sends it scanning, and the
    // scan only fills pools that came back empty.
    if (!pools.image.length && !pools.generic.length && !pools[pool].length && guessed[pool]) {
      effective[pool] = guessed[pool];
    }
  }
  return { configured, guessed, effective, pools: cat.partition(keys, effective) };
}

function reportPools({ configured, effective, pools }) {
  console.log('\nWhat the reel builder reads:');
  for (const pool of POOLS) {
    const moved = configured[pool] !== effective[pool];
    const count = pools[pool].length;
    const note = moved ? `  (configured ${show(configured[pool])} is empty — auto-detected)` : '';
    console.log(`  ${pool.padEnd(8)} ${show(effective[pool]).padEnd(24)} ${String(count).padStart(4)} file(s)${note}`);
  }

  const drift = POOLS.filter(p => configured[p] !== effective[p]);
  if (drift.length) {
    console.log('\nPin it (GitHub → Settings → Secrets and variables → Actions → Variables):');
    for (const pool of drift) console.log(`  ${VARS[pool]} = ${effective[pool]}`);
  }
}

function reportKeywords(pools) {
  const stocked = new Set();
  const offBank = [];
  for (const key of pools.image) {
    const hits = filterToBank(cat.tokenize(path.basename(key)));
    if (hits.length) hits.forEach(k => stocked.add(k));
    else offBank.push(path.basename(key));
  }

  console.log(
    `\nKeyword coverage: ${stocked.size}/${ALL_KEYWORDS.length} bank words have a photo` +
    ` (${pools.generic.length} generic fallback image(s))`
  );
  if (offBank.length) {
    console.log(
      `  ${offBank.length} image(s) match no bank keyword and can never be picked: ` +
      `${offBank.slice(0, 8).join(', ')}${offBank.length > 8 ? ', …' : ''}`
    );
  }
  const missing = ALL_KEYWORDS.filter(k => !stocked.has(k));
  if (missing.length) {
    console.log(`  ${missing.length} unstocked, e.g. ${missing.slice(0, 12).join(', ')}`);
  }
}

function reportReadiness(pools) {
  console.log('\nReadiness:');
  const lines = [
    pools.image.length || pools.generic.length
      ? `  ok    b-roll: ${pools.image.length} library image(s) + ${pools.generic.length} generic`
      : '  FAIL  no b-roll — the reel cannot build without images',
    pools.audio.length
      ? `  ok    music: ${pools.audio.length} track(s)`
      : '  warn  no music — reels will be voice-only',
    pools.outro.length
      ? `  ok    ending: ${pools.outro.length} outro video(s)`
      : '  warn  no outro MP4 — a rendered Follow Us card is used instead',
  ];
  lines.forEach(l => console.log(l));
}

// Moves that would put every asset in the documented layout. Only pools that
// resolved to a non-standard folder are touched, and files already in the right
// place are left alone.
function planTidy(effective, pools) {
  const moves = [];
  const taken = new Set();

  for (const pool of POOLS) {
    const target = STANDARD[pool];
    for (const key of pools[pool]) {
      const dest = `${target}${path.basename(key)}`;
      if (dest === key) continue;
      if (taken.has(dest)) {
        console.warn(`  skip  ${key} — ${dest} is already claimed by another file`);
        continue;
      }
      taken.add(dest);
      moves.push({ from: key, to: dest });
    }
  }
  return moves;
}

async function runTidy(moves) {
  const client = cat.getClient();
  const Bucket = cat.VIDEO_BUCKET();

  let done = 0;
  const moved = [];
  for (const move of moves) {
    await client.send(new CopyObjectCommand({
      Bucket,
      CopySource: `${Bucket}/${encodeURIComponent(move.from).replace(/%2F/g, '/')}`,
      Key: move.to,
    }));
    moved.push(move);
    done += 1;
    if (done % 25 === 0 || done === moves.length) {
      console.log(`  copied ${done}/${moves.length}`);
    }
  }

  // Only delete once every copy has landed — a half-copied library is worse
  // than a misfiled one.
  for (let i = 0; i < moved.length; i += 1000) {
    const batch = moved.slice(i, i + 1000);
    await client.send(new DeleteObjectsCommand({
      Bucket,
      Delete: { Objects: batch.map(m => ({ Key: m.from })), Quiet: true },
    }));
  }
  console.log(`  removed ${moved.length} original(s)`);
}

(async () => {
  if (!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.error('Missing R2 credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)');
    process.exit(1);
  }

  const { keys, survey } = await cat.scanBucket();
  console.log(`${keys.length} object(s) in ${cat.VIDEO_BUCKET()}`);

  reportFolders(survey);
  const resolution = resolve(survey, keys);
  reportPools(resolution);
  reportKeywords(resolution.pools);
  reportReadiness(resolution.pools);

  if (!TIDY) {
    console.log('\nRun with --tidy to see how to move these into images/, generic/, audio/ and outro/.');
    return;
  }

  const moves = planTidy(resolution.effective, resolution.pools);
  if (!moves.length) {
    console.log('\nNothing to tidy — everything is already in the standard folders.');
    return;
  }

  console.log(`\n${moves.length} move(s)${APPLY ? '' : ' (dry run — add --apply to perform them)'}:`);
  for (const m of moves.slice(0, 10)) console.log(`  ${m.from} → ${m.to}`);
  if (moves.length > 10) console.log(`  … and ${moves.length - 10} more`);

  if (!APPLY) return;

  console.log('\nMoving (server-side copy, then delete)...');
  await runTidy(moves);
  console.log('Done. Clear any R2_REELS_*_PREFIX variables so the defaults apply again.');
})().catch(err => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
