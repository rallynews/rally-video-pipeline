// The pipeline's line to Rally Studio (rally-frontend's api/carousel.php).
//
// Studio owns every batch: the stories an editor picked, the drafts they edit,
// the finished reels. The workflow is dispatched with nothing but a batch
// number (and, for a retry, one slot number), and this client fetches the work
// from Studio and posts each result back to it.
//
// Auth is CAROUSEL_API_KEY, sent as X-Carousel-Key. Studio scopes it to this
// job: read a dispatched slot's story and draft, write that slot's result.
//
// Plain fetch (Node 18+), so the workflow's planning and finishing jobs can
// talk to Studio without an `npm install`.

const DEFAULT_URL = 'https://rally.news/api/carousel.php';
const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function baseUrl() {
  return (process.env.STUDIO_API_URL || DEFAULT_URL).trim();
}

function key() {
  const k = process.env.CAROUSEL_API_KEY || '';
  if (!k) throw new Error('CAROUSEL_API_KEY is not set — the pipeline cannot reach Studio');
  return k;
}

async function call(method, params, body, { attempts = 4 } = {}) {
  const url = new URL(baseUrl());
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'X-Carousel-Key': key(),
          'Content-Type': 'application/json',
          'User-Agent': 'rally-video-pipeline',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60000),
      });
      const text = await res.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 200) }; }
      if (res.ok) return data;
      const err = new Error(`Studio ${method} ${params.action || body.action}: HTTP ${res.status} ${data.error || ''}`.trim());
      err.status = res.status;
      if (!TRANSIENT.has(res.status)) throw err;
      lastError = err;
    } catch (err) {
      if (err.status && !TRANSIENT.has(err.status)) throw err;
      lastError = err;
    }
    if (attempt < attempts) {
      const wait = 2000 * Math.pow(2, attempt - 1) + Math.random() * 500;
      console.warn(`  [studio] ${lastError.message} — retrying in ${(wait / 1000).toFixed(1)}s`);
      await sleep(wait);
    }
  }
  throw lastError;
}

const get = (params) => call('GET', params, null);
const post = (body) => call('POST', {}, body);

module.exports = {
  // Slot ids waiting for this run.
  job: (batch, mode, item) => get({ action: 'job', batch, mode, item }),
  // One slot's story (and, for produce, its confirmed draft).
  work: (id, mode) => get({ action: 'work', id, mode }),
  scriptDone: (id, draft) => post({ action: 'script_done', id, draft }),
  produceDone: (id, result) => post({ action: 'produce_done', id, ...result }),
  failed: (id, mode, error) => post({ action: 'failed', id, mode, error: String(error || '').slice(0, 1000) }),
  // Whether this stage of the batch is now finished and its message is owed.
  finish: (batch, mode, items) => post({ action: 'finish', batch, mode, items }),
  baseUrl,
};
