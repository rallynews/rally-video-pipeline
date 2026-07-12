const { chatCompletion, parseJSON } = require('../openrouter');

// Fields that carry factual claims and therefore get verified. captionLead,
// engagementQuestion and storyHashtag are opinion/CTA/tagging, so they pass
// through unless the checker rewrites a fact inside captionLead.
const CHECKED_FIELDS = [
  'headline', 'challenge', 'solution', 'resultHeading', 'resultLine',
  'whyMatters', 'captionLead',
];

// Second-pass verification. Re-reads all the first-round copy, cross-references
// every concrete claim against the article and other sources via web search,
// demands POSITIVE proof, and rewrites anything unproven or inaccurate. Returns
// the corrected raw fields plus a per-field report.
async function verifyCarouselCopy(story, raw) {
  const draft = {};
  for (const k of [...CHECKED_FIELDS, 'pillar', 'engagementQuestion', 'storyHashtag']) {
    draft[k] = raw[k];
  }

  let content;
  try {
    content = await chatCompletion({
      max_tokens: 1800,
      plugins: [{ id: 'web', max_results: 4 }],
      messages: [
        {
          role: 'system',
          content: `You are a fact-checker for Rally News. You are given a DRAFT of carousel copy that another writer produced about a news story. Your job is to verify it before it goes to production.

PROCESS:
- Use web search to cross-reference the story against the original article AND at least one other independent source.
- For every concrete claim in the draft (names, numbers, dates, places, outcomes, "first ever" / "record" statements, attributions like "according to X"), find POSITIVE PROOF that it is true.
- A claim passes ONLY if a source positively confirms it. Absence of contradiction is NOT proof.
- If a claim is inaccurate, unverifiable, or exaggerated beyond what sources support: REWRITE that field so it is fully supported. Keep the same warm, grippy Rally voice, the same role/length of the field, and the same structure (e.g. resultHeading stays a short big-text outcome; the headline still OPENS WITH a question and then names the source without copying its headline). Prefer a truthful qualitative statement over an unverifiable number.
- Do not weaken the copy unnecessarily — only change what isn't provably true. You may keep a field exactly as-is if it checks out.

Return VALID JSON only, no markdown, with these keys:
- All of these corrected fields: headline, challenge, solution, resultHeading, resultLine, whyMatters, captionLead. (Return the final, production-ready text — corrected where needed, unchanged where already accurate.)
- pillar, engagementQuestion, storyHashtag: return them unchanged.
- sources: array of the URLs you used to verify (1–4).
- report: an array of {"field","verdict","note"} where verdict is "verified" (kept as-is, confirmed) or "corrected" (rewritten), and note briefly says what was confirmed or what was wrong and fixed.

{"headline","challenge","solution","resultHeading","resultLine","whyMatters","captionLead","pillar","engagementQuestion","storyHashtag","sources","report"}`,
        },
        {
          role: 'user',
          content: `Story:
Headline: "${story.headline}"
Summary: "${story.summary}"
Publisher / source: ${story.publisher}
Link: ${story.url}

DRAFT copy to verify (JSON):
${JSON.stringify(draft, null, 2)}

Verify every factual claim with web search, correct anything not positively proven, and return the JSON described above.`,
        },
      ],
    });
  } catch (err) {
    // If verification can't run, don't block production — ship round-1 copy.
    console.warn(`  [fact-check] verification call failed (${err.message}) — using first-round copy.`);
    return { raw, report: [], sources: raw.sources || [], ran: false };
  }

  let checked;
  try {
    checked = parseJSON(content);
  } catch (err) {
    console.warn(`  [fact-check] could not parse verification result (${err.message}) — using first-round copy.`);
    return { raw, report: [], sources: raw.sources || [], ran: false };
  }

  // Merge: take corrected checked fields, fall back to the draft for anything
  // the checker omitted.
  const corrected = { ...raw };
  for (const k of [...CHECKED_FIELDS, 'pillar', 'engagementQuestion', 'storyHashtag']) {
    if (checked[k] != null && String(checked[k]).trim()) corrected[k] = checked[k];
  }
  if (Array.isArray(checked.sources) && checked.sources.length) corrected.sources = checked.sources;

  const report = Array.isArray(checked.report) ? checked.report : [];
  return { raw: corrected, report, sources: corrected.sources || [], ran: true };
}

module.exports = { verifyCarouselCopy };
