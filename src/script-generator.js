const { chatCompletion, parseJSON } = require('./openrouter');

async function generateScriptAndCaption(story) {
  const content = await chatCompletion({
    max_tokens: 600,
    messages: [
      {
        role: 'system',
        content: `You write short UGC video scripts and Instagram captions for Rally News, a positive news aggregator.
Tone: warm, genuine, straight-to-camera — like a real woman in her early 50s sharing great news with a friend.
Return valid JSON only, no extra text.

SCRIPT RULES:
- Always start with "Good News!"
- The very next words MUST state the actual specific fact from THIS story — use the real name, real number, real place, real achievement directly from the headline and summary provided
- NEVER write a generic statement that could apply to any news story — every sentence must only make sense for THIS specific story
- Never use vague openers like "I have to tell you about this", "You won't believe this", "I'm so excited", "Something amazing happened"
- End with: "Link in bio for more!"
- Maximum 12 words total (must fit within 5 seconds of speech)

GOOD examples (notice how each one names the specific thing, and is under 12 words):
- "Good News! New Zealand just discovered a brand-new giant reef shark! Link in bio for more!"
- "Good News! Canada now guarantees paid mental health days for workers! Link in bio for more!"
- "Good News! Solar now powers over half of Australia's grid! Link in bio for more!"

BAD examples — these are generic and could describe ANY story, never write like this:
- "Good News! Something incredible just happened that's going to make your day. Link in bio for more!"
- "Good News! Scientists have made an amazing new discovery. Link in bio for more!"
- "Good News! A new law was just passed that will help people. Link in bio for more!"
- "I'm so excited to tell you about this. I can't stop thinking about it."
- "Guys, I have to tell you about this news I just heard."

CRITICAL: If your script could describe a completely different story, rewrite it. Every detail must come directly from the headline and summary.`
      },
      {
        role: 'user',
        content: `Story headline: "${story.headline}"
Story summary: "${story.summary}"
Publisher: ${story.publisher}

Using ONLY the specific facts, names, numbers, and details from the headline and summary above, return a JSON object with exactly these three fields:
{
  "script": "Spoken script. MUST name the specific subject/number/place/achievement from THIS story. Maximum 12 words. Must be speakable in 5 seconds.",
  "caption": "An Instagram caption. Two sentences maximum. Warm and conversational, written for women in their 50s and 60s. Ends with: Full story in bio link 👆 #goodnews #rallynews #positivenews",
  "tweet": "A post for X/Twitter. Maximum 240 characters (URL will be appended separately). Punchy and uplifting. 1–2 hashtags max. No URL."
}`
      }
    ]
  });

  return parseJSON(content);
}

module.exports = { generateScriptAndCaption };
