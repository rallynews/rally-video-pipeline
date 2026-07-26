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
**1080×1920 MP4**, 25–35 seconds, uploaded to R2 next to the day's slides.

The five steps, once the carousel copy has been written and fact-checked:

1. **Script** (`src/reels/script-writer.js`) — Mistral rewrites the *same*
   fact-checked story arc as a 55–78 word spoken script (≈20–30s), casual and
   colloquial, closing on the same engagement question. It comes back split
   into 7–11 lines, each with the short on-screen headline that goes with it.
   The model is told to use **only** facts already in the carousel copy, so the
   reel inherits the fact-check instead of inventing around it.
2. **Cuts** (`src/reels/shot-planner.js`) — Mistral reads the script back and
   decides where the picture cuts, aiming for **15–25 shots** across the video.
   It only gets to pick from the keyword vocabulary actually present in your R2
   image library, so every shot resolves to a real file. Each shot carries a
   camera move (`push-in`, `pull-out`, `pan-left/right/up/down`) and a
   transition (`cut`, `whip-left`, `whip-right`, `dissolve`, `flash`,
   `zoom-punch`).
3. **Voice** (`src/reels/voice.js`) — each line is recorded on its own, so the
   edit is timed against the voice that actually plays rather than a
   words-per-second estimate. Default is **Azure Speech `en-GB-SoniaNeural`**
   in `westeurope`: a young British female neural voice, natural but not
   pretending to be a person, and free at this volume (see costs below).
   ElevenLabs and OpenAI are supported as alternatives.
4. **Music** (`src/reels/r2-catalogue.js`) — one track is drawn at random from
   your R2 audio folder, looped to length, and ducked under the narration.
5. **Assembly** (`src/reels/assembler.js`) — ffmpeg builds it in passes:
   Ken Burns move per shot → transition chain → Lora captions and the
   `rally.news` mark overlaid → the **Follow Us** card dissolved on the end →
   narration mixed over the music bed (which comes up over the ending) → muxed
   to H.264/AAC with `+faststart`.

The whole thing is a bonus deliverable: if the R2 assets, the voice key or
ffmpeg are missing, it logs why, skips, and the carousel goes out exactly as
before.

#### Assets you upload to R2

Everything creative lives in the bucket, so the library grows without a deploy.
Default layout (each prefix is overridable — see the variables table):

```
<bucket>/
├── reels/images/<keyword>/<name>.jpg   ← b-roll stills. THE FOLDER AND FILE
│                                          NAMES ARE THE KEYWORDS.
├── reels/audio/<name>.mp3              ← Creative Commons music beds
└── reels/outro/follow-us.mp4           ← the "Follow Us" Rally card
```

**Images** — `.jpg`, `.jpeg`, `.png` or `.webp`. Shoot for **at least
1080×1920**, or 1440px on the short side if landscape; anything smaller gets
upscaled and softens. They're cover-cropped to 9:16, so put the subject near
the centre. Aim for **80–200+ images** spread over the eight content pillars —
the picker penalises re-use, so a thin library repeats itself inside one reel.

The path *is* the keyword index. Every folder and filename segment under the
prefix is tokenised (split on `-`, `_`, `/`; trailing digits dropped; tokens of
3+ characters kept), and those tokens are the menu the shot planner chooses
from. So:

```
reels/images/solar/rooftop-panels-01.jpg   → solar, rooftop, panels
reels/images/community/volunteers-park.jpg → community, volunteers, park
reels/images/ocean/coral-reef-diver-03.jpg → ocean, coral, reef, diver
```

Name things the way the story would be described out loud — `river`, `forest`,
`hospital`, `laughing`, `sunrise`, `wind-turbines`, `kids-classroom` — not
`IMG_4471.jpg`.

**Music** — `.mp3`, `.m4a`, `.wav`, `.ogg`, `.opus` or `.flac`. Instrumental
only (lyrics fight the narration). Anything 30s+ is fine; shorter tracks are
looped. Keep the licence terms with them; the pipeline picks at random, so only
upload tracks you're happy to publish. 10–20 is plenty.

**The Follow Us card** — one MP4 at `reels/outro/follow-us.mp4`, ideally
1080×1920 and 3–4 seconds. Its own audio is discarded: the reel's music bed
carries straight through the ending. If the object is missing, a plain rendered
"Follow Us" card is used instead, so a run never ends mid-sentence.

#### Check your assets before switching it on

```bash
npm run reel-check          # builds reel-check.mp4 from canned copy
```

This runs the whole reel path — catalogue, script, cuts, voice, music, ffmpeg —
with a fixed story, so it costs a fraction of a cent and doesn't touch the RSS
feed, Telegram or Slack. It prints the shot list with the R2 key behind every
cut, which is the fastest way to see whether your keywords are landing.

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

Reel voice (optional — **one** of these turns the 9:16 reel on):

| Secret | Where to find it |
| --- | --- |
| `AZURE_SPEECH_KEY` | Azure Portal → create a **Speech** resource (free F0 tier) → Keys and Endpoint. **Recommended** |
| `AZURE_SPEECH_REGION` | the region you created it in — use `westeurope` (default if unset) |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` | alternative; voice ID defaults to Rachel |
| `OPENAI_API_KEY` | alternative; uses `gpt-4o-mini-tts` |

Providers are tried in that order and the first one configured wins. With none
of them set, the reel is skipped and the carousel run is unchanged.

Reel tuning (repository **variables**, not secrets — all optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `REELS_VOICE` | `en-GB-SoniaNeural` | the voice name. Other good young British female options: `en-GB-LibbyNeural`, `en-GB-AdaMultilingualNeural` |
| `REELS_VOICE_PROVIDER` | (auto) | force `azure`, `elevenlabs` or `openai` |
| `REELS_VOICE_RATE` | `-4%` | speaking rate (Azure) |
| `REELS_VOICE_STYLE` | `friendly` | Azure express-as style; set empty to disable |
| `R2_REELS_IMAGE_PREFIX` | `reels/images/` | where the b-roll lives |
| `R2_REELS_AUDIO_PREFIX` | `reels/audio/` | where the music lives |
| `R2_REELS_OUTRO_KEY` | `reels/outro/follow-us.mp4` | the Follow Us card |

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
| Text-to-speech | – | – | **$0** on Azure's free tier |
| Media | video model ~$0.20–0.50 | HTML→PNG on Actions: $0 | + ffmpeg on Actions: $0 |
| Storage | – | R2 ~$0 (free tier) | R2 ~$0 (free tier) |
| **Total** | **~$0.20–0.50** | **~$0.03–0.07** | **~$0.03–0.08** |

The reel adds **well under a cent a day**. The two extra Mistral calls (script
+ shot plan) run without web search, so they're a few tenths of a cent of text
tokens. The narration is ~450–650 characters; Azure's free F0 tier covers
500,000 characters a month, which is about 25× a daily reel — so text-to-speech
is genuinely $0 unless you switch providers. On the paid Azure tier it would be
~$0.008/run; ElevenLabs Flash is roughly $0.02–0.05/run and OpenAI
`gpt-4o-mini-tts` about $0.01/run.

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
