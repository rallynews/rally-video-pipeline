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
- Immediately state the specific news fact — name the thing, the place, the number, the achievement
- Never use vague openers like "I have to tell you about this", "You won't believe this", "I'm so excited"
- End with: "Check out the comments for more!"
- Maximum 40 words

GOOD examples:
- "Good News! Renewables now make up more than half of the world's energy mix. Check out the comments for more!"
- "Good News! The EU just agreed to landmark new climate policies. Check out the comments for more!"
- "Good News! Scientists just discovered over 1,100 new ocean species. Check out the comments for more!"

BAD examples (never write like this):
- "I'm so excited to tell you about this. I can't stop thinking about it."
- "Guys, I have to tell you about this news I just heard."`
      },
      {
        role: 'user',
        content: `Story headline: "${story.headline}"
Story summary: "${story.summary}"
Publisher: ${story.publisher}

Return a JSON object with exactly these three fields:
{
  "script": "Spoken script following the rules above. Must reference the specific news. Maximum 40 words.",
  "caption": "An Instagram caption. Two sentences maximum. Warm and conversational, written for women in their 50s and 60s. Ends with: Full story in comments 👇 #goodnews #rallynews #positivenews",
  "tweet": "A post for X/Twitter. Maximum 240 characters (URL will be appended separately). Punchy and uplifting. 1–2 hashtags max. No URL."
}`
      }
    ]
  });

  return parseJSON(content);
}

module.exports = { generateScriptAndCaption };
