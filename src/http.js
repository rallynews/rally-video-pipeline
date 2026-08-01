const axios = require('axios');

// Retry for the network calls a run cannot continue without.
//
// A daily pipeline gets one shot at the wire. A single transient hiccup — a
// reset connection, a DNS blip, a TLS alert from a server having a bad moment
// — killed the whole run and lost the day's post, which is a poor trade for
// something that usually clears in seconds. These helpers spend a few seconds
// retrying instead.
//
// The distinction that matters is transient vs. real. A 404 or a bad API key
// will fail identically on every attempt, so retrying only delays the error
// report; those are raised immediately.

// Socket- and TLS-level failures. EPROTO in particular covers the handshake
// alerts a server sends when it is momentarily unhealthy (alert 80 =
// internal_error), which is what took out the RSS fetch.
const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE',
  'EAI_AGAIN', 'EPROTO', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND',
  'ERR_SOCKET_CONNECTION_TIMEOUT', 'ERR_BAD_RESPONSE',
]);

// Some TLS failures arrive with no `.code` set at all, only a message.
const TRANSIENT_MESSAGE = /EPROTO|ssl3?_read_bytes|tlsv1 alert|SSL routines|handshake|socket hang up|Client network socket disconnected|timeout of \d+ms exceeded/i;

// A failure with no HTTP response never reached the application — the wire
// broke. Worth another go.
function isTransientNetwork(err) {
  if (err && err.response) return false;
  if (err && err.code && TRANSIENT_CODES.has(err.code)) return true;
  return TRANSIENT_MESSAGE.test(String((err && err.message) || ''));
}

// The server answered, but with something that may not repeat: it is
// overloaded (5xx) or throttling us (429).
function isTransientStatus(err) {
  const status = err && err.response && err.response.status;
  return status === 429 || (status >= 500 && status < 600);
}

function isRetryable(err) {
  return isTransientNetwork(err) || isTransientStatus(err);
}

// Exponential with jitter, so a retry never lands in lockstep with whatever
// else is hammering the same host.
function backoffMs(attempt) {
  const base = 2000 * Math.pow(2.2, attempt - 1);
  return Math.round(base + Math.random() * 750);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Run `fn` until it succeeds or stops being worth retrying.
//   attempts  total tries, including the first (default 4 → ~2s, 4s, 10s waits)
//   label     what to call this in the log
//   retryable predicate; defaults to transient network + 429/5xx
async function withRetry(fn, { attempts = 4, label = 'request', retryable = isRetryable } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (!retryable(err) || attempt === attempts) break;

      const wait = backoffMs(attempt);
      const reason = err.response
        ? `HTTP ${err.response.status}`
        : (err.code || String(err.message || '').split('\n')[0].slice(0, 80));
      console.warn(
        `  [http] ${label} failed (${reason}) — retrying in ${(wait / 1000).toFixed(1)}s ` +
        `[attempt ${attempt + 1}/${attempts}]`
      );
      await sleep(wait);
    }
  }

  throw lastError;
}

// axios.get with the retry policy applied.
async function getWithRetry(url, config = {}, options = {}) {
  return withRetry(() => axios.get(url, config), { label: options.label || 'GET', ...options });
}

module.exports = {
  withRetry,
  getWithRetry,
  isRetryable,
  isTransientNetwork,
  isTransientStatus,
  backoffMs,
};
