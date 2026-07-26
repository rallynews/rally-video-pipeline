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
// wins:
//
//   OPENROUTER_API_KEY                      ← default; the key is already set
//   AZURE_SPEECH_KEY + AZURE_SPEECH_REGION     for the carousel's Mistral calls
//   ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID
//   OPENAI_API_KEY
//
// OpenRouter's /audio/speech endpoint is OpenAI-compatible and routes to
// several speech providers. We ask for Mistral's Voxtral first — a European
// model, and a young female preset that reads casually without pretending to
// be a person — and fall through to OpenAI's gpt-4o-mini-tts. Note that Azure
// AI Speech is NOT one of OpenRouter's providers; the azure entry below talks
// to Azure directly and needs its own key.

function xmlEscape(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Candidate (model, voice) pairs for OpenRouter, best fit first. The chain
// exists because model IDs and voice names on a routing layer move around —
// the first pair that answers is remembered for the rest of the run, so the
// fallback is paid once, not once per line.
const OPENROUTER_VOICES = [
  { model: 'mistralai/voxtral-mini-tts-2603', voice: 'casual_female' },
  { model: 'mistralai/voxtral-mini-tts-2603', voice: 'neutral_female' },
  { model: 'mistralai/voxtral-mini-tts', voice: 'casual_female' },
  { model: 'openai/gpt-4o-mini-tts', voice: 'coral' },
  { model: 'openai/gpt-4o-mini-tts-2025-12-15', voice: 'coral' },
];

const openrouter = {
  name: 'openrouter',
  ext: 'mp3',
  resolved: null,
  isConfigured: () => Boolean(process.env.OPENROUTER_API_KEY),
  describe() {
    if (this.resolved) return `OpenRouter ${this.resolved.model} / ${this.resolved.voice}`;
    const model = process.env.REELS_TTS_MODEL || OPENROUTER_VOICES[0].model;
    return `OpenRouter ${model} / ${process.env.REELS_VOICE || OPENROUTER_VOICES[0].voice}`;
  },
  async request(model, voice, text) {
    const res = await axios.post(
      'https://openrouter.ai/api/v1/audio/speech',
      { model, voice, input: text, response_format: 'mp3' },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://rallynews.com',
          'X-Title': 'Rally News Pipeline',
        },
        responseType: 'arraybuffer',
        timeout: 60000,
      }
    );
    return Buffer.from(res.data);
  },
  async speak(text) {
    if (this.resolved) {
      return this.request(this.resolved.model, this.resolved.voice, text);
    }

    // An explicit model/voice is taken at face value — no chain, no surprises.
    if (process.env.REELS_TTS_MODEL) {
      this.resolved = {
        model: process.env.REELS_TTS_MODEL,
        voice: process.env.REELS_VOICE || OPENROUTER_VOICES[0].voice,
      };
      return this.request(this.resolved.model, this.resolved.voice, text);
    }

    // A voice named on its own overrides every candidate's default, so you can
    // switch to e.g. neutral_female without also pinning a model.
    const forcedVoice = process.env.REELS_VOICE;
    const candidates = forcedVoice
      ? OPENROUTER_VOICES.map(c => ({ model: c.model, voice: forcedVoice }))
      : OPENROUTER_VOICES;

    let lastError;
    for (const candidate of candidates) {
      try {
        const buf = await this.request(candidate.model, candidate.voice, text);
        this.resolved = candidate;
        console.log(`  [reel] voice resolved to ${candidate.model} / ${candidate.voice}`);
        return buf;
      } catch (err) {
        lastError = err;
        const status = err.response?.status;
        console.warn(
          `  [reel] ${candidate.model}/${candidate.voice} unavailable` +
          `${status ? ` (HTTP ${status})` : ` (${err.message})`}, trying next...`
        );
      }
    }
    throw lastError || new Error('No OpenRouter speech model accepted the request');
  },
};

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

const PROVIDERS = [openrouter, azure, elevenlabs, openai];

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
      'No text-to-speech provider configured — set OPENROUTER_API_KEY (recommended, ' +
      'and already used for the copy), or AZURE_SPEECH_KEY / ELEVENLABS_API_KEY / OPENAI_API_KEY'
    );
  }
  return available;
}

function isConfigured() {
  return PROVIDERS.some(p => p.isConfigured());
}

// Which provider a run would use, for logging and the delivery header.
function describeProvider() {
  try {
    return selectProvider().describe();
  } catch (err) {
    return `none (${err.message})`;
  }
}

// Voice every line, one request each. Returns the provider plus a buffer per
// line in script order.
async function narrateLines(lines) {
  const provider = selectProvider();
  console.log(`  [reel] voicing ${lines.length} lines via ${provider.name}...`);

  const clips = [];
  for (let i = 0; i < lines.length; i++) {
    const buf = await provider.speak(lines[i].text);
    if (!buf || buf.length < 512) {
      throw new Error(`Voice provider returned an empty clip for line ${i + 1}`);
    }
    clips.push(buf);
  }

  // Described after the fact: providers that resolve a model/voice on the first
  // call only know their real identity once they've spoken.
  const label = provider.describe();
  console.log(`  [reel] voiced by ${label}`);
  return { provider: provider.name, label, ext: provider.ext, clips };
}

module.exports = { narrateLines, isConfigured, selectProvider, describeProvider };
