# Changelog

All notable changes to this plugin are recorded here. Versions follow
[semantic versioning](https://semver.org/); the store reads them from
`manifest.json` and `versions.json`.

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
