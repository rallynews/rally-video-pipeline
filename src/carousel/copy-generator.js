const { chatCompletion, parseJSON } = require('../openrouter');

// The eight Content Pillars. Every carousel must hit exactly one.
const CONTENT_PILLARS = [
  'Climate & Environment',
  'Human Kindness Stories',
  'Science & Health Breakthroughs',
  'Community Hero Spotlight',
  'The Pursuit of Peace',
  'Interesting Facts',
  'Democracy Thrives',
  'David & Goliath',
];

function normalizePillar(value) {
  if (!value) return CONTENT_PILLARS[0];
  const clean = String(value).replace(/&amp;/g, '&').trim().toLowerCase();
  const exact = CONTENT_PILLARS.find(p => p.toLowerCase() === clean);
  if (exact) return exact;
  const partial = CONTENT_PILLARS.find(
    p => clean.includes(p.toLowerCase().split(' ')[0]) && clean.length > 3
  );
  return partial || value;
}

// Strip surrounding straight/curly quotes a model sometimes wraps a field in.
function unquote(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim();
}

// Pick the outlet to credit the cover photo to. Prefer the original source the
// writer identified; fall back to the story's publisher. Never credit "Rally
// News" (the curating feed, not the photo's source) — better no credit than a
// wrong one, so return '' and let the template omit the caption.
function pickPhotoSource(raw, story) {
  const candidates = [raw && raw.originalSource, story && story.publisher];
  for (const c of candidates) {
    const name = unquote(c);
    if (name && name.toLowerCase() !== 'rally news') return name;
  }
  return '';
}

function normalizeHashtag(value) {
  const cleaned = String(value || '')
    .replace(/^#/, '')
    .replace(/[^A-Za-z0-9]/g, '');
  return cleaned || 'InTheNews';
}

// Slide copy closes on a "read more at the link in bio" call to action. That's
// right on a carousel slide and right on Instagram, but wrong in the Facebook
// caption, where the link is posted as the first comment instead. Strip it
// rather than leave the caption pointing somewhere the link isn't.
const LINK_CTA = /\b(link in (?:my |the )?bio|in my bio|in bio|at the link|link below|swipe up|check out .{0,40}\bstory\b)\b/i;

function stripLinkCta(text) {
  const s = String(text || '').trim();
  if (!LINK_CTA.test(s)) return s;

  const kept = s
    .split(/(?<=[.!?])\s+|\s+[—–-]\s+/)
    .map(part => {
      if (!LINK_CTA.test(part)) return part;
      // The CTA is sometimes tacked on after a comma inside an otherwise
      // usable sentence ("A stunning turnaround, and you can read it at the
      // link"), so fall back to keeping just the part before it.
      const head = part.split(/,\s+/)[0];
      return LINK_CTA.test(head) ? '' : head;
    })
    .filter(Boolean)
    .join(' ')
    .trim();

  // A line that was nothing but a call to action leaves nothing worth keeping.
  if (!kept) return '';
  return /[.!?]$/.test(kept) ? kept : `${kept.replace(/[,;:]$/, '')}.`;
}

function terminate(text) {
  const t = String(text || '').trim();
  return !t || /[.!?]$/.test(t) ? t : `${t}.`;
}

// Join a heading and its supporting line into one paragraph without doubling
// the punctuation between them.
function sentence(head, tail) {
  const h = terminate(head);
  const t = String(tail || '').trim();
  if (!h) return t;
  if (!t) return h;
  return `${h} ${t}`;
}

// The cover headline is written to OPEN with a short hook question, then carry
// on into a colloquial line naming the source. In a caption only the question
// earns its place — the rest of the headline is cover-slide scaffolding for
// someone who can't see the story yet. Pull the question out on its own.
function openingQuestion(headline) {
  const match = unquote(headline).match(/^[^?]{3,140}\?/);
  return match ? match[0].trim() : '';
}

// Assemble the copy-paste-ready captions.
//
// Facebook gets the WHOLE carousel — opening question, lead, challenge,
// solution, result, why it matters — as short paragraphs, so the post stands on
// its own for someone who never swipes. It opens and closes on a question, the
// same shape the carousel has: the cover hooks, the last slide asks. Instagram
// stays short, because its caption is collapsed behind "more" after a couple of
// lines and the slides carry the story there.
//
// Neither caption contains the article link: it goes out as its own message so
// it can be pasted into the first comment. Instagram still says "link in bio",
// which is where its link genuinely lives.
function buildCaptions(fields, story) {
  const hashtags = `#goodnews #positivenews #${normalizeHashtag(fields.storyHashtag)}`;
  const lead = unquote(fields.captionLead);
  const question = unquote(fields.engagementQuestion);

  const hook = openingQuestion(fields.headline);

  const facebook = [
    // Guard against the rare case where the writer used the same question to
    // hook and to close — one of them is enough.
    hook.toLowerCase() === question.toLowerCase() ? '' : hook,
    lead,
    unquote(fields.challenge),
    unquote(fields.solution),
    sentence(unquote(fields.resultHeading), stripLinkCta(unquote(fields.resultLine))),
    unquote(fields.whyMatters),
    question,
    hashtags,
  ].filter(Boolean).join('\n\n');

  const instagram = `${lead}\n\n${question}\n\n🔗 Full story — link in bio\n\n${hashtags}`;

  return { facebook, instagram, hashtags, link: story.url };
}

// Turn a raw model field object into the pillar, slide copy, and captions the
// pipeline renders/sends. Shared by the first-round generator and the
// fact-check pass so both produce identical structure.
function buildFromRaw(raw, story) {
  const pillar = normalizePillar(raw.pillar);
  const slideCopy = {
    pillar,
    // Original source for the cover photo credit (empty ⇒ no caption shown).
    source: pickPhotoSource(raw, story),
    headline: unquote(raw.headline),
    challenge: unquote(raw.challenge),
    solution: unquote(raw.solution),
    resultHeading: unquote(raw.resultHeading),
    resultLine: unquote(raw.resultLine),
    // Final slide ends on the engagement question.
    whyMatters: `${unquote(raw.whyMatters)} ${unquote(raw.engagementQuestion)}`.trim(),
  };
  const captions = buildCaptions(raw, story);
  return {
    pillar,
    slideCopy,
    captions,
    sources: Array.isArray(raw.sources) ? raw.sources : [],
    raw,
  };
}

async function generateCarouselCopy(story) {
  const content = await chatCompletion({
    max_tokens: 1500,
    plugins: [{ id: 'web', max_results: 4 }],
    messages: [
      {
        role: 'system',
        content: `You are the editor for Rally News, a positive-news brand. You write the copy for a 5-part Instagram/Facebook carousel about ONE uplifting news story.

RESEARCH FIRST — this is critical:
- Use the web search results available to you to actually research and CORROBORATE this story from more than one source before writing.
- Never invent, exaggerate beyond the facts, or hallucinate figures, names, quotes, or outcomes. You may be warm and hyperbolic in TONE, but every concrete claim (numbers, dates, results) must be true and supported by the sources.
- If you cannot verify a specific number, describe the outcome qualitatively instead of inventing a statistic.

CONTENT PILLAR — choose exactly ONE that best matches the story:
${CONTENT_PILLARS.map(p => `- ${p}`).join('\n')}

VOICE: warm, colloquial, friendly — like a real person sharing amazing news with a friend. Grippy and swipe-worthy, but honest.

Write these fields:
1. headline — For the cover. It MUST START WITH a short, grippy, story-specific QUESTION that hooks the viewer (e.g. "Are we really making climate progress?" or "How long could you handle chemo?"). Then continue with a vague, colloquial line that references the ORIGINAL news source by name (do NOT reuse their headline) and withholds the answer so people swipe. Keep the whole thing to roughly 12–20 words. E.g. "Are we really making climate progress? The Guardian just dropped some numbers that stopped me in my tracks." or "How long could you handle chemo? What this boy profiled by the NY Times did is unreal."
2. challenge — 1–2 short sentences on the problem/stakes, grounded in your research. End by deepening the stakes / urgency so the reader swipes on. E.g. "When Tyler Moore was diagnosed with leukemia, the prognosis wasn't good. According to the New York Times, doctors gave him only a 10% chance of surviving a year."
3. solution — 1–2 sentences on the turn / the answer to the problem, from the actual reporting. Include a hook that makes them keep swiping. E.g. "Tyler wasn't ready to give up. With his parents' blessing, he took his care into his own hands, undergoing 3 grueling rounds of chemo — with astonishing results."
4. resultHeading — A short, factual, non-hallucinated positive OUTCOME stated big (this is the large text). E.g. "Solar surpassed oil for the first time" or "Tyler's leukemia went into full remission".
5. resultLine — One short supporting line under it that states the impact AND gives a call to action to read more. E.g. "The trend is expected to continue — full figures at the link in my bio." or "A stunning turnaround — check out Tyler's full story at the link in bio."
6. whyMatters — 1–2 reflective sentences on why this story matters to the world (do NOT include the question here).
7. engagementQuestion — One grippy debate question to drive comments. This SAME question closes the final slide and both captions. E.g. "But what do you think — are we moving fast enough?" or "So let us know: how would you handle being in Tyler's situation?"
8. captionLead — 1–2 warm sentences summarizing the good news, used as the lead of the social captions.
9. storyHashtag — ONE popular, real, story-specific hashtag word (no spaces, no # symbol), e.g. ClimateAction, CancerResearch, CleanEnergy.
10. sources — an array of 1–3 URLs you actually used to corroborate the story.
11. originalSource — the NAME of the original news outlet that first published this story and its photo (e.g. "Smithsonian Magazine", "BBC", "The Guardian", "Le Monde"). This credits the cover photo, so use the outlet's clean display name — not a URL, and never "Rally News" (that's only the aggregator).

Return VALID JSON only, no markdown, with exactly these keys:
{"pillar","headline","challenge","solution","resultHeading","resultLine","whyMatters","engagementQuestion","captionLead","storyHashtag","sources","originalSource"}`,
      },
      {
        role: 'user',
        content: `Story to research and write about:
Headline: "${story.headline}"
Summary: "${story.summary}"
Publisher / source: ${story.publisher}
Link: ${story.url}

Research and corroborate this story with the web results, then return the JSON described above.`,
      },
    ],
  });

  const raw = parseJSON(content);
  return buildFromRaw(raw, story);
}

module.exports = { generateCarouselCopy, buildFromRaw, CONTENT_PILLARS };
