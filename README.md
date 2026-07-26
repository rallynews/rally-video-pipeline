# rally-video-pipeline

Two independent content pipelines that pick the day's most viral positive
story from the Rally RSS feed and turn it into ready-to-post social content.
Each runs as its own GitHub Actions workflow, so you can enable/disable one
without touching the other.

## 1. Video pipeline (`index.js`)

Picks a story → writes a short UGC script + caption + tweet with Mistral →
generates a talking-head video → delivers it to Telegram. Workflow:
`.github/workflows/video-pipeline.yml`.

## 2. Carousel pipeline (`carousel.js`) — slides **and** the 9:16 reel

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

### 2b. The 9:16 reel (part of the same run)

The carousel run also cuts a **Reels / Shorts video** telling the same story,
and posts it to Telegram and Slack alongside the slides. Output is a
**1080×1920 MP4**, 25–35 seconds, written back to `rally-news-videos/out/`.

The five steps, once the carousel copy has been written and fact-checked:

1. **Script** (`src/reels/script-writer.js`) — Mistral rewrites the *same*
   fact-checked story arc as a 55–78 word spoken script (≈20–30s), casual and
   colloquial, closing on the same engagement question. It comes back split
   into 7–11 lines, each with the short on-screen headline that goes with it.
   The model is told to use **only** facts already in the carousel copy, so the
   reel inherits the fact-check instead of inventing around it.
2. **Cuts** (`src/reels/shot-planner.js`) — Mistral reads the script back and
   decides where the picture cuts, aiming for **15–25 shots** across the video.
   It picks keywords from a fixed **keyword bank** (`src/reels/keywords.js`),
   and is shown which of those words currently have images behind them, so
   cuts land on real subjects. Anything off-bank is discarded and falls through
   to the generic pool. Each shot carries a camera move (`push-in`,
   `pull-out`, `pan-left/right/up/down`) and a transition (`cut`, `whip-left`,
   `whip-right`, `dissolve`, `flash`, `zoom-punch`).
3. **Voice** (`src/reels/voice.js`) — each line is recorded on its own, so the
   edit is timed against the voice that actually plays rather than a
   words-per-second estimate. Default is **OpenRouter's `/audio/speech`**
   endpoint on the key the pipeline already uses, asking for Mistral's
   **Voxtral** `casual_female` first (European, casual, unmistakably synthetic
   without being robotic) and falling back to OpenAI's `gpt-4o-mini-tts`.
   Azure Speech, ElevenLabs and OpenAI direct are supported as alternatives.
4. **Music** (`src/reels/r2-catalogue.js`) — one track is drawn at random from
   the `audio/` folder, looped to length, and ducked under the narration.
5. **Assembly** (`src/reels/assembler.js`) — ffmpeg builds it in passes:
   Ken Burns move per shot → transition chain → Lora captions and the
   `rally.news` mark overlaid → the **Follow Us** card dissolved on the end →
   narration mixed over the music bed (which comes up over the ending) → muxed
   to H.264/AAC with `+faststart`.

The whole thing is a bonus deliverable: if the R2 assets or ffmpeg are missing,
it logs why, skips, and the carousel goes out exactly as before.

#### Assets you upload to R2

Everything creative lives in its own bucket — **`rally-news-videos`** — so the
library grows without a deploy. Four flat folders, no nesting:

```
rally-news-videos/
├── images/     ← keyworded b-roll. THE FILENAME IS THE KEYWORD.
├── generic/    ← happy-planet stills, the fallback when nothing matches
├── audio/      ← Creative Commons music beds
├── outro/      ← the "Follow Us" Rally card, as an MP4
└── out/        ← written by the pipeline: out/<date>/<slug>.mp4
```

**`images/`** — `.jpg`, `.jpeg`, `.png` or `.webp`, all in the one folder. The
filename carries the keywords, and they must come from the **keyword bank** in
`src/reels/keywords.js` (212 words across 11 themes). One to three bank words
plus a counter:

```
solar-panels-01.jpg        → solar, panels
volunteers-hands-03.jpg    → volunteers, hands
river-sunrise-02.jpg       → river, sunrise
```

Words outside the bank are ignored, and an image matching no bank word is
logged as unpickable on the next run — so typos surface instead of silently
costing you a shot. Shoot for **at least 1080×1920**, or 1440px on the short
side if landscape; they're cover-cropped to 9:16, so keep the subject centred.
**3–5 images per keyword you care about** gives the picker room; it penalises
re-use, so a thin library repeats itself inside one reel.

**`generic/`** — the fallback pool. Any filename; no keywords needed. Used
whenever a requested keyword has nothing behind it, so these should be pretty,
uplifting, subject-agnostic frames that sit under any sentence: landscapes,
light through trees, hands, crowds, skies. **20–40** is plenty.

**`audio/`** — `.mp3`, `.m4a`, `.wav`, `.ogg`, `.opus` or `.flac`. Instrumental
only (lyrics fight the narration). Anything 30s+ is fine; shorter tracks are
looped. One is picked at random per run, so only upload tracks you're happy to
publish. 10–20 is plenty.

**`outro/`** — the Follow Us card as an MP4, ideally 1080×1920 and 3–4 seconds.
Its own audio is discarded: the reel's music bed carries straight through the
ending. If there's more than one file the last by name wins, so
`follow-us-v2.mp4` supersedes `follow-us.mp4` without deleting anything. If the
folder is empty a plain rendered card is used, so a run never ends mid-sentence.

#### The opening shot is always the article's own photo

The reel opens on the same featured image the carousel puts on its cover, with
a **`Photo: <outlet>`** credit in the bottom-right for the first ~2.4 seconds,
crediting the outlet that published it (the same name the carousel credits).
Everything after that comes from the library. If the article has no usable
photo, the reel opens on library footage instead and no credit is shown.

#### Check your assets before switching it on

```bash
npm run reel-check          # builds reel-check.mp4 from canned copy
```

This runs the whole reel path — catalogue, script, cuts, voice, music, ffmpeg —
with a fixed story, so it costs a fraction of a cent and doesn't touch the RSS
feed, Telegram or Slack. It prints the shot list with the R2 key behind every
cut, which is the fastest way to see whether your keywords are landing. It also
warns about any image whose filename matches no bank keyword.

To exercise the opening-photo path too, point it at a real article:

```bash
REEL_CHECK_STORY_URL="https://rally.news/?article=..." npm run reel-check
```

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

Reel voice — **no new secret needed**. The default provider is OpenRouter's
`/audio/speech` endpoint on the `OPENROUTER_API_KEY` you already have. These
only matter if you want a different provider:

| Secret | Where to find it |
| --- | --- |
| `AZURE_SPEECH_KEY` | Azure Portal → create a **Speech** resource (free F0 tier) → Keys and Endpoint |
| `AZURE_SPEECH_REGION` | the region you created it in — defaults to `westeurope` |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` | voice ID defaults to Rachel |
| `OPENAI_API_KEY` | uses `gpt-4o-mini-tts` directly |

Providers are tried OpenRouter → Azure → ElevenLabs → OpenAI, and the first one
configured wins.

Reel tuning (repository **variables**, not secrets — all optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `R2_VIDEO_BUCKET` | `rally-news-videos` | the bucket holding reel assets and output |
| `R2_VIDEO_PUBLIC_URL` | falls back to `R2_PUBLIC_URL` | public base URL for reel links |
| `R2_REELS_IMAGE_PREFIX` | `images/` | keyworded b-roll |
| `R2_REELS_GENERIC_PREFIX` | `generic/` | the fallback pool |
| `R2_REELS_AUDIO_PREFIX` | `audio/` | music beds |
| `R2_REELS_OUTRO_PREFIX` | `outro/` | the Follow Us card |
| `REELS_VOICE_PROVIDER` | (auto) | force `openrouter`, `azure`, `elevenlabs` or `openai` |
| `REELS_TTS_MODEL` | (auto) | pin an OpenRouter speech model instead of the fallback chain |
| `REELS_VOICE` | per provider | voice name — e.g. `casual_female` (Voxtral), `coral` (OpenAI), `en-GB-SoniaNeural` (Azure) |
| `REELS_VOICE_RATE` | `-4%` | speaking rate (Azure only) |
| `REELS_VOICE_STYLE` | `friendly` | Azure express-as style; set empty to disable |

### Run it

Runs automatically every day at **14:00 UTC** (change the `schedule` cron in
the workflow to your preferred time). To run on demand: GitHub → Actions →
**Rally News Carousel Pipeline** → Run workflow.

## Cost per run (approx.)

| | Video | Carousel | Carousel + reel |
| --- | --- | --- | --- |
| Text (Mistral) | ~$0.001 | ~$0.003–0.007 | ~$0.005–0.010 |
| Web research (write) | – | ~$0.01–0.04 | ~$0.01–0.04 |
| Web research (fact-check pass) | – | ~$0.01–0.02 | ~$0.01–0.02 |
| Text-to-speech | – | – | ~$0.001–0.003 |
| Media | video model ~$0.20–0.50 | HTML→PNG on Actions: $0 | + ffmpeg on Actions: $0 |
| Storage | – | R2 ~$0 (free tier) | R2 ~$0 (free tier) |
| **Total** | **~$0.20–0.50** | **~$0.03–0.07** | **~$0.03–0.08** |

The reel adds **well under a cent a day**. The two extra Mistral calls (script
+ shot plan) run without web search, so they're a few tenths of a cent of text
tokens. The narration is ~450–650 characters, which is a fraction of a cent on
any of the OpenRouter speech models. Azure's free F0 tier (500,000
characters/month, ~25× a daily reel) would make it exactly $0 if you'd rather
not spend OpenRouter credit at all; ElevenLabs Flash is roughly $0.02–0.05/run.

The compute is free too: everything is ffmpeg on the GitHub Actions runner,
which adds roughly **3–6 minutes** to the job (well inside the free tier for a
public repo, ~$0.02–0.05 of included minutes for a private one). R2 egress is
free and a month of daily reels is a few hundred MB.

## Local development

```bash
npm install
sudo apt-get install -y ffmpeg    # reels only; macOS: brew install ffmpeg

npm run carousel                  # full daily run — requires the env vars above
npm run reel-check                # just the reel, from canned copy
```

Rendering uses puppeteer's bundled Chromium, which `npm install` fetches; in CI
it's picked up automatically.
