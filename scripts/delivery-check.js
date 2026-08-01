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
      post: async (url, body) => {
        const kind = String(url).includes('sendMediaGroup') ? 'album'
          : String(url).includes('sendVideo') ? 'video'
          : 'message';
        sent.push({
          platform: 'telegram', kind,
          text: (body && body.text) || '',
          parse_mode: body && body.parse_mode,
        });
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
const { TELEGRAM_LIMIT } = require('../src/carousel/header-text');
const telegram = require('../src/carousel/carousel-telegram');
const slack = require('../src/carousel/slack-sender');

// Telegram rejects a message with HTTP 400 when parse_mode is set and an
// emphasis character is unbalanced, or when it runs past 4096 characters.
// Nothing this pipeline sends may be able to trigger either.
function telegramWouldReject(message) {
  const reasons = [];
  if (message.parse_mode) {
    for (const ch of ['*', '_', '`']) {
      const n = (message.text.match(new RegExp('\\' + ch, 'g')) || []).length;
      if (n % 2) reasons.push(`unbalanced ${ch} with parse_mode=${message.parse_mode}`);
    }
  }
  if (message.text.length > TELEGRAM_LIMIT) {
    reasons.push(`${message.text.length} chars > ${TELEGRAM_LIMIT} limit`);
  }
  return reasons;
}

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
  // The real resolved voice name. Its single underscore made Telegram reject
  // the whole header with HTTP 400 when the header was parsed as Markdown.
  voice: 'OpenRouter mistralai/voxtral-mini-tts-2603 / casual_female',
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
  {
    name: 'copy full of Markdown metacharacters',
    story: {
      ...STORY,
      headline: 'A 50% rise in wolf_populations — *finally* [confirmed]',
      url: 'https://rally.news/?article=wolves_return&utm_source=rss',
    },
    sources: ['https://guardian.example/a_b', 'https://x.test/c'],
    extra: {
      reel: { ...REEL, hook: 'Wolves_Are_Back', script: 'They said it could not happen_ but it did.' },
      imageUrls: ['https://cdn.test/a_b.png'],
      verification: { ran: true, report: [] },
      proofreading: {
        ran: true,
        changes: [{ field: 'raw.challenge', before: 'wolf_populaton', after: 'wolf_population' }],
        rejected: [],
      },
    },
  },
];

(async () => {
  let failures = 0;

  for (const testCase of CASES) {
    sent.length = 0;
    const story = testCase.story || STORY;
    // Captions are rebuilt per case: they carry the story's own link, so a
    // case that overrides the story must get captions that match it.
    const { pillar, captions } = buildFromRaw({ ...RAW, ...(testCase.raw || {}) }, story);
    const delivery = {
      story,
      pillar,
      style: '1b',
      images: [Buffer.alloc(8), Buffer.alloc(8)],
      captions,
      sources: testCase.sources || ['https://guardian.example/a', 'https://x.test/c'],
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

    // Nothing sent to Telegram may be rejectable.
    const rejects = tg
      .filter(m => m.kind === 'message')
      .flatMap(m => telegramWouldReject(m).map(r => r));

    // The link goes out on its own, last, and never inside a caption.
    const linkAlone = tg.filter(m => m.text === story.url).length === 1;
    const captionsClean = !captions.facebook.includes(story.url) && !captions.instagram.includes(story.url);
    const hookShown = !delivery.reel || header.includes(delivery.reel.hook);

    const ok = !rejects.length && linkAlone && captionsClean && hookShown;
    if (!ok) failures++;
    console.log(
      `${ok ? '✓' : '✗'} ${testCase.name}\n` +
      `    telegram: ${tg.length} sends · slack: ${sl.length} sends · header ${header.length} chars`
    );
    for (const r of rejects) console.log(`    ✗ Telegram would answer 400: ${r}`);
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
