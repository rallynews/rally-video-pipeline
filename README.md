# rally-video-pipeline

Two independent content pipelines that pick the day's most viral positive
story from the Rally RSS feed and turn it into ready-to-post social content.
Each runs as its own GitHub Actions workflow, so you can enable/disable one
without touching the other.

## 1. Video pipeline (`index.js`)

Picks a story → writes a short UGC script + caption + tweet with Mistral →
generates a talking-head video → delivers it to Telegram. Workflow:
`.github/workflows/video-pipeline.yml`.

## 2. Carousel pipeline (`carousel.js`)

Picks the **same-logic** story → **researches and corroborates it on the web**
→ writes a 5-part carousel with Mistral → **fact-checks that copy in a second
pass** (cross-references every claim against the article and other sources,
demands positive proof, rewrites anything unproven) → renders 6 branded PNG
slides (1080×1350, @2x) in one of four randomly chosen styles (1a–1d) → uploads
them to Cloudflare R2 → delivers everything to **Telegram and Slack**. The
cover photo is the article's featured image (`<img class="rv-figure-img">` on
the story's rally.news page). Workflow:
`.github/workflows/carousel-pipeline.yml` (runs daily at 14:00 UTC and can be
triggered manually).

The six slides map to: **1** Intro (cover photo + content pillar + grippy
headline) · **2** The Challenge · **3** The Solution · **4** Results & Impact ·
**5** Why It Matters (closes on an engagement question) · **6** Follow Rally
News closer. Every slide carries Rally branding: the mark top-right on the
cover, and the mark + `rally.news` wordmark bottom-left on the rest.

Delivery to both Telegram and Slack (so captions paste cleanly on a phone or
desktop). On each platform:

1. The 6 slides with an info/header (story, source, pillar, style, R2 links,
   sources) — on Telegram a header message then the album; on Slack the images
   shared with the header as their comment.
2. The **Facebook** caption — its own message, plain text, nothing else (ends
   in the engagement question, includes the story link, 3 hashtags).
3. The **Instagram** caption — its own message, plain text, nothing else (same
   question, "link in bio", same 3 hashtags).

Both captions end on the same question and carry `#goodnews #positivenews` plus
one popular story-specific hashtag. Slack delivery is skipped gracefully if its
secrets aren't set.

## Setup

### Secrets (GitHub → Settings → Secrets and variables → Actions)

Shared with the video pipeline:

| Secret | Purpose |
| --- | --- |
| `OPENROUTER_API_KEY` | Mistral copy + web-search corroboration |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Telegram delivery |
| `RALLY_RSS_URL` | Source feed |
| `BREVO_API_KEY` / `ALERT_EMAIL` | Failure alerts (optional) |

New, carousel-only (Cloudflare R2):

| Secret | Where to find it |
| --- | --- |
| `R2_ACCOUNT_ID` | Cloudflare dashboard → R2 → account ID |
| `R2_ACCESS_KEY_ID` | R2 → Manage API Tokens → create token |
| `R2_SECRET_ACCESS_KEY` | shown once when the token is created |
| `R2_BUCKET` | your bucket name |
| `R2_PUBLIC_URL` | the bucket's public URL or custom domain (no trailing slash) |

If the R2 secrets are missing the run still completes and delivers via
Telegram — it just skips the upload and logs a warning.

Slack (optional — carousel posts to Slack too when set):

| Secret | Where to find it |
| --- | --- |
| `SLACK_BOT_TOKEN` | a Slack app Bot User OAuth Token (`xoxb-…`) with `chat:write` + `files:write` scopes |
| `SLACK_CHANNEL_ID` | the target channel's ID (the bot must be invited to it) |

If the Slack secrets are missing, Slack delivery is skipped and the run still
completes on Telegram.

### Run it

Runs automatically every day at **14:00 UTC** (change the `schedule` cron in
the workflow to your preferred time). To run on demand: GitHub → Actions →
**Rally News Carousel Pipeline** → Run workflow.

## Cost per run (approx.)

| | Video | Carousel |
| --- | --- | --- |
| Text (Mistral) | ~$0.001 | ~$0.003–0.007 |
| Web research (write) | – | ~$0.01–0.04 |
| Web research (fact-check pass) | – | ~$0.01–0.02 |
| Media | video model ~$0.20–0.50 | HTML→PNG on Actions: $0 |
| Storage | – | R2 ~$0 (free tier) |
| **Total** | **~$0.20–0.50** | **~$0.03–0.07** |

The carousel still runs roughly 1/10th the cost of a video. The fact-check pass
adds one more web-search-enabled Mistral call (~$0.01–0.02, dominated by web
search); text tokens are a fraction of a cent.

## Local development

```bash
npm install
# render smoke test uses the four styles; needs a Chromium.
# In CI, puppeteer's bundled Chromium is used automatically.
node carousel.js   # requires the env vars above
```
