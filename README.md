# rally-video-pipeline

Two independent content pipelines that turn Rally's positive stories into
ready-to-post social video. Each runs as its own GitHub Actions workflow, so
you can enable/disable one without touching the other.

## 1. Video pipeline (`index.js`)

Picks a story → writes a short UGC script + caption + tweet with Mistral →
generates a talking-head video → delivers it to Telegram. Workflow:
`.github/workflows/video-pipeline.yml`.

## 2. Studio Carousel — batches of 9:16 reels (`batch.js`)

**Driven entirely from Rally Studio ▸ Promotion ▸ Carousel** (source:
`rallynews/rally-frontend`, `studio/pages/carousel.js` + `api/carousel.php`).
Nothing runs on a schedule; nothing is posted anywhere automatically.

| Step | Where | What happens |
| --- | --- | --- |
| **1 · Stories** | Studio | Pick 1–7 videos and give each a theme (a prompt or a few keywords, typed or filled from a saved theme). Studio searches Rally's own articles from the last 72 hours — widening to 7, then 14 days for a thin theme — and an AI pass suggests 5 per video, never the same story twice in a batch. You pick one per video. |
| **2 · Scripts** | this repo, `reel-batch.yml` mode `script` | Every story in parallel: web research → story outline → fact-check pass → captions → article photo → reel script + shot plan. Each draft goes back to Studio. When the last one lands, **Slack and Telegram get "N scripts ready" with the batch's Studio link**. |
| **Review** | Studio | Edit anything: the opening headline, every spoken line, every shot's image (searchable library picker), motion and transition, the music switch, both captions. **Confirm each script.** |
| **3 · Videos** | this repo, mode `produce` | Only once every script is confirmed: proofread (edited scripts only) → voice → cuts → music → MP4 + poster frame to R2, back to Studio. **Slack and Telegram get "N videos ready"** with the same link. The RSS feed (`feed.rss`) gets each finished story. |
| **Use** | Studio | Each video with copy buttons for the Facebook caption, Instagram caption and first-comment link; a **Used** toggle; a **Joyscroll** checkbox that puts it in the app's video feed. |

### How Studio and this repo talk

Studio dispatches `.github/workflows/reel-batch.yml` with only `mode`, `batch`
and (for a Retry) `item`. The workflow then **fetches its work from Studio**
(`src/studio.js` → `api/carousel.php`, authenticated with `CAROUSEL_API_KEY`)
and posts each result back the same way. So nothing typed in Studio — themes,
scripts, captions — is ever interpolated into a workflow or shell command, and
the key can do nothing but read the slots it was dispatched for and write their
results.

```
plan     node batch.js job <mode> <batch> [item]   → which slots to run
work     node batch.js <mode> <slot>                 one job per slot, in parallel (max 7)
finish   node batch.js finish <mode> <batch> <slots> → one ready message; RSS for produce
```

A slot that fails tells Studio why, and Studio shows it with a **Retry**
button; the other slots are unaffected. A slot whose job dies without reporting
(timeout, cancellation) is marked failed by the `finish` job, so nothing sits
"running" forever. Runs for the same batch queue rather than overlap.

### Tracked links

Every link the pipeline hands out carries UTM tags (`src/tracking.js`), so
Google Analytics on rally.news shows which platform and which reel a visit came
from — Reports → Acquisition → Traffic acquisition, by *Session source / medium*
and *Session manual ad content*:

| Link | utm_source | utm_medium | utm_campaign | utm_content |
| --- | --- | --- | --- | --- |
| Facebook first comment | `facebook` | `social` | `carousel` | `b<batch>-v<video>` |
| Instagram link in bio | `instagram` | `social` | `carousel` | `b<batch>-v<video>` |
| `feed.rss` `<link>` (Carousel) | `rss` | `rss` | `carousel` | `b<batch>-v<video>` |
| `feed.rss` `<link>` (talking-head run) | `rss` | `rss` | `daily-video` | – |

The story's own `?article=…&id=…` is untouched; the feed's `<guid>` stays the
clean URL. rally.news keeps the tags on the page for analytics and leaves them
out of its canonical URL, so search is unaffected.

### When a video fails

A slot that fails while its **script** is written shows a Retry. A video that
fails while being **made** shows two choices: *Retry as is*, or *Edit script* —
which puts that one script back in the editor, unconfirmed. Confirm it and
*Make 1 video* re-makes only that one; the videos already finished stay as they
are.

### The Studio link

Every message carries `https://rally.news/studio/promotion/carousel/?batch=N`.
It always opens the batch **as it is now**, at the step that needs a person —
so the "scripts ready" link and the "videos ready" link are the same URL, and
an old one never goes stale. Signing in from it lands back on the batch.

### The reel

Output is a **1080×1920 MP4**, 25–35 seconds, uploaded to
`rally-news-videos/reels/<date>/<slug>-b<batch>-<slot>.mp4` with a `.jpg`
poster frame beside it, so the back catalogue is browsable by date and two
videos of the same story never overwrite each other. (The carousel *slides*
this pipeline used to render are retired; the fact-checked story outline they
were written from is still produced, because the reel script and captions are
written from it.)

The five steps, once the story outline has been written and fact-checked:

1. **Script** (`src/reels/script-writer.js`) — Mistral rewrites the *same*
   fact-checked story arc as a 55–78 word spoken script (≈20–30s), casual and
   colloquial, closing on the same engagement question. It comes back split
   into 7–11 lines. It also writes a **hook**: a 3–7 word headline, not spoken,
   set large over the article's opening photo to stop the scroll. From line two
   on, **each line's spoken text is also its on-screen caption**, shown in Lora
   while the line plays — the words on screen are always exactly the words being
   said. The model is told to use **only** facts already in the carousel copy,
   so the reel inherits the fact-check instead of inventing around it.
2. **Cuts** (`src/reels/shot-planner.js`) — Mistral reads the script back and
   decides where the picture cuts, aiming for **15–25 shots** across the video.
   It picks keywords from a fixed **keyword bank** (`src/reels/keywords.js`),
   and is shown which of those words currently have a photo behind them, so
   cuts land on real subjects. Since there is exactly one photo per keyword, it
   is told to use each keyword at most once per video. Anything off-bank is
   discarded. Each shot carries a camera move (`push-in`,
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
   the `audio/` folder and looped to length. Voice and music are both
   loudness-normalised, then the bed is held **~7.5 dB under the narrator
   (about 40% quieter)** while she speaks — so a hot track and a quiet track
   land at the same place — rising to −3 dB over the Follow Us card.
   Ticking **No music — narration only** at the foot of the reel card in review
   skips the bed entirely and the reel runs dry (the Follow Us card then plays
   silent, since the bed is what carried it).
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
├── images/     ← ONE photo per keyword. THE FILENAME *IS* THE KEYWORD.
├── generic/    ← happy-planet stills, the fallback when nothing matches
├── audio/      ← Creative Commons music beds
├── outro/      ← the "Follow Us" Rally card, as an MP4
├── carousels/  ← written by the pipeline: carousels/<date>/<slug>/slide-N.png
└── reels/      ← written by the pipeline: reels/<date>/<slug>.mp4
```

**The folder names are only defaults.** If your assets are somewhere else —
under a `videos/` parent, or sitting loose at the bucket root — point the
`R2_REELS_*_PREFIX` variables at them instead of re-uploading (a prefix with or
without a leading/trailing slash is fine):

```
R2_REELS_IMAGE_PREFIX   = videos/
R2_REELS_AUDIO_PREFIX   = videos/audio/
```

And if the image folder is empty, the run doesn't just fail: the catalogue
scans the bucket, finds the folder that actually holds keyword-named photos,
uses it for that run and logs the variable that would pin it. Only folders left
at their default are substituted this way — a prefix you set by hand is
reported but never overridden — and the pipeline's own `carousels/` and
`reels/` output is ignored, so yesterday's reels can never be mistaken for
b-roll.

**`images/`** — `.jpg`, `.jpeg`, `.png` or `.webp`, all in the one folder,
**one photo per keyword**. The filename is the keyword and nothing else, taken
from the **keyword bank** in `src/reels/keywords.js` (212 words across 11
themes):

```
forest.jpg
volunteers.jpg
river.jpg
```

Words outside the bank are ignored, an image matching no bank word is logged as
unpickable, and two files claiming the same keyword are logged as a probable
mistake — so naming errors surface on the next run instead of silently costing
you a shot. Shoot for **at least 1080×1920**, or 1440px on the short side if
landscape; they're cover-cropped to 9:16, so keep the subject centred.

Because the library is one-to-one, a keyword can only be spent once per reel.
The planner is told this and asked to reach for a different keyword every shot,
but when it does repeat one, the picker walks a ladder rather than giving up:

1. the exact keyword's photo, if it hasn't been used yet
2. an unused photo from the **same bank group** — still on-theme
3. the generic pool
4. the exact photo again, or anything at all

Two consecutive shots are never the same photo at any rung. So a partial
library still produces a watchable reel; it just leans harder on `generic/`.

This ladder is for the **planner** — the model asking for a subject it can't
have. It is never applied to a choice made in review: an image picked in
Studio's script editor names one exact file, and that file plays. The only time a reviewed
shot goes back down the ladder is when its file is no longer in the bucket.

**`generic/`** — the fallback pool, and the thing that carries the reel while
the keyworded library is still filling up. Any filename; no keywords needed.
These should be pretty, uplifting, subject-agnostic frames that sit under any
sentence: landscapes, light through trees, hands, crowds, skies. **20–40** is
plenty.

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

The reel opens on the article's own featured image, with
a **`Photo: <outlet>`** credit in the bottom-right for the first ~2.4 seconds,
crediting the outlet that published it.
Everything after that comes from the library. If the article has no usable
photo, the reel opens on library footage instead and no credit is shown.

#### Check your assets before switching it on

```bash
npm run reel-assets         # what's in the bucket and what the builder sees
npm run voice-check         # which speech model/voice the key can actually use
npm run reel-check          # builds reel-check.mp4 from canned copy
npm run review-check        # Studio's editor and the builder agree (no network)
npm run batch-check         # the Studio half: drafts, messages, client (no network)
```

`reel-assets` reads the bucket and prints every folder in it, which folder each
pool resolves to (and the variable that pins it), how many of the 212 bank
keywords have a photo behind them, which uploads match no keyword, and whether
music and an outro are present. It's the fastest answer to *"why did the reel
say 0 images?"*. It writes nothing unless you ask it to:

```bash
npm run reel-assets -- --tidy           # show the moves into images/, generic/, audio/, outro/
npm run reel-assets -- --tidy --apply   # perform them
```

`--tidy` moves assets with server-side copies (no download, no egress) and
deletes the originals only after every copy has landed. `carousels/` and
`reels/` are never touched. After tidying, clear any `R2_REELS_*_PREFIX`
variables so the defaults apply again.

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

Cloudflare R2 (where the library lives and the reels go):

| Secret | Where to find it |
| --- | --- |
| `R2_ACCOUNT_ID` | Cloudflare dashboard → R2 → account ID |
| `R2_ACCESS_KEY_ID` | R2 → Manage API Tokens → create token |
| `R2_SECRET_ACCESS_KEY` | shown once when the token is created |
| `R2_BUCKET` | your bucket name |
| `R2_PUBLIC_URL` | the bucket's public URL or custom domain (no trailing slash) |

R2 is required for Carousel: the image library, music and outro live there,
and so do the finished reels Studio plays.

Studio (Carousel):

| Secret / variable | Purpose |
| --- | --- |
| `CAROUSEL_API_KEY` (secret) | Lets the workflow read its slots from Studio and post results back. The **same value** as `CAROUSEL_API_KEY` in rally-frontend's `api/config.php` on the server. Generate with `openssl rand -hex 32`. |
| `STUDIO_API_URL` (variable, optional) | Defaults to `https://rally.news/api/carousel.php`. |

On the Studio side (rally-frontend, on the server — never in either repo):
`CAROUSEL_API_KEY` in `api/config.php`; `CAROUSEL_OPENROUTER_KEY` (its own
OpenRouter key with a low credit limit, for step 1's story suggestions) in
`rally_admin_credentials.php` outside the webroot; and the existing
`RALLY_GITHUB_DISPATCH_TOKEN` there needs **Actions: Read and write** on this
repository added to it. Grant people the **Make reels in Carousel**
permission in Studio ▸ Admin ▸ Access.

Slack (optional — the ready messages go to Slack too when set):

| Secret | Where to find it |
| --- | --- |
| `SLACK_BOT_TOKEN` | a Slack app Bot User OAuth Token (`xoxb-…`) with the `chat:write` scope |
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

On OpenRouter the model slug and voice name are **not guessable** — voices are
namespaced per provider and don't transfer between them (OpenAI takes `coral`,
Voxtral takes `en_paul_happy`, Kokoro takes `af_bella`), and a mismatched pair
comes back as a bare `400`. So the reel asks OpenRouter what the key can
actually reach before it speaks:

```
GET /api/v1/models?output_modalities=speech   →   [{ id, supported_voices }]
```

and builds its candidate list from that, preferring Voxtral and a warm English
voice, remembering the first pair that answers for the rest of the run. Pin one
with `REELS_TTS_MODEL` / `REELS_VOICE` if you'd rather choose. To see the list
and hear the result:

```bash
npm run voice-check          # models, voices, the pair the reel would pick, one sample line
npm run voice-check -- --list   # list only, nothing synthesised
```

Reel tuning (repository **variables**, not secrets — all optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `R2_VIDEO_BUCKET` | `rally-news-videos` | the bucket holding reel assets and output |
| `R2_VIDEO_PUBLIC_URL` | falls back to `R2_PUBLIC_URL` | public base URL for reel links |
| `R2_REELS_IMAGE_PREFIX` | `images/` | keyworded b-roll — e.g. `videos/` if that's where you uploaded it |
| `R2_REELS_GENERIC_PREFIX` | `generic/` | the fallback pool |
| `R2_REELS_AUDIO_PREFIX` | `audio/` | music beds — e.g. `videos/audio/` |
| `R2_REELS_OUTRO_PREFIX` | `outro/` | the Follow Us card |
| `REELS_VOICE_PROVIDER` | (auto) | force `openrouter`, `azure`, `elevenlabs` or `openai` |
| `REELS_TTS_MODEL` | (auto) | pin an OpenRouter speech model slug instead of discovering one — `npm run voice-check` lists them |
| `REELS_VOICE` | per provider | voice name — must be one the model declares: `en_paul_happy` (Voxtral), `coral` (OpenAI), `en-GB-SoniaNeural` (Azure) |
| `REELS_VOICE_RATE` | `-4%` | speaking rate (Azure only) |
| `REELS_VOICE_STYLE` | `friendly` | Azure express-as style; set empty to disable |

### Run it

From Studio ▸ Promotion ▸ Carousel. The workflow can also be dispatched by
hand (GitHub → Actions → **Rally Studio Carousel (reel batch)**) with a batch
number Studio already holds — that is exactly what Studio's buttons do.

### Messages are plain text on purpose

Telegram messages are sent with **no `parse_mode`**: its legacy Markdown parser
rejects an entire message with HTTP 400 over one unbalanced emphasis character,
and the messages interpolate story headlines. The Studio link rides along as an
inline button. Slack gets the same text, escaped, plus a button block.

## Network resilience

A run gets one shot at the wire, so the calls it cannot continue
without are retried (`src/http.js`):

| Call | Behaviour |
| --- | --- |
| **RSS feed** (`src/story-fetcher.js`) | 4 attempts, ~2s → 5s → 11s backoff with jitter |
| **OpenRouter** (`src/openrouter.js`) | 3 attempts per model on *network* failures only; an HTTP error falls straight through to the next model in the chain, so no model is asked twice |

Only transient failures are retried — dropped connections, DNS blips, timeouts,
TLS handshake alerts (`EPROTO`, the class that once killed a run outright), and
`429`/`5xx`. A `400`, `401` or `404` will fail identically every time, so those
raise immediately instead of padding the run with pointless waiting.

## Cost per video (approx.)

| | Talking-head video | Carousel reel |
| --- | --- | --- |
| Story suggestions (Studio, per batch) | – | ~$0.001–0.005 |
| Text (Mistral) | ~$0.001 | ~$0.005–0.010 |
| Web research (write + fact-check) | – | ~$0.02–0.06 |
| Text-to-speech | – | ~$0.001–0.003 |
| Media | video model ~$0.20–0.50 | ffmpeg on Actions: $0 |
| Storage | – | R2 ~$0 (free tier) |
| **Total** | **~$0.20–0.50** | **~$0.03–0.08** |

Studio shows the upper estimate on the **Make videos** button.

The reel itself is **well under a cent**: the two Mistral calls (script
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

npm run reel-check                # just the reel, from canned copy
npm run review-check              # the editor/builder contract, stubbed library
npm run batch-check               # the Studio half, Studio stubbed — no credentials needed
node batch.js script <slot>       # one real slot — needs the secrets above and a Studio slot waiting
```

`review-check` holds the promise that matters most in review: every image in
the finished reel was on Studio's page, and an image picked there is the image
that plays. It asserts the builder side against a stubbed library — including
through `generateReel` itself. It needs no credentials, network, or ffmpeg.

Rendering uses puppeteer's bundled Chromium, which `npm install` fetches; in CI
it's picked up automatically.
