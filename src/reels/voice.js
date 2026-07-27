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
// several speech providers. Note that Azure AI Speech is NOT one of them; the
// azure entry below talks to Azure directly and needs its own key.
//
// Model slugs and voice names are NOT guessable. Voices are namespaced per
// provider and don't transfer between them — OpenAI uses bare names (`alloy`,
// `coral`), Voxtral encodes language + persona + emotion (`en_paul_happy`),
// Kokoro prefixes language and gender (`af_bella`) — and a wrong pair is
// rejected with a bare 400 that says nothing useful. So rather than hardcode a
// guess, the provider asks OpenRouter which speech models the key can actually
// reach and which voices each one takes:
//
//   GET /api/v1/models?output_modalities=speech  →  [{ id, supported_voices }]
//
// and builds its candidate list from the answer, preferring Voxtral (European,
// and the closest to the young-casual read the reels want) and an English voice
// with a warm emotion. The static chain below is only the fallback for when
// that listing itself fails.

function xmlEscape(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Read whatever an axios error is actually carrying. Speech responses are
// arraybuffers, so an error body arrives as bytes and prints as "[object
// Object]" unless it's decoded — which is why the old chain could only report
// "Request failed with status code 400".
function errorDetail(err) {
  let body = err.response && err.response.data;
  if (body && (Buffer.isBuffer(body) || body instanceof ArrayBuffer)) {
    body = Buffer.from(body).toString('utf8');
  }
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { /* not JSON, use the text */ }
  }
  if (body && typeof body === 'object') {
    body = (body.error && (body.error.message || body.error)) || body.message || JSON.stringify(body);
  }
  const text = String(body == null ? '' : body).replace(/\s+/g, ' ').trim();
  return text.slice(0, 300);
}

// Last-resort candidates, used only when the models listing can't be read.
const OPENROUTER_FALLBACK = [
  { model: 'openai/gpt-4o-mini-tts-2025-12-15', voice: 'alloy' },
  { model: 'openai/gpt-4o-mini-tts', voice: 'alloy' },
];

// Which speech model to reach for first.
const MODEL_PREFERENCE = [/voxtral/i, /gpt-4o-mini-tts/i, /tts/i, /speech/i];

// Which voice within a model. Warm English first, then the OpenAI presets that
// suit a casual read, then any English voice at all.
const VOICE_PREFERENCE = [
  /^en[_-].*(happy|friendly|casual|warm|cheerful)/i,
  /^(coral|nova|shimmer|sage)$/i,
  /^en[_-]/i,
  /^[abf][fm][_-]/i,
  /^(alloy|verse|aria)$/i,
];

function rank(value, patterns) {
  const hit = patterns.findIndex(p => p.test(value));
  return hit === -1 ? patterns.length : hit;
}

function pickVoice(voices) {
  const usable = (voices || []).filter(v => typeof v === 'string' && v);
  if (!usable.length) return null;
  return [...usable].sort((a, b) => rank(a, VOICE_PREFERENCE) - rank(b, VOICE_PREFERENCE))[0];
}

// Ask OpenRouter what this key can actually use. Returns [] on any failure —
// the caller falls back to the static chain rather than failing the run here.
async function listSpeechModels() {
  try {
    const res = await axios.get('https://openrouter.ai/api/v1/models', {
      params: { output_modalities: 'speech' },
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
      timeout: 20000,
    });
    const models = (res.data && res.data.data) || [];
    return models
      .map(m => ({
        id: m.id,
        // The field has lived in both places across API revisions.
        voices: m.supported_voices || (m.architecture && m.architecture.supported_voices) || [],
      }))
      .filter(m => m.id)
      .sort((a, b) => rank(a.id, MODEL_PREFERENCE) - rank(b.id, MODEL_PREFERENCE));
  } catch (err) {
    console.warn(`  [reel] could not list OpenRouter speech models (${errorDetail(err) || err.message})`);
    return [];
  }
}

const openrouter = {
  name: 'openrouter',
  ext: 'mp3',
  resolved: null,
  isConfigured: () => Boolean(process.env.OPENROUTER_API_KEY),
  describe() {
    if (this.resolved) return `OpenRouter ${this.resolved.model} / ${this.resolved.voice}`;
    const model = process.env.REELS_TTS_MODEL || '(discovered at run time)';
    const voice = process.env.REELS_VOICE || '(best available)';
    return `OpenRouter ${model} / ${voice}`;
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
  // The (model, voice) pairs to try, best first: what the account can actually
  // reach, with a voice each model has declared support for.
  async candidates() {
    const forcedModel = process.env.REELS_TTS_MODEL;
    const forcedVoice = process.env.REELS_VOICE;

    const models = await listSpeechModels();
    if (models.length) {
      console.log(
        `  [reel] OpenRouter speech models available: ` +
        `${models.slice(0, 6).map(m => m.id).join(', ')}${models.length > 6 ? ', …' : ''}`
      );
    }

    // An explicit model is taken at face value; only its voice is filled in
    // from the listing when one wasn't named too.
    if (forcedModel) {
      const known = models.find(m => m.id === forcedModel);
      const voice = forcedVoice || (known && pickVoice(known.voices)) || 'alloy';
      if (known && forcedVoice && known.voices.length && !known.voices.includes(forcedVoice)) {
        console.warn(
          `  [reel] REELS_VOICE=${forcedVoice} isn't in ${forcedModel}'s voice list ` +
          `(${known.voices.slice(0, 8).join(', ')}) — trying it anyway`
        );
      }
      return [{ model: forcedModel, voice }];
    }

    // A named voice only makes sense on a model that declares it — voices don't
    // transfer between providers — so models that take it are tried first, and
    // the rest keep their own best voice as a fallback rather than dropping out.
    const takesForced = [];
    const rest = [];
    for (const model of models) {
      const supported = forcedVoice && (!model.voices.length || model.voices.includes(forcedVoice));
      const voice = supported ? forcedVoice : pickVoice(model.voices);
      if (!voice) continue;
      (supported ? takesForced : rest).push({ model: model.id, voice });
    }
    if (forcedVoice && !takesForced.length && models.length) {
      console.warn(
        `  [reel] no available speech model declares the voice REELS_VOICE=${forcedVoice} — ` +
        `using each model's closest voice instead`
      );
    }
    const discovered = [...takesForced, ...rest];

    if (!discovered.length) return OPENROUTER_FALLBACK;

    // Keep the static pairs on the end: a model can be listed and still refuse
    // the request, and one of these may yet answer.
    const seen = new Set(discovered.map(c => `${c.model}/${c.voice}`));
    return [...discovered, ...OPENROUTER_FALLBACK.filter(c => !seen.has(`${c.model}/${c.voice}`))];
  },

  async speak(text) {
    if (this.resolved) {
      return this.request(this.resolved.model, this.resolved.voice, text);
    }

    const candidates = await this.candidates();

    let lastError;
    for (const candidate of candidates) {
      try {
        const buf = await this.request(candidate.model, candidate.voice, text);
        this.resolved = candidate;
        console.log(`  [reel] voice resolved to ${candidate.model} / ${candidate.voice}`);
        return buf;
      } catch (err) {
        lastError = err;
        const status = err.response && err.response.status;
        const detail = errorDetail(err);
        console.warn(
          `  [reel] ${candidate.model}/${candidate.voice} unavailable` +
          `${status ? ` (HTTP ${status})` : ''}${detail ? `: ${detail}` : ` (${err.message})`}` +
          `, trying next...`
        );
      }
    }

    const tried = candidates.map(c => `${c.model}/${c.voice}`).join(', ');
    const why = lastError ? errorDetail(lastError) || lastError.message : 'no candidates';
    throw new Error(
      `No OpenRouter speech model accepted the request (tried ${tried || 'nothing'}) — ` +
      `last error: ${why}. Run npm run voice-check to see what the key can reach.`
    );
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
    let buf;
    try {
      buf = await provider.speak(lines[i].text);
    } catch (err) {
      // Axios reports "Request failed with status code 400" and hides the body,
      // which is where every provider puts the actual reason.
      const detail = errorDetail(err);
      throw new Error(
        `${provider.name} could not voice line ${i + 1}: ${detail || err.message}`
      );
    }
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

module.exports = {
  narrateLines,
  isConfigured,
  selectProvider,
  describeProvider,
  listSpeechModels,
  pickVoice,
  errorDetail,
  PROVIDERS,
};
