<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" alt="Gemma Wiki logo" width="96" height="96">
  </picture>
</p>

<h1 align="center">Gemma Wiki</h1>

<p align="center"><em>A Karpathy-pattern LLM wiki for Obsidian, powered by Gemma 4 running entirely inside Obsidian via LiteRT-LM + WebGPU.</em></p>

**Free, private, offline AI for your notes** — no API key, no subscription, no tokens ever billed, no account to make.

Gemma 4 E4B runs inside Obsidian's own process via [LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM) and WebGPU. Not Ollama, not LM Studio, not a localhost server — the model is *in* the app. **Your notes are never uploaded anywhere, because there is no server to upload them to**: privacy here is a property of the architecture, not a promise in a policy. After the one-time ~3 GB model download, the plugin never touches the network again.

It implements **[Andrej Karpathy's LLM-wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)**: your raw notes are never modified. A separate, cross-linked wiki layer is built above them — one page per note, and **every page is shown to you in full before a single byte is written**.

From there: chat grounded in one note or in the whole wiki, quiz yourself on either, build concept pages across everything sharing a tag, and let it flag its own decay with lint, provenance and contradiction checks. **Sources are listed by the plugin, never cited by the model** — citation is the one thing a small local model would get wrong without anyone noticing.

Everything it writes is plain markdown in your vault — nothing is locked in a database, and nothing needs another plugin to read it back. Its own configuration is notes too: **your tag vocabulary and naming rules live in `schema.md`**, where you can edit them by hand and the plugin will obey; **every operation is appended to `log.md`**, so you can always see what it did and when; and **dropping a markdown file into `skills/` adds a command of your own** to the ⚡ menu.

> **Status: working MVP.** The core loop of [Andrej Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) is implemented and running: review-gated ingest into a `gemma-wiki/` layer with cross-links, an `gemma-wiki/index.md` catalog and append-only `gemma-wiki/log.md`, index-first grounded chat with deterministic source attribution, save-answer-back-to-wiki, a model-free lint report, and canned single-task skills. Not yet in the community plugin store; benchmarks below are from real use.

## ✨ Features at a glance

**The Karpathy loop** — raw notes stay read-only; the plugin maintains a separate `gemma-wiki/` layer:

- **Ingest** — one strict JSON extraction per note (summary, 3 tags, 3-5 key points, a self-rated confidence written to frontmatter), plus a validated multiple-choice pick of up to 3 related pages from the index catalog. Everything previews in a review modal; nothing is written without approval. Ingested notes get a small badge in the file explorer — pure UI decoration, the note file is untouched.
- **index.md / log.md** — a one-line-per-page catalog the query path reads first, and an append-only, grep-friendly activity log.
- **Query (Wiki mode)** — index-first retrieval with stopword filtering; the catalog and recent log always ride along, so meta-questions ("what did I add today?") work; answers are grounded only in retrieved material with honest refusals otherwise.
- **Save answers back** — every reply has a save-to-wiki action (same review gate), so explorations compound instead of vanishing with the chat.
- **Relink** — backfills Related cross-links on older pages through one aggregated review modal.
- **Lint v1** — model-free report of orphan pages, dead index entries, and unindexed pages.

**Chat panel** — shadcn-inspired monochrome, theme-variable driven:

- **Two grounding modes**: *This note* (the open file) and *Wiki* (your ingested pages).
- **Deterministic Sources row** on every answer — the plugin lists exactly what was used, clickable; citation is never left to the model.
- **`+` attachments** — fuzzy-pick any notes as removable context pills, in either mode.
- **⚡ Skills** — canned single-task prompts: quiz, flashcards, gap-finding, recent-activity digest (auto-switches to Wiki mode).
- **✨ Improve formatting** — the one write action on raw notes, and the most constrained call in the plugin: structure/formatting/typos only, wording and voice preserved, full-result preview before anything is written. Long notes are split on headings and blank lines into passes that each fit the model's 4096-token context, rewritten one pass at a time and stitched back together; a selection still narrows it to one section.
- Streaming replies with a typing spinner, stop button, copy/regenerate actions, persistent starter chips, auto-growing + expandable input, clear-chat, hover tooltips everywhere.

**Engineering rules the whole plugin follows**:

- Every model operation is **one structured ask** — no tool loops, no multi-step planning; small local models are unreliable at chaining and reliable at filling one schema.
- Every write goes through a **preview-approve gate**. Raw notes are modified by exactly one feature (Improve), always previewed.
- Grounded-or-refuse: the model answers from provided material or says it can't — in both modes.

## 💬 Chat with your notes — entirely offline

Click the message-circle ribbon icon to open the side panel. Two grounding modes, switched with a pill toggle:

- **This note** — answers strictly from the currently open note.
- **Wiki** — the Karpathy Query path: reads the `gemma-wiki/index.md` catalog first, loads the top-matching ingested pages, and answers only from them (plus the catalog and recent activity log, so meta-questions like "what did I add today?" work too).

Either way: answers stream in from a model running inside Obsidian's own process, every answer ends with a deterministic **Sources** row (clickable — listed by the plugin, not left to the model to cite), honest refusals when the material doesn't contain the answer, and per-message **copy / regenerate / save-to-wiki** actions. A **+** button attaches additional notes as removable context pills; a **⚡ skills** menu runs canned single-task prompts (quiz, flashcards, gap-finding, recent-activity digest) against the current grounding.

## 📑 Contents

- [🧠 Gemma 4 LiteRT Wiki for Obsidian](#-gemma-4-litert-wiki-for-obsidian)
  - [� Chat with your notes — entirely offline](#-chat-with-your-notes--entirely-offline)
  - [📑 Contents](#-contents)
  - [🤔 Why this exists](#-why-this-exists)
  - [🔌 How this differs from Ollama / LM Studio plugins](#-how-this-differs-from-ollama--lm-studio-plugins)
  - [📋 Requirements](#-requirements)
  - [⌨️ Current commands](#️-current-commands)
  - [🔧 How it works](#-how-it-works)
  - [📊 Benchmarks](#-benchmarks)
  - [🗺️ Roadmap](#️-roadmap)
  - [🔒 Privacy](#-privacy)
  - [💖 Credits](#-credits)

## 🤔 Why this exists

Most "local AI" Obsidian plugins still depend on a second, independently-running application — Ollama or LM Studio has to be installed and running in the background before the plugin does anything. That's local in the sense that your notes don't leave your machine, but it isn't local in the sense of "install the plugin and it just works."

This project asks a narrower question: **can the model run in the exact same process as the plugin, using only what Electron and WebGPU already provide?** The answer, validated end to end (see [Benchmarks](#-benchmarks)), is yes — for short, well-scoped text tasks. Whether it's enough to carry a full Karpathy-style wiki (entity/concept extraction, cross-referencing, contradiction detection) is the open question this project is working through, one validated step at a time, in public commit history.

## 🔌 How this differs from Ollama / LM Studio plugins

|  | This project | Ollama/LM Studio-backed plugins |
|---|---|---|
| **External process** | None. The model runs inside Obsidian's own renderer. | Requires Ollama/LM Studio installed and running separately. |
| **Setup** | Install the plugin; first run downloads the model once. | Install the plugin *and* a separate app; configure a connection between them. |
| **API surface** | No local HTTP server, no port to configure. | Talks to `localhost:11434` (or similar) over HTTP. |
| **Trade-off** | Ties the plugin to whatever LiteRT-LM supports today. | More provider flexibility, but a heavier setup and a permanently-running background app. |

This isn't a claim that local-in-renderer is strictly *better* — it's a different point in the design space, and "fully local" only matters if the output quality holds up. That's exactly what the benchmarks below are trying to establish honestly, including where the approach is weaker.

## 📋 Requirements

- Obsidian 1.11.4+, **desktop only** (macOS / Windows / Linux — no mobile; this plugin is not published in `isDesktopOnly: false` form)
- A WebGPU-capable GPU and browser runtime (Obsidian's bundled Electron/Chromium)
- ~3 GB free disk space for the [`litert-community/gemma-4-E4B-it-litert-lm`](https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm) model, downloaded once and cached via the browser Cache API
- Network access for the one-time model download only — no network calls after that

> **If you sync this vault, exclude the model file.** It is downloaded to
> `<vault>/.obsidian/plugins/gemma4-litert-wiki/gemma-4-E4B-it-web.litertlm` — Obsidian gives a
> plugin nowhere outside the vault to write — so iCloud, Dropbox, and Obsidian Sync with
> "community plugins" enabled will all replicate ~3 GB to every machine. Each machine can download
> it once for itself in a fraction of that time. The wiki folder itself is ordinary markdown and
> should sync normally.
>
> Note that `data.json` (which holds your knowledge-folder name) often does *not* sync. If you
> rename the folder on one machine, the other will not know — it now notices a folder that looks
> like a wiki and asks before creating a second one, but the cleanest fix is to rename it the same
> way on both.

## ⌨️ Current commands

| Command | What it does |
|---|---|
| **Chat with active note (local Gemma)** | Opens the chat panel — This-note / Wiki modes, attachments, skills, save-to-wiki. See [above](#-chat-with-your-notes--entirely-offline). |
| **Ingest active note into wiki (local Gemma)** | One strict JSON extraction (summary, 3 tags, 3-5 key points, confidence) plus a related-pages pick from the index — previewed in a review modal, written only on approval. Raw notes are never modified; ingested notes get a small badge in the file explorer. |
| **Relink wiki pages (fill missing Related sections)** | Backfills cross-links on pages ingested before related-links existed, through one aggregated review modal. |
| **Lint wiki (orphans and index health)** | Model-free report: orphan pages, index entries pointing at missing files, pages missing from the index. |
| **LiteRT spike: check WebGPU** | Debug: confirms a usable WebGPU adapter is available. |
| **LiteRT spike: load WASM runtime (no model download)** | Loads the LiteRT-LM WASM runtime without downloading the model — isolates runtime issues from model issues. |
| **LiteRT spike: download Gemma 4 E4B model (one-time, ~3GB)** | Downloads and caches the model; shows live progress. |
| **LiteRT spike: fix grammar of selection** | Runs a real generation on the selected text and replaces it with a grammar-corrected version, logging prefill/decode speed and time-to-first-token to the console. |
| **LiteRT spike: JSON reliability test (5 runs)** | Runs 5 independent structured-JSON-output generations against the selection and reports a pass rate — this is the risk test for whether the model can reliably drive an ingest pipeline. |

## 🔧 How it works

Getting a local model to run inside Obsidian's renderer — instead of a Chrome extension's offscreen document, which is where every existing LiteRT-LM web example runs — surfaced two Electron-specific problems that don't show up in a normal browser tab:

1. **`file://` script tags are blocked.** LiteRT-LM's WASM loader injects a `<script src="...">` tag to load its Emscripten glue code. Obsidian's own page isn't served from a `file://` origin, and Electron's local-resource guard refuses to load a `file://` script from a non-`file://` page. **Fix:** serve the `wasm/` directory over a `127.0.0.1` loopback HTTP server started from the plugin itself, with permissive CORS headers.

2. **The WASM glue misdetects its own script directory.** `litertlm_wasm_internal.js` checks `typeof __filename` to decide whether it's running under Node.js. Obsidian's desktop app is a Node-integrated Electron renderer, so `__filename` *is* defined — but it points at Obsidian's own internal file, not the dynamically-injected WASM script. This hijacks the correct `document.currentScript`-based path resolution, and the model binary fetch silently falls back to resolving against Obsidian's own page origin instead of the plugin's server. **Fix:** pre-seed `self.Module.locateFile` before calling `loadLiteRtLm()` — the loader checks for this override before running its own (broken, in this environment) auto-detection.

Once loaded, the plugin keeps a single `Engine` instance alive for the lifetime of the Obsidian session (see `ensureEngine()` in `src/main.ts`) so the ~3 GB model and GPU warmup cost are paid once, not per command.

## 📊 Benchmarks

All numbers are from `Conversation.getBenchmarkInfo()` — real LiteRT-LM instrumentation, not estimates — measured on real hardware, not vendor-quoted figures.

| Scenario | Prefill | Decode | Time to first token |
|---|---|---|---|
| Cold engine, 2098-token input | 74.7 tok/s | 29.1 tok/s | **28.1 s** |
| Warm engine, 1558-token input | 495.0 tok/s | 28.9 tok/s | 3.2 s |
| Warm engine, 274-token input | 386.5 tok/s | 29.5 tok/s | **0.74 s** |
| Warm engine, 634-token input (full paragraph) | 494.7 tok/s | 29.1 tok/s | 1.3 s |

**Takeaway:** the ~28 s cold-start figure that shows up on the very first call is a one-time GPU shader-compilation / weight-conversion cost, not a per-call tax — once the engine is warm, prefill throughput jumps roughly 5-6×, and short-selection latency drops to sub-second. Decode speed (~29 tok/s) is stable regardless of input length or warm/cold state.

**Quality**, checked by hand against six English test passages (basic typos, subtle grammar, a passage with zero errors, a bulleted list, technical jargon that should *not* be "corrected", and a 700-word article with errors scattered through the final paragraph): zero missed errors, zero hallucinated changes, exact-match output on the already-correct passage, all technical terms and list formatting preserved, and no quality drop-off between the first and last paragraph of the long passage.

**Structured output reliability**: 5/5 independent runs produced valid, correctly-shaped JSON (`{"summary": string, "tags": string[3]}`) with greedy sampling — the load-bearing assumption behind an eventual ingest pipeline.

## 🗺️ Roadmap

Implemented — the Karpathy core loop, scoped deliberately to what a small on-device model has been validated to carry:

- **Ingest** with a review gate (nothing written without approval), single-schema extraction, related-page cross-links picked from the index catalog, and a confidence rating in page frontmatter.
- **Query** via index-first retrieval with stopword filtering, catalog + activity log always in context, deterministic source attribution, and save-answer-back-to-wiki so explorations compound.
- **Lint v1**, model-free: orphans and index health.

Next: user-defined skills (custom prompt templates), model-assisted contradiction candidates in lint (flag pairs for human judgment, never auto-fix), an ingest pre-filter gate (content-hash dedup), and a low-confidence/stale review board.

Deliberately out of scope: a multi-provider abstraction layer, image input (the LiteRT-LM web runtime does not support it yet), PDF OCR, and any retrieval scheme more complex than "read the index, then read the pages it points to" — field reports put the flat-index breaking point around ~77 pages, far above this wiki's current size; that decision gets revisited there, not before.

## 🔒 Privacy

No backend, no telemetry, no analytics. The only network request this plugin ever makes is the one-time model download from Hugging Face. Everything else — inference, caching, generation — happens entirely on-device, inside Obsidian's own process.

## 💖 Credits

- [Andrej Karpathy — LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) for the three-layer (raw / wiki / schema) pattern this project is working toward.
- [litert-community](https://huggingface.co/litert-community) for the web-packaged Gemma 4 E4B checkpoint this plugin loads.
