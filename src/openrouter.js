const axios = require('axios');

const AI_MODELS = [
  'mistralai/mistral-small-3.2-24b-instruct',
  'google/gemini-2.0-flash-001',
  'openai/o1-mini',
  'openai/gpt-4o-mini',
  'meta-llama/llama-3.3-70b-instruct',
];

async function chatCompletion(payload) {
  let lastError;
  for (const model of AI_MODELS) {
    try {
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        { ...payload, model },
        {
          headers: {
            'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://rallynews.com',
            'X-Title': 'Rally News Pipeline'
          }
        }
      );

      const choices = response.data.choices;
      if (!choices?.length) {
        lastError = new Error(`No choices in response from ${model}: ${JSON.stringify(response.data)}`);
        console.warn(`[openrouter] ${model} returned no choices, trying next...`);
        continue;
      }

      const choice = choices[0];
      if (choice.error) {
        lastError = new Error(`Provider error from ${model}: ${choice.error.code} ${choice.error.message}`);
        console.warn(`[openrouter] ${model} provider error ${choice.error.code}, trying next...`);
        continue;
      }

      console.log(`[openrouter] success with ${model}`);
      return choice.message.content;
    } catch (err) {
      lastError = err;
      console.warn(`[openrouter] ${model} threw: ${err.message}, trying next...`);
    }
  }
  throw lastError || new Error('All models failed');
}

function parseJSON(text) {
  if (!text) throw new Error('Empty content from model');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON object found in model response: ${text.slice(0, 300)}`);
  return JSON.parse(match[0]);
}

module.exports = { chatCompletion, parseJSON };
