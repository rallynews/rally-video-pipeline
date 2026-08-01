const { getMostViralStory } = require('./src/story-fetcher');
const { generateCarouselCopy, buildFromRaw } = require('./src/carousel/copy-generator');
const { verifyCarouselCopy } = require('./src/carousel/fact-checker');
const { getCoverImage } = require('./src/carousel/cover-image');
const { renderCarousel, pickStyle } = require('./src/carousel/renderer');
const { uploadCarousel } = require('./src/carousel/r2-uploader');
const { uploadReel } = require('./src/reels/r2-catalogue');
const { sendCarousel } = require('./src/carousel/carousel-telegram');
const slack = require('./src/carousel/slack-sender');
const reels = require('./src/reels');
const review = require('./src/review/draft');
const { proofread } = require('./src/review/proofreader');
const { sendDraftNotice } = require('./src/review/notify');
const { updateRSSFeed } = require('./src/rss-updater');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Three modes:
//
//   draft            (default) — research, write, fact-check, plan the reel,
//                    then STOP: write review/pending/<date>.json and send the
//                    review link. Nothing is rendered, voiced or posted.
//   produce <file>   build and deliver from an approved review file. Run by
//                    the produce workflow when the review app commits an
//                    approval to review/approved/.
//   full             the original unreviewed pipeline, end to end. Used when
//                    REVIEW_MODE=off (vacation bypass) or --full is passed.
//
// Precedence: CLI flag > REVIEW_MODE env ('off' → full) > default draft.

function resolveMode() {
  const args = process.argv.slice(2);
  if (args[0] === 'produce' || args[0] === '--produce') {
    if (!args[1]) throw new Error('produce mode needs a path: node carousel.js produce review/approved/<date>.json');
    return { mode: 'produce', file: args[1] };
  }
  if (args[0] === 'full' || args[0] === '--full') return { mode: 'full' };
  if (args[0] === 'draft' || args[0] === '--draft') return { mode: 'draft' };
  if ((process.env.REVIEW_MODE || '').toLowerCase() === 'off') return { mode: 'full' };
  return { mode: 'draft' };
}

async function sendErrorAlert(error) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        // Plain text deliberately: an error message containing an underscore
        // or asterisk would make Telegram reject the alert, losing the very
        // notification that says something broke.
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: `⚠️ Rally News carousel pipeline failed\n\n${error.message}\n\nCheck GitHub Actions for details.`,
        disable_web_page_preview: true,
      }
    );
    if (process.env.BREVO_API_KEY && process.env.ALERT_EMAIL) {
      await axios.post(
        'https://api.brevo.com/v3/smtp/email',
        {
          sender: { name: 'Rally News Pipeline', email: 'pipeline@rallynews.com' },
          to: [{ email: process.env.ALERT_EMAIL }],
          subject: '⚠️ Rally News carousel pipeline failed',
          textContent: `Failed on ${new Date().toISOString()}\n\nError: ${error.message}\n\nCheck your GitHub Actions logs for details.`,
        },
        { headers: { 'api-key': process.env.BREVO_API_KEY } }
      );
    }
  } catch (e) {
    console.error('Could not send alert:', e.message);
  }
}

function slugify(text) {
  return String(text || 'story')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'story';
}

// Stories the editor has re-rolled away today. The review app appends the
// rejected story's URL to review/reroll/<date>.json; that commit re-triggers
// the draft workflow, and this exclusion list keeps the new pick fresh.
function todaysExclusions() {
  const file = path.join(__dirname, 'review', 'reroll', `${review.today()}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed.exclude) ? parsed.exclude : [];
  } catch {
    return [];
  }
}

// Research and write today's editorial: story → copy → fact-check → cover.
// Shared by draft and full modes.
async function buildEditorial() {
  console.log('📰 Selecting most viral story from RSS...');
  const exclusions = todaysExclusions();
  if (exclusions.length) console.log(`   Re-rolled away: ${exclusions.join(', ')}`);
  const story = await getMostViralStory(exclusions);
  console.log(`   Selected: "${story.headline}"`);

  console.log('\n✍️  Researching story and writing carousel copy...');
  const round1 = await generateCarouselCopy(story);
  console.log(`   Pillar: ${round1.pillar}`);
  console.log(`   Headline: ${round1.slideCopy.headline}`);

  console.log('\n🔎 Fact-checking copy against the article before production...');
  const verified = await verifyCarouselCopy(story, round1.raw);
  if (verified.ran) {
    const corrected = verified.report.filter(r => r.verdict === 'corrected');
    console.log(`   Checked ${verified.report.length} field(s); ${corrected.length} rewritten.`);
    for (const r of verified.report) {
      console.log(`     • ${r.field}: ${r.verdict}${r.note ? ' — ' + r.note : ''}`);
    }
  }
  const { pillar, slideCopy, captions } = buildFromRaw(verified.raw, story);
  const sources = verified.sources;
  const verification = { ran: verified.ran, report: verified.report };
  console.log(`   Sources: ${sources.length ? sources.join(', ') : '(none returned)'}`);

  console.log('\n🖼️  Fetching cover image...');
  const coverUri = await getCoverImage(story);

  return { story, raw: verified.raw, pillar, slideCopy, captions, sources, verification, coverUri };
}

// Render, build, upload and deliver — from copy that is already final
// (either fact-checked-and-approved, or fact-checked in full mode).
async function produceAndDeliver({ story, raw, pillar, slideCopy, captions, sources, verification, coverUri, style, approvedReel, proofreading }) {
  console.log('\n🎨 Rendering carousel slides...');
  const rendered = await renderCarousel(slideCopy, coverUri, style || pickStyle());
  console.log(`   Rendered ${rendered.images.length} slides in style ${rendered.style}`);

  console.log('\n☁️  Uploading slides to Cloudflare R2...');
  let imageUrls = [];
  try {
    imageUrls = await uploadCarousel(rendered.images, slugify(story.headline));
  } catch (e) {
    console.warn(`   R2 upload failed (${e.message}) — continuing with Telegram delivery only.`);
  }

  let reel = null;
  if (reels.isConfigured()) {
    console.log('\n🎬 Building the 9:16 reel...');
    try {
      reel = await reels.generateReel(story, slideCopy, raw, coverUri, approvedReel);
      try {
        reel.url = await uploadReel(reel.buffer, slugify(story.headline));
      } catch (e) {
        console.warn(`   Reel R2 upload failed (${e.message}) — sending the file only.`);
      }
    } catch (e) {
      console.warn(`   Reel generation failed (${e.message}) — carousel unaffected.`);
      reel = null;
    }
  } else {
    console.log(`\n🎬 Reel skipped — ${reels.missingPrerequisite()}.`);
  }

  const delivery = {
    story, pillar, style: rendered.style, images: rendered.images,
    captions, imageUrls, sources, verification, reel, proofreading,
  };

  console.log('\n📱 Sending carousel to Telegram...');
  await sendCarousel(delivery);

  if (slack.isConfigured()) {
    console.log('\n💬 Sending carousel to Slack...');
    try {
      await slack.sendCarousel(delivery);
    } catch (e) {
      console.warn(`   Slack delivery failed (${e.message}) — Telegram already delivered.`);
    }
  } else {
    console.log('\n💬 Slack not configured (SLACK_BOT_TOKEN / SLACK_CHANNEL_ID) — skipping.');
  }

  console.log('\n📡 Updating RSS feed...');
  updateRSSFeed(story);

  console.log(`\n✅ Done! 6 slides${reel ? ', a 9:16 reel' : ''}, captions and the story link delivered.\n`);
}

// ── draft: write the outline, send the review link, stop ───────────────────
async function runDraft() {
  const editorial = await buildEditorial();

  let reelPlan = null;
  if (reels.isConfigured()) {
    console.log('\n🎬 Planning the reel (script + cuts, nothing built)...');
    try {
      reelPlan = await reels.planReel(editorial.story, editorial.slideCopy, editorial.raw);
      console.log(`   ${reelPlan.wordCount} words, ${reelPlan.lines.length} lines, ${reelPlan.shots.length} shots planned`);
    } catch (e) {
      console.warn(`   Reel planning failed (${e.message}) — draft continues without a reel.`);
    }
  } else {
    console.log(`\n🎬 Reel not planned — ${reels.missingPrerequisite()}.`);
  }

  const style = pickStyle();
  console.log(`\n🎨 Style pick for today: ${style}`);

  console.log('\n📝 Writing the review draft...');
  const { date, reviewUrl, draft } = await review.writeDraft({
    story: editorial.story,
    raw: editorial.raw,
    pillar: editorial.pillar,
    style,
    slideCopy: editorial.slideCopy,
    sources: editorial.sources,
    verification: editorial.verification,
    reelPlan,
    coverUri: editorial.coverUri,
  });

  console.log('\n📨 Sending the review link...');
  await sendDraftNotice({ draft, reviewUrl });

  console.log(`\n✅ Draft ${date} ready for review. Nothing was produced or posted.`);
  if (reviewUrl) console.log(`   ${reviewUrl}\n`);
}

// ── produce: build from an approved review file ────────────────────────────
async function runProduce(file) {
  console.log(`📗 Producing from approved draft: ${file}`);
  const approved = review.readApproved(file);
  const story = approved.story;

  // Only when the editor typed into it — an as-is approval has nothing new to
  // have gone wrong in, and the copy was already fact-checked before review.
  let proofreading = { ran: false, changes: [], rejected: [] };
  if (approved.approvedWithEdits) {
    console.log('\n📝 Proofreading the edited copy (spelling and grammar only)...');
    proofreading = await proofread(approved);
  }

  const { pillar, slideCopy, captions } = buildFromRaw(approved.raw, story);

  console.log('🖼️  Fetching the staged cover photo...');
  let coverUri = await review.fetchCover(approved);
  if (!coverUri) {
    console.log('   No staged cover — refetching from the article...');
    coverUri = await getCoverImage(story);
  }

  await produceAndDeliver({
    story,
    raw: approved.raw,
    pillar,
    slideCopy,
    captions,
    sources: approved.sources || [],
    verification: approved.verification || { ran: false, report: [] },
    coverUri,
    style: approved.style,
    approvedReel: approved.reel,
    proofreading,
  });
}

// ── full: the original unreviewed pipeline ─────────────────────────────────
async function runFull() {
  const editorial = await buildEditorial();
  await produceAndDeliver(editorial);
}

async function run() {
  const { mode, file } = resolveMode();
  try {
    console.log(`\n🚀 Carousel pipeline started (${mode}) — ${new Date().toISOString()}\n`);
    if (mode === 'draft') await runDraft();
    else if (mode === 'produce') await runProduce(file);
    else await runFull();
  } catch (error) {
    console.error(`\n❌ Carousel pipeline failed (${mode}):`, error.message);
    await sendErrorAlert(error);
    process.exit(1);
  }
}

run();
