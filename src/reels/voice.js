const axios = require('axios');

// Step 3 of the reel flow: record the narration.
//
// Each script line is synthesised as its OWN clip. That costs nothing extra
// (billing is per character either way) and buys the thing that makes the edit
// work: a real, measured duration for every line, so the cuts and captions are
// timed against the voice that actually plays rather than a words-per-second
// guess. Lines are still whole sentences, so the delivery keeps its prosody.
//
// Providers are tried in order and the first one with credentials configured
// wins. Azure is the default: a young British female neural voice, hosted in a
// European region, and its free tier (500k characters/month) covers a daily
// ~600-character reel several times over.
//
//   AZURE_SPEECH_KEY + AZURE_SPEECH_REGION (default westeurope)
//   ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID
//   OPENAI_API_KEY

function xmlEscape(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const azure = {
  name: 'azure',
  ext: 'wav',
  isConfigured: () => Boolean(process.env.AZURE_SPEECH_KEY),
  describe() {
    const region = process.env.AZURE_SPEECH_REGION || 'westeurope';
    return `Azure Speech ${process.env.REELS_VOICE || 'en-GB-SoniaNeural'} (${region})`;
  },
  async speak(text) {
    const region = process.env.AZURE_SPEECH_REGION || 'westeurope';
    const voice = process.env.REELS_VOICE || 'en-GB-SoniaNeural';
    const style = process.env.REELS_VOICE_STYLE || 'friendly';
    // Slightly under natural pace — this is a chill read, not a news bulletin.
    const rate = process.env.REELS_VOICE_RATE || '-4%';

    const inner =
      `<prosody rate="${rate}">${xmlEscape(text)}</prosody>`;
    const body =
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
      `xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-GB">` +
      `<voice name="${voice}">` +
      (style ? `<mstts:express-as style="${style}">${inner}</mstts:express-as>` : inner) +
      `</voice></speak>`;

    const res = await axios.post(
      `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
      body,
      {
        headers: {
          'Ocp-Apim-Subscription-Key': process.env.AZURE_SPEECH_KEY,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm',
          'User-Agent': 'RallyNewsPipeline',
        },
        responseType: 'arraybuffer',
        timeout: 30000,
      }
    );
    return Buffer.from(res.data);
  },
};

const elevenlabs = {
  name: 'elevenlabs',
  ext: 'mp3',
  isConfigured: () => Boolean(process.env.ELEVENLABS_API_KEY),
  describe: () => `ElevenLabs ${process.env.ELEVENLABS_VOICE_ID || 'Rachel'}`,
  async speak(text) {
    // Rachel — the stock young female voice, present on every account.
    const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
    const res = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        text,
        model_id: process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5',
        voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.15 },
      },
      {
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
        responseType: 'arraybuffer',
        timeout: 45000,
      }
    );
    return Buffer.from(res.data);
  },
};

const openai = {
  name: 'openai',
  ext: 'mp3',
  isConfigured: () => Boolean(process.env.OPENAI_API_KEY),
  describe: () => `OpenAI gpt-4o-mini-tts ${process.env.REELS_VOICE || 'coral'}`,
  async speak(text) {
    const res = await axios.post(
      'https://api.openai.com/v1/audio/speech',
      {
        model: 'gpt-4o-mini-tts',
        voice: process.env.REELS_VOICE || 'coral',
        input: text,
        instructions:
          'Young woman, early twenties. Casual, chill, friendly — like telling a friend ' +
          'something cool she just read. Relaxed pace, warm but not breathless.',
        response_format: 'mp3',
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        responseType: 'arraybuffer',
        timeout: 45000,
      }
    );
    return Buffer.from(res.data);
  },
};

const PROVIDERS = [azure, elevenlabs, openai];

function selectProvider() {
  const forced = (process.env.REELS_VOICE_PROVIDER || '').toLowerCase().trim();
  if (forced) {
    const match = PROVIDERS.find(p => p.name === forced);
    if (!match) throw new Error(`Unknown REELS_VOICE_PROVIDER "${forced}"`);
    if (!match.isConfigured()) throw new Error(`REELS_VOICE_PROVIDER=${forced} but its API key is not set`);
    return match;
  }
  const available = PROVIDERS.find(p => p.isConfigured());
  if (!available) {
    throw new Error(
      'No text-to-speech provider configured — set AZURE_SPEECH_KEY (recommended), ' +
      'ELEVENLABS_API_KEY, or OPENAI_API_KEY'
    );
  }
  return available;
}

function isConfigured() {
  return PROVIDERS.some(p => p.isConfigured());
}

// Voice every line, one request each. Returns the provider plus a buffer per
// line in script order.
async function narrateLines(lines) {
  const provider = selectProvider();
  console.log(`  [reel] voicing ${lines.length} lines with ${provider.describe()}`);

  const clips = [];
  for (let i = 0; i < lines.length; i++) {
    const buf = await provider.speak(lines[i].text);
    if (!buf || buf.length < 512) {
      throw new Error(`Voice provider returned an empty clip for line ${i + 1}`);
    }
    clips.push(buf);
  }

  return { provider: provider.name, label: provider.describe(), ext: provider.ext, clips };
}

module.exports = { narrateLines, isConfigured, selectProvider };
