#!/usr/bin/env node
// Build one reel from canned copy, without touching the RSS feed, the web
// research, the fact-checker, Telegram or Slack. Use it to check that the R2
// library, the voice key and ffmpeg are all wired up before turning the reel on
// in the daily run:
//
//   node scripts/reel-check.js            # writes reel-check.mp4
//   node scripts/reel-check.js out.mp4
//
// Needs: R2_* credentials, one voice key (AZURE_SPEECH_KEY et al),
// OPENROUTER_API_KEY, and ffmpeg on PATH.

const fs = require('fs');
const path = require('path');
const { generateReel, missingPrerequisite } = require('../src/reels');
const { getCoverImage } = require('../src/carousel/cover-image');

// Stands in for a fact-checked carousel: same shape, same fields.
const STORY = {
  headline: 'Rewilded riverbanks bring a dried-up river back to life',
  summary: 'Farmers along a coastal river gave up a strip of land to restore the floodplain.',
  publisher: 'The Guardian',
  url: 'https://rally.news/example',
};

const SLIDE_COPY = {
  pillar: 'Climate & Environment',
  source: 'The Guardian',
  headline: 'Can a river really come back? The Guardian just reported something people had written off for good.',
  challenge: 'The river had been dropping every summer for a decade, and the town had started to accept it was gone.',
  solution: 'A handful of farmers handed a strip of their land back to the floodplain and let the water spread out again.',
  resultHeading: 'The river is running year-round again',
  resultLine: 'Fish have returned with it — full story at the link in bio.',
  whyMatters: 'It is proof that reversing environmental damage does not always take decades or billions.',
};

const RAW = {
  whyMatters: SLIDE_COPY.whyMatters,
  engagementQuestion: 'But what do you think — would you give up part of your land for this?',
};

(async () => {
  const blocked = missingPrerequisite();
  if (blocked) {
    console.error(`Cannot build a reel: ${blocked}`);
    process.exit(1);
  }

  const out = path.resolve(process.argv[2] || 'reel-check.mp4');

  // The example story has no real article behind it, so there's no featured
  // photo to open on — pass undefined and the reel opens on library footage.
  // Point REEL_CHECK_STORY_URL at a real rally.news article to exercise the
  // cover-photo path too.
  let coverUri;
  if (process.env.REEL_CHECK_STORY_URL) {
    coverUri = await getCoverImage({ url: process.env.REEL_CHECK_STORY_URL });
  }

  const reel = await generateReel(STORY, SLIDE_COPY, RAW, coverUri);
  fs.writeFileSync(out, reel.buffer);

  console.log(`\nScript (${reel.wordCount} words):\n  ${reel.script}\n`);
  console.log('Shots:');
  for (const s of reel.shots) {
    console.log(`  ${String(s.start).padStart(6)}s  ${String(s.duration).padStart(5)}s  ${s.transition.padEnd(11)} ${s.motion.padEnd(10)} ${s.key}`);
  }
  console.log(`\nVoice:  ${reel.voice}`);
  console.log(`Music:  ${reel.track || '(none)'}`);
  console.log(`Ending: ${reel.outroSource}`);
  console.log(`\nWrote ${out} — ${reel.duration.toFixed(1)}s, ${(reel.buffer.length / 1024 / 1024).toFixed(1)} MB`);
})().catch(err => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
