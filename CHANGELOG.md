# Changelog

All notable changes to this plugin are recorded here. Versions follow
[semantic versioning](https://semver.org/); the store reads them from
`manifest.json` and `versions.json`.

## 1.0.4 — 2026-09-05

### Fixed

- The clickable paths in the settings folder map are underlined with a border
  instead of `text-decoration-color` + `text-underline-offset`, which Obsidian
  only partially supports at the 1.11.4 floor this plugin declares. On an older
  Electron the rule degraded to a full-colour underline at the default offset,
  and the hover state had nothing left to change.

### Docs

- The README makes its case once. The opening pitch, two full-width images and
  then a second longer telling of the same pitch had pushed the table of
  contents below the fold; every claim in the repeated paragraphs is made with
  more detail in the section directly beneath them. The three-layer diagram
  moved down to where the three layers are explained.
- Every mention that makes a claim about the model now says **Gemma 4 E4B** —
  the variant that actually ships — rather than "Gemma 4", the family. The
  plugin's registered name is unchanged.
- The status note was still announcing 1.0.0.

## 1.0.3 — 2026-09-05

Everything the community directory's automated review found, fixed or answered.

### The two errors that were ours

- The description no longer says "Obsidian" — the directory rejects the word
  as redundant, and now our own release check does too.
- The chat input's auto-grow sets its height through `setCssStyles` instead of
  assigning `el.style` directly.

### The error that is not ours, explained where reviewers read

The one dynamic `<script>` creation lives in `@litertjs/wasm-utils` — it is
how LiteRT-LM loads its Emscripten glue outside a worker, and it loads a file
from your own disk over the plugin's loopback server, never from the network.
The Privacy section now documents exactly this, with the allowlist and the
build-time version pin.

### Build verification

- `npm run build` now produces the byte-identical `main.js` the release
  carries: the build stamp defaults to the manifest version instead of the
  wall clock, which is what made the store's rebuild-and-diff check fail for a
  reason unrelated to the code.
- Release assets carry GitHub artifact attestations
  (`gh attestation verify main.js -R itsyuimorii/obsidian-gemma4-litert-wiki`).

### Cleanups from the same report

- A stray merge-conflict marker line in `styles.css` — shipped in 1.0.2,
  harmless to rendering, embarrassing anyway. Gone, along with duplicate
  properties and the one `!important`.
- `window.setTimeout`/`clearTimeout` for popout-window compatibility;
  `createDiv` where `createEl('div')` was; `messageEl` for the deprecated
  `noticeEl`; `revealLeaf` awaited; deprecated `setDynamicTooltip` dropped;
  every unused import removed and `noUnusedLocals` turned on so the next one
  cannot land.

### Left as-is, with reasons in the code

`fetch` stays for the model and runtime downloads — `requestUrl` buffers the
whole body, and one of these bodies is ~3 GB; streaming is what makes the
progress bar, the resume-from-byte-offset, and the stall timeout possible. The
control-character class in `safeFileName` is deliberate filename hygiene.

## 1.0.2 — 2026-09-05

- **Plugin ID is now `gemma-litert-wiki`** (was `gemma4-litert-wiki`). The
  community directory allows only lowercase letters and hyphens in an ID — no
  digits — and rejected the submission. If you installed manually under the
  old folder name, rename the folder to `gemma-litert-wiki`; your settings
  travel with it, since Obsidian keys them to the folder.
- The chat panel's view type follows the ID, so the panel re-docks once on
  first launch after this update.

## 1.0.1 — 2026-09-05

The chat panel becomes a conversation, keeps its thread, and can save it.

### Chat

- **Follow-ups work.** Prior turns now enter the model's context, so "why?"
  after an answer means why. History is scoped to what the current answer is
  grounded in — switch note or mode and the other thread's context never
  leaks — and it yields budget to the retrieved material rather than
  overflowing small context windows.
- **A closed panel keeps the thread.** The last conversation survives closing
  the tab, restarting Obsidian, and plugin updates, restored with its Sources
  rows and actions intact. If it was about a different note than the one now
  open, a line says so instead of silently re-grounding. Clear chat clears the
  saved copy too.
- **Save the whole conversation** — the 💾 button beside the bin returns.
  Threads land in `gemma-wiki/chats/`, one file each, named after the first
  question, with per-answer Sources. The folder has its own `index.md` listing
  every saved thread, newest first. **Nothing in `chats/` is ever retrieved,
  indexed, linted, or scanned** — a chat in the wiki index would be
  indistinguishable from a page, and answers are output, never input.

### Fixed

- Every "approve and write" path now reports failure; eleven of thirteen were
  silent, so deleting a note while its preview was open and then approving
  produced no error and no write — which read as success.
- Improve no longer overwrites edits made while it was running: it compares
  against its snapshot and refuses, saying your edit is intact. For a
  selection the check is positional, so typing above it can no longer shift
  the rewrite onto the wrong lines.
- The engine is released when the plugin unloads, so disabling or updating no
  longer keeps gigabytes of model resident until Obsidian restarts.
- The runtime download can no longer hang forever on a silent connection: a
  stall timer, re-armed by each arriving chunk, aborts with a message instead
  of leaving the plugin busy until restart.
- A renamed wiki folder now gets folder documentation naming the new folder;
  it was frozen at the default.

### Docs

- The README opens with a features table and a **What to run when** routine;
  after a scan that coined new tags, the completion notice now names Tidy as
  the next step.
- The demo deck gains an Improve scene — the one command that rewrites a note
  you wrote had no demo — and covers `chats/`.

## 1.0.0 — 2026-09-04

First public release. [Andrej Karpathy's LLM-wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f),
run by Gemma 4 E4B inside Obsidian's own process via LiteRT-LM and WebGPU — no
Ollama, no LM Studio, no API key, no account.

### The wiki layer

- **Ingest** a note into a `gemma-wiki/` card: one strict JSON extraction
  (summary, tags, key points, salient mentions, self-rated confidence) plus a
  validated pick of related pages from the index. Nothing is written without
  approval — every page is rendered in full in a review modal first.
- **Scan** whole folders for new or changed notes and review the drafts in one
  list, lowest confidence first. Opt-in by scope: with no folders named, it
  refuses to run rather than sweeping the vault.
- **`index.md` and `log.md`** — a one-line-per-page catalog that the query path
  reads before anything else, and an append-only, grep-friendly activity log.
- **Concept pages** built across every card sharing a tag or a mention, linking
  down into each; ingest ripples into them and member lists self-heal.

### Chat

- **Two modes**: grounded in the open note, or in the whole wiki via index-first
  retrieval. Sources are listed by the plugin, never cited by the model.
- Both modes separate a question of fact about your material (answered only from
  it, refused honestly otherwise) from a request to explain a term the material
  uses (explained, keeping what your notes say apart from what the term means).
- **⚡ skills** — Quiz, Flashcards and Find gaps ship built in; any markdown file
  dropped in `gemma-wiki/skills/` adds one of your own.
- Answers can be saved into your own notes, with the model and sources recorded
  in frontmatter.

### Keeping it honest

- **Saved answers are never retrieved.** Everything the wiki retrieves derives
  from a note you wrote — enforced structurally, not by convention: only
  `cards/` and `concepts/` are in the retrieval set.
- **Review board** for the three ways a page goes bad: low confidence, source
  drift caught by `source_hash`, and staleness.
- **Provenance spot-check** traces each key point back to a sentence in the raw
  note and flags what cannot be traced.
- **Contradiction sweep** flags pages that disagree, with the reason quoted, and
  never edits.
- **Tidy the wiki** — a model-free check (orphans, dead index entries, unindexed
  pages, tag drift) followed by four repairs you tick individually, each behind
  its own preview.

### Your notes

- **Improve formatting** rewrites long notes in passes, preserving wording and
  voice; fenced code blocks are never reflowed.
- **Suggest tags & links** proposes frontmatter tags and wiki links. These two
  are the only features that touch a raw note, and both always preview.

### Configuration as notes

`schema.md` holds your tag vocabulary, naming rules and a rejected list that
outranks the model. Everything the plugin writes is plain markdown in your
vault — no database, no other plugin needed to read it back.

### Privacy

Two one-time downloads, both cached on disk: the model from `huggingface.co`
and the LiteRT-LM WebAssembly runtime from `cdn.jsdelivr.net`, pinned at build
time to the version this bundle was compiled against. Nothing else leaves the
machine — no telemetry, no analytics, no server.
