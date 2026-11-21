const axios = require('axios');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const catalogue = require('../reels/r2-catalogue');

// A slot's script draft: everything the models decided, before anything is
// voiced or cut, in the shape Studio's script editor edits and the produce run
// builds from. It goes to Studio (not into this repo); the editor changes it
// there and confirms it, and the produce run fetches the confirmed copy back.

function publicUrl(key) {
  const base = (process.env.R2_VIDEO_PUBLIC_URL || process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
  return base ? `${base}/${key}` : null;
}

// Stage the article's cover photo in the videos bucket, so Studio can show it
// and the produce run uses the exact same image later — the article page
// itself may change between script and production.
async function stageCover(coverUri, prefix) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(String(coverUri || ''));
  if (!match || match[1].includes('svg')) return null;

  const ext = match[1].includes('png') ? 'png' : match[1].includes('webp') ? 'webp' : 'jpg';
  const key = `${prefix}/cover.${ext}`;
  await catalogue.getClient().send(new PutObjectCommand({
    Bucket: catalogue.VIDEO_BUCKET(),
    Key: key,
    Body: Buffer.from(match[2], 'base64'),
    ContentType: match[1],
    CacheControl: 'public, max-age=86400',
  }));
  return publicUrl(key);
}

// Assemble the draft Studio stores for one slot.
function buildDraft({ story, raw, pillar, sources, verification, captions, reelPlan, coverUrl }) {
  // The image picker's whole catalogue: one entry per FILE the reel could cut
  // to — keyworded stills and the generic pool alike — each with the object key
  // the builder will honour and a thumbnail to show it by. Entries with no
  // public URL are dropped, since the picker must never offer an image it can't
  // display. Everything that can reach the reel is in here; nothing else can.
  const library = (reelPlan.library || [])
    .map(entry => ({ ...entry, url: publicUrl(entry.key) }))
    .filter(entry => entry.url);

  return {
    version: 2,
    createdAt: new Date().toISOString(),
    story: {
      headline: story.headline,
      summary: story.summary,
      publisher: story.publisher,
      url: story.url,
    },
    researchBrief: String(raw.researchBrief || '').trim(),
    sources,
    verification,
    pillar,
    // The fact-checked story outline the script was written from. Not edited
    // in Studio, but the reel builder reads the photo credit and keywords off it.
    raw,
    cover: coverUrl ? { url: coverUrl } : null,
    // Copy-paste captions; editable in Studio. The link is the first comment.
    captions: {
      facebook: captions.facebook,
      instagram: captions.instagram,
      // Tracked links (src/tracking.js): Facebook's first comment, Instagram's
      // link in bio. `link` is the Facebook one, kept for older readers.
      link: (captions.links && captions.links.facebook) || captions.link,
      links: captions.links || null,
    },
    reel: {
      script: reelPlan.script,
      hook: reelPlan.hook || '',
      noMusic: false,
      mood: reelPlan.mood,
      wordCount: reelPlan.wordCount,
      lines: reelPlan.lines.map(l => ({ text: l.text })),
      shots: reelPlan.shots.map((s, i) => {
        // The first shot is always replaced by the article photo at build
        // time; the draft shows that honestly — and still carries the library
        // image underneath, which is what opens the reel if the article's
        // photo turns out to be unusable. Both are shown in Studio, so there
        // is no image in the finished reel the editor didn't see.
        const cover = i === 0 && Boolean(coverUrl);
        return {
          ...s,
          cover,
          thumb: cover ? coverUrl : publicUrl(s.key),
          fallbackThumb: cover ? publicUrl(s.key) : null,
        };
      }),
      stockedKeywords: reelPlan.stockedKeywords,
      library,
    },
  };
}

// Fetch the staged cover back as a data URI for the reel, or null.
async function fetchCover(draft) {
  const url = draft.cover && draft.cover.url;
  if (!url) return null;
  try {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
    const type = (res.headers['content-type'] || 'image/jpeg').split(';')[0];
    return `data:${type};base64,${Buffer.from(res.data).toString('base64')}`;
  } catch (e) {
    console.warn(`  [draft] staged cover fetch failed (${e.message})`);
    return null;
  }
}

module.exports = { stageCover, buildDraft, fetchCover, publicUrl };
