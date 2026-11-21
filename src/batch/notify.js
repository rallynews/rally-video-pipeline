// The two "ready" messages a batch sends, to Slack and Telegram, each carrying
// the batch's Studio link — the same URL both times, which always opens the
// batch at the step that needs a person:
//
//   scripts ready  → review and confirm them in Studio
//   videos ready   → copy captions, post, mark Used
//
// Deliberately short: Studio is where the detail lives. Telegram goes out as
// plain text (no parse_mode — its Markdown parser rejects a whole message over
// one stray underscore in a headline) with the link as an inline button; Slack
// gets the same text plus a button block. Plain fetch, so the workflow's finish
// job needs no `npm install`.

function lines(summary, mode) {
  return summary.items.map(it => {
    const head = it.headline || '(no story)';
    if (it.failed) return `${it.slot}. ${head} — failed, needs a retry`;
    const extra = mode === 'produce' && it.duration_s ? ` · ${Math.round(it.duration_s)}s` : '';
    return `${it.slot}. ${head} (${it.theme})${extra}`;
  });
}

function compose(summary) {
  const mode = summary.mode;
  const total = summary.items.length;
  const failed = summary.items.filter(i => i.failed).length;
  const ok = total - failed;
  const noun = mode === 'produce' ? 'video' : 'script';
  const title = failed
    ? `Carousel: ${ok} of ${total} ${noun}s ready, ${failed} need${failed === 1 ? 's' : ''} a retry`
    : `Carousel: ${total} ${noun}${total === 1 ? '' : 's'} ready${mode === 'produce' ? '' : ' to review'}`;
  const action = mode === 'produce' ? 'Open the videos in Studio' : 'Review and confirm in Studio';
  return {
    title,
    action,
    body: lines(summary, mode).join('\n'),
    url: summary.url,
    icon: mode === 'produce' ? '🎬' : '📝',
  };
}

async function sendTelegram(msg) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) { console.log('  [notify] Telegram not configured — skipped'); return; }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chat,
      text: `${msg.icon} ${msg.title}\n\n${msg.body}\n\n${msg.action}:\n${msg.url}`,
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: `${msg.action} →`, url: msg.url }]] },
    }),
  });
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  console.log('  [notify] sent to Telegram');
}

// Slack mrkdwn treats <, > and & specially; headlines are escaped so a story
// title can never become a link or a mention.
function slackEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendSlack(msg) {
  const token = process.env.SLACK_BOT_TOKEN, channel = process.env.SLACK_CHANNEL_ID;
  if (!token || !channel) { console.log('  [notify] Slack not configured — skipped'); return; }
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      channel,
      text: `${msg.title} — ${msg.url}`,
      unfurl_links: false,
      unfurl_media: false,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `${msg.icon} *${slackEscape(msg.title)}*\n${slackEscape(msg.body)}` } },
        { type: 'actions', elements: [{ type: 'button', style: 'primary', text: { type: 'plain_text', text: `${msg.action} →` }, url: msg.url }] },
      ],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Slack: ${data.error || res.status}`);
  console.log('  [notify] sent to Slack');
}

// Both channels, independently: one failing never stops the other.
async function sendReady(summary) {
  const msg = compose(summary);
  const results = await Promise.allSettled([sendSlack(msg), sendTelegram(msg)]);
  for (const r of results) if (r.status === 'rejected') console.warn(`  [notify] ${r.reason.message}`);
  return msg;
}

// A run that broke before it could report anything to Studio.
async function sendAlert(text) {
  const msg = { icon: '⚠️', title: 'Carousel run failed', body: String(text).slice(0, 1500), action: 'Check the Actions log', url: process.env.RUN_URL || 'https://github.com/rallynews/rally-video-pipeline/actions' };
  await Promise.allSettled([sendSlack(msg), sendTelegram(msg)]);
}

module.exports = { sendReady, sendAlert, compose };
