#!/usr/bin/env node
// Executes both delivery paths end to end against stubbed network calls.
//
// This exists because `node --check` only parses — it cannot see an undefined
// identifier. A header builder was once called in one sender and defined only
// in the other, and nothing caught it until a live run had already rendered
// slides, built a reel and uploaded both, then died on ReferenceError at the
// last step. Running the senders for real, with axios and Slack stubbed, is
// what would have caught it in a second.
//
//   npm run delivery-check
//
// No credentials needed; nothing leaves the process.

const Module = require('module');

const sent = [];
const originalRequire = Module.prototype.require;

Module.prototype.require = function (id) {
  if (id === 'axios') {
    return {
      post: async (url) => {
        const kind = String(url).includes('sendMediaGroup') ? 'album'
          : String(url).includes('sendVideo') ? 'video'
          : 'message';
        sent.push({ platform: 'telegram', kind });
        return { data: {} };
      },
    };
  }
  if (id === '@slack/web-api') {
    return {
      WebClient: class {
        constructor() {
          this.files = {
            uploadV2: async (o) => {
              sent.push({ platform: 'slack', kind: 'files', text: o.initial_comment });
            },
          };
          this.chat = {
            postMessage: async (o) => sent.push({ platform: 'slack', kind: 'message', text: o.text }),
          };
        }
      },
    };
  }
  return originalRequire.apply(this, arguments);
};

process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'stub';
process.env.TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || 'stub';
process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || 'stub';
process.env.SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID || 'stub';

const { buildFromRaw } = require('../src/carousel/copy-generator');
const telegram = require('../src/carousel/carousel-telegram');
const slack = require('../src/carousel/slack-sender');

const STORY = {
  headline: 'Rewilded riverbanks bring a dried-up river back to life',
  summary: 'Farmers gave up a strip of land to restore the floodplain.',
  publisher: 'The Guardian',
  url: 'https://rally.news/?article=river-returns',
};

const RAW = {
  pillar: 'Climate & Environment',
  headline: 'Can a river really come back? The Guardian says yes.',
  challenge: 'The river had been dropping every summer for a decade.',
  solution: 'Farmers handed a strip of land back to the floodplain.',
  resultHeading: 'The river is running year-round again',
  resultLine: 'Fish have returned with it — full story at the link in bio.',
  whyMatters: 'Reversing environmental damage need not take decades.',
  engagementQuestion: 'But what do you think — would you give up part of your land?',
  captionLead: 'A river everyone had written off is running again.',
  storyHashtag: 'Rewilding',
  originalSource: 'The Guardian',
};

const REEL = {
  buffer: Buffer.alloc(2048),
  duration: 28.4,
  hook: 'A River Came Back',
  script: 'Okay so this one actually made my day.',
  shots: [{}, {}, {}],
  captions: ['a', 'b'],
  voice: 'OpenRouter voxtral / casual_female',
  track: 'audio/track-03.mp3',
  url: 'https://cdn.test/reels/2026-07-31/river.mp4',
};

// Every shape the header has to survive, including the ones that only appear
// on some runs — a missing reel, a skipped proofread, an empty R2 upload.
const CASES = [
  {
    name: 'full run (reel + proofread with fixes)',
    extra: {
      reel: REEL,
      imageUrls: ['https://cdn.test/1.png', 'https://cdn.test/2.png'],
      verification: { ran: true, report: [{ field: 'headline', verdict: 'corrected' }] },
      proofreading: {
        ran: true,
        changes: [{ field: 'raw.challenge', before: 'dissapearing', after: 'disappearing' }],
        rejected: [{ field: 'reel.line.2', before: 'x', after: 'y' }],
      },
    },
  },
  {
    name: 'approved as-is (proofread did not run)',
    extra: { reel: REEL, imageUrls: [], verification: { ran: true, report: [] }, proofreading: { ran: false, changes: [], rejected: [] } },
  },
  {
    name: 'proofread ran, found nothing',
    extra: { reel: REEL, imageUrls: [], verification: { ran: false, report: [] }, proofreading: { ran: true, changes: [], rejected: [] } },
  },
  {
    name: 'no reel, no proofreading key at all (full mode)',
    extra: { reel: null, imageUrls: [], verification: { ran: false, report: [] } },
  },
];

(async () => {
  const { pillar, slideCopy, captions } = buildFromRaw({ ...RAW }, STORY);
  let failures = 0;

  for (const testCase of CASES) {
    sent.length = 0;
    const delivery = {
      story: STORY,
      pillar,
      style: '1b',
      images: [Buffer.alloc(8), Buffer.alloc(8)],
      captions,
      sources: ['https://guardian.example/a'],
      ...testCase.extra,
    };

    try {
      await telegram.sendCarousel(delivery);
      await slack.sendCarousel(delivery);
    } catch (err) {
      console.error(`✗ ${testCase.name}\n    ${err.stack.split('\n').slice(0, 2).join('\n    ')}`);
      failures++;
      continue;
    }

    const tg = sent.filter(m => m.platform === 'telegram');
    const sl = sent.filter(m => m.platform === 'slack');
    const header = sl.find(m => m.kind === 'files').text;

    // The link goes out on its own, last, and never inside a caption.
    const linkAlone = sl.filter(m => m.kind === 'message' && m.text === STORY.url).length === 1;
    const captionsClean = !captions.facebook.includes(STORY.url) && !captions.instagram.includes(STORY.url);
    const hookShown = !delivery.reel || header.includes(delivery.reel.hook);

    const ok = linkAlone && captionsClean && hookShown;
    if (!ok) failures++;
    console.log(
      `${ok ? '✓' : '✗'} ${testCase.name}\n` +
      `    telegram: ${tg.length} sends · slack: ${sl.length} sends · header ${header.length} chars`
    );
    if (!linkAlone) console.log('    ✗ the bare article link was not sent exactly once');
    if (!captionsClean) console.log('    ✗ a caption contains the article link');
    if (!hookShown) console.log('    ✗ the reel hook is missing from the header');
  }

  if (failures) {
    console.error(`\n${failures} delivery case(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll delivery cases passed.');
})().catch(err => {
  console.error(`\nDelivery check crashed: ${err.stack}`);
  process.exit(1);
});
