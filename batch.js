#!/usr/bin/env node
// Rally Studio ▸ Promotion ▸ Carousel — the pipeline half.
//
// Studio dispatches .github/workflows/reel-batch.yml with a batch number, a
// mode, and (for a retry) one slot. The workflow runs this file in three
// places:
//
//   node batch.js job <script|produce> <batch> [item]
//       the slot ids Studio has waiting for this run → $GITHUB_OUTPUT items=[…]
//   node batch.js script <item>
//       story → research → copy → fact-check → captions → cover photo →
//       reel script + shot plan, posted to Studio as the slot's draft
//   node batch.js produce <item>
//       the confirmed draft → proofread (if edited) → voice, cut, music →
//       MP4 + poster to R2, posted to Studio as the finished video
//   node batch.js finish <script|produce> <batch> [itemsJson]
//       once the stage is done: the "ready" message to Slack and Telegram
//       with the batch's Studio link; for produce, the RSS feed too
//
// Every slot runs in its own job, in parallel. A slot that fails reports its
// error to Studio (which shows it with a Retry button) and never takes the
// others down with it.
//
// The planning and finishing steps use only Node built-ins, so those jobs
// skip `npm install`; the heavy modules are required inside the slot steps.

const fs = require('fs');
const studio = require('./src/studio');
const notify = require('./src/batch/notify');

function slugify(text) {
  return String(text || 'story')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'story';
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  console.log(`${name}=${value}`);
}

// ── job: what this run should work on ──────────────────────────────────────
async function runJob(mode, batch, item) {
  const job = await studio.job(batch, mode, item);
  const ids = (job.items || []).map(Number).filter(Boolean);
  console.log(`📋 Batch ${batch}: ${ids.length} slot(s) waiting for ${mode}`);
  setOutput('items', JSON.stringify(ids));
}

// ── script: one slot, story to draft ───────────────────────────────────────
async function runScript(id) {
  const { generateCarouselCopy, buildFromRaw } = require('./src/story/copy-generator');
  const { verifyCarouselCopy } = require('./src/story/fact-checker');
  const { getCoverImage } = require('./src/story/cover-image');
  const reels = require('./src/reels');
  const { stageCover, buildDraft } = require('./src/batch/draft');

  const work = await studio.work(id, 'script');
  const story = work.story;
  if (!story || !story.headline) throw new Error('Studio sent no story for this slot');
  console.log(`📰 Video ${work.slot} of batch ${work.batch_id}: "${story.headline}"`);

  if (!reels.isConfigured()) throw new Error(`The reel can't be planned — ${reels.missingPrerequisite()}`);

  console.log('\n✍️  Researching the story and writing its outline...');
  const round1 = await generateCarouselCopy(story);

  console.log('\n🔎 Fact-checking the outline...');
  const verified = await verifyCarouselCopy(story, round1.raw);
  if (verified.ran) {
    const corrected = verified.report.filter(r => r.verdict === 'corrected');
    console.log(`   Checked ${verified.report.length} field(s); ${corrected.length} rewritten.`);
  }
  const { pillar, slideCopy, captions } = buildFromRaw(verified.raw, story);
  const verification = { ran: verified.ran, report: verified.report };

  console.log('\n🖼️  Fetching the article photo...');
  const coverUri = await getCoverImage(story);
  let coverUrl = null;
  try {
    coverUrl = await stageCover(coverUri, `drafts/batch-${work.batch_id}/item-${id}`);
  } catch (e) {
    console.warn(`   Cover staging failed (${e.message}) — the reel will open on library footage`);
  }

  console.log('\n🎬 Writing the reel script and planning the cuts...');
  const reelPlan = await reels.planReel(story, slideCopy, verified.raw);
  console.log(`   ${reelPlan.wordCount} words, ${reelPlan.lines.length} lines, ${reelPlan.shots.length} shots`);

  const draft = buildDraft({
    story, raw: verified.raw, pillar, sources: verified.sources || [], verification,
    captions, reelPlan, coverUrl,
  });
  await studio.scriptDone(id, draft);
  console.log('\n✅ Script sent to Studio.');
}

// ── produce: one slot, confirmed draft to MP4 ──────────────────────────────
async function runProduce(id) {
  const { buildFromRaw } = require('./src/story/copy-generator');
  const { getCoverImage } = require('./src/story/cover-image');
  const { proofread } = require('./src/batch/proofreader');
  const reels = require('./src/reels');
  const { fetchCover } = require('./src/batch/draft');
  const { uploadObject, posterFrame } = require('./src/batch/upload');

  const work = await studio.work(id, 'produce');
  const draft = work.draft;
  const story = work.story || (draft && draft.story);
  if (!draft || !draft.reel || !draft.raw) throw new Error('Studio sent no confirmed draft for this slot');
  console.log(`🎬 Video ${work.slot} of batch ${work.batch_id}: "${story.headline}"`);

  // Only when the editor typed into it — an untouched script was already
  // fact-checked, and has nothing new in it to have gone wrong.
  let proofreading = { ran: false, changes: [], rejected: [] };
  if (work.edited) {
    console.log('\n📝 Proofreading the edited script and captions (spelling and grammar only)...');
    proofreading = await proofread(draft);
  }

  const { slideCopy } = buildFromRaw(draft.raw, story);

  console.log('\n🖼️  Fetching the staged article photo...');
  let coverUri = await fetchCover(draft);
  if (!coverUri) {
    console.log('   No staged photo — fetching it from the article again...');
    coverUri = await getCoverImage(story);
  }

  const reel = await reels.generateReel(story, slideCopy, draft.raw, coverUri, draft.reel);

  const base = `reels/${today()}/${slugify(story.headline)}-b${work.batch_id}-${work.slot}`;
  const videoUrl = await uploadObject(reel.buffer, `${base}.mp4`, 'video/mp4');
  if (!videoUrl) throw new Error('The reel was built but R2_VIDEO_PUBLIC_URL / R2_PUBLIC_URL is not set, so it has no address');
  let posterUrl = null;
  try {
    const poster = await posterFrame(reel.buffer);
    if (poster) posterUrl = await uploadObject(poster, `${base}.jpg`, 'image/jpeg');
  } catch (e) {
    console.warn(`   Poster frame failed (${e.message}) — the video still plays`);
  }

  const captions = draft.captions || {};
  await studio.produceDone(id, {
    video_url: videoUrl,
    video_key: `${base}.mp4`,
    poster_url: posterUrl,
    duration_s: reel.duration,
    captions: { facebook: captions.facebook || '', instagram: captions.instagram || '', link: captions.link || story.url },
    proofreading,
    voice: reel.voice,
    track: reel.track || (reel.musicMuted ? 'no music' : ''),
  });
  console.log(`\n✅ ${videoUrl} sent to Studio.`);
}

// ── finish: the stage's "ready" message, once ──────────────────────────────
async function runFinish(mode, batch, itemsJson) {
  let items = [];
  try { items = JSON.parse(itemsJson || '[]'); } catch { items = []; }
  const summary = await studio.finish(batch, mode, items);
  if (!summary.notify) {
    console.log(`ℹ️  No message to send (${summary.reason || 'nothing owed'}).`);
    return;
  }
  const msg = await notify.sendReady(summary);
  console.log(`📨 ${msg.title}\n   ${msg.url}`);

  if (mode === 'produce') {
    const { updateRSSFeed } = require('./src/rss-updater');
    for (const it of summary.items) {
      if (it.status !== 'ready' || !it.url) continue;
      updateRSSFeed({ headline: it.headline, url: it.url, summary: it.summary || it.headline, thumbnail: it.thumbnail || null });
    }
  }
}

async function main() {
  const [cmd, a, b, c] = process.argv.slice(2);
  const mode = cmd === 'job' || cmd === 'finish' ? a : cmd;
  try {
    if (cmd === 'job') return await runJob(a, Number(b), c ? Number(c) : null);
    if (cmd === 'finish') return await runFinish(a, Number(b), c);
    if (cmd === 'script' || cmd === 'produce') {
      const id = Number(a);
      if (!id) throw new Error(`usage: node batch.js ${cmd} <item id>`);
      try {
        return await (cmd === 'script' ? runScript(id) : runProduce(id));
      } catch (err) {
        // Studio shows this on the slot, with a Retry button.
        console.error(`\n❌ ${cmd} failed for slot ${id}: ${err.message}`);
        try { await studio.failed(id, cmd, err.message); }
        catch (e) { console.error(`   …and Studio could not be told: ${e.message}`); await notify.sendAlert(`Slot ${id} (${cmd}): ${err.message}\nStudio unreachable: ${e.message}`); }
        process.exitCode = 1;
        return;
      }
    }
    throw new Error('usage: node batch.js job|script|produce|finish …');
  } catch (err) {
    console.error(`\n❌ batch.js ${cmd} (${mode || ''}) failed: ${err.message}`);
    await notify.sendAlert(`batch.js ${cmd} ${[a, b].filter(Boolean).join(' ')}: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
