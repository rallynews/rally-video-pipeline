#!/usr/bin/env node
// Which voice the reel will use, and whether it actually works.
//
//   node scripts/voice-check.js              # list what the key can reach, record one line
//   node scripts/voice-check.js --list       # list only, no synthesis, no cost
//   node scripts/voice-check.js out.mp3      # write the sample somewhere specific
//
// Voice names on OpenRouter are namespaced per provider and don't transfer
// between them, so "which voices does my key actually accept" is the question
// this answers. It prints every speech model the key can see with its declared
// voices, the pair the reel would pick, and then records one line so you can
// hear it.
//
// Needs: one voice key (OPENROUTER_API_KEY, AZURE_SPEECH_KEY, ELEVENLABS_API_KEY
// or OPENAI_API_KEY).

const fs = require('fs');
const path = require('path');
const voice = require('../src/reels/voice');

const LINE = 'A handful of farmers gave a strip of land back to the river, and it is running year-round again.';

const argv = process.argv.slice(2);
const LIST_ONLY = argv.includes('--list');
const outArg = argv.find(a => !a.startsWith('--'));

(async () => {
  if (!voice.isConfigured()) {
    console.error(
      'No text-to-speech provider configured — set OPENROUTER_API_KEY (recommended), ' +
      'or AZURE_SPEECH_KEY / ELEVENLABS_API_KEY / OPENAI_API_KEY'
    );
    process.exit(1);
  }

  const configured = voice.PROVIDERS.filter(p => p.isConfigured()).map(p => p.name);
  console.log(`Providers with credentials: ${configured.join(', ')}`);

  const provider = voice.selectProvider();
  console.log(`Provider in use: ${provider.name}${process.env.REELS_VOICE_PROVIDER ? ' (forced)' : ''}`);

  if (process.env.OPENROUTER_API_KEY) {
    const models = await voice.listSpeechModels();
    console.log(`\nOpenRouter speech models this key can see: ${models.length}`);
    for (const m of models) {
      const voices = m.voices.length
        ? `${m.voices.slice(0, 10).join(', ')}${m.voices.length > 10 ? `, … (${m.voices.length})` : ''}`
        : '(none declared)';
      const pick = voice.pickVoice(m.voices);
      console.log(`  ${m.id}`);
      console.log(`    voices: ${voices}`);
      console.log(`    would pick: ${pick || '(no usable voice)'}`);
    }
    if (!models.length) {
      console.log(
        '  Nothing listed. Either the key has no access to speech models, or the\n' +
        '  models endpoint is unreachable — the reel will fall back to a static\n' +
        '  candidate list and probably fail the same way the pipeline did.'
      );
    }
    if (provider.name === 'openrouter' && provider.candidates) {
      const candidates = await provider.candidates();
      console.log(`\nThe reel will try, in order:`);
      candidates.forEach((c, i) => console.log(`  ${i + 1}. ${c.model} / ${c.voice}`));
    }
  }

  if (LIST_ONLY) {
    console.log('\n--list given, nothing synthesised.');
    return;
  }

  const out = path.resolve(outArg || `voice-check.${provider.ext}`);
  console.log(`\nRecording one line via ${provider.name}...`);
  const { clips, label } = await voice.narrateLines([{ text: LINE }]);
  fs.writeFileSync(out, clips[0]);
  console.log(`Voiced by ${label}`);
  console.log(`Wrote ${out} — ${(clips[0].length / 1024).toFixed(0)} KB`);
})().catch(err => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
