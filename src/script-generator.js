const { chatCompletion, parseJSON } = require('./openrouter');
const { BACKGROUND_KEYS } = require('./backgrounds');

async function generateScriptAndCaption(story) {
  const content = await chatCompletion({
    max_tokens: 700,
    messages: [
      {
        role: 'system',
        content: `You write short UGC video scripts and Instagram captions for Rally News, a positive news aggregator.
Tone: warm, bubbly, genuine, straight-to-camera — like a real woman sharing great news with a friend.
Return valid JSON only, no extra text.

SCRIPT RULES:
- Write a UNIQUE opening line every time — never reuse the same opener. Do NOT start with "Good News". Do NOT start with generic openers like "I have to tell you about this", "You won't believe this", "I'm so excited", "Something amazing happened", "Guys". Instead open with a fresh, bubbly reaction that is specific to THIS story.
- Pack in as much real detail about THIS story as possible: use the real name, real number, real place, real achievement, and the interesting specifics directly from the headline and summary. Explain WHAT happened, WHO it involves, and WHY it's exciting.
- Every sentence must only make sense for THIS specific story. If your script could describe a completely different story, rewrite it.
- Do NOT end with "Link in bio for more" or any call to action — just deliver the news warmly.
- Target 25-30 words total (must fit within 10 seconds of natural speech). Use the full time to explain the details.

BACKGROUND SELECTION:
- Choose the ONE background from this list that best fits the story's content: ${BACKGROUND_KEYS.join(', ')}.
- Match the setting to the topic when there's a natural fit (a movie/film story → theater, plant/nature growth → forest, travel/flights → airport or airplane, art → museum, science/research → lab, food → restaurant, ocean/marine → boat, etc). If nothing fits naturally, pick any that feels pleasant.

GOOD script examples (fresh openers, specific detail, no call to action, ~25-30 words):
- "How incredible is this — New Zealand researchers just discovered a brand-new giant reef shark off the coast, a species no one has ever documented before. Nature keeps surprising us!"
- "This just made my whole week! Canada passed a law guaranteeing every worker paid mental health days, so millions of people can finally rest without losing a paycheck."
- "Australia hit a huge milestone today — solar power now supplies over half of the entire national grid, proving clean energy really can run a whole country."

BAD script examples — never write like these (generic, could be any story):
- "Good News! Something incredible just happened that's going to make your day."
- "Scientists have made an amazing new discovery."
- "I'm so excited to tell you about this. I can't stop thinking about it."

CRITICAL: Every detail must come directly from the headline and summary provided.`
      },
      {
        role: 'user',
        content: `Story headline: "${story.headline}"
Story summary: "${story.summary}"
Publisher: ${story.publisher}

Using ONLY the specific facts, names, numbers, and details from the headline and summary above, return a JSON object with exactly these four fields:
{
  "script": "Spoken script. A UNIQUE bubbly opener followed by as much specific detail about THIS story as possible. Target 25-30 words. Must be speakable in 10 seconds. No 'Good News', no 'Link in bio', no call to action.",
  "background": "One key from this list that best matches the story: ${BACKGROUND_KEYS.join(', ')}",
  "caption": "An Instagram caption. Two sentences maximum. Warm and conversational, written for women in their 50s and 60s. Ends with: Full story in bio link 👆 #goodnews #rallynews #positivenews",
  "tweet": "A post for X/Twitter. Maximum 240 characters (URL will be appended separately). Punchy and uplifting. 1–2 hashtags max. No URL."
}`
      }
    ]
  });

  return parseJSON(content);
}

module.exports = { generateScriptAndCaption };
