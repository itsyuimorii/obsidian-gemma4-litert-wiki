# Changelog

All notable changes to this plugin are recorded here. Versions follow
[semantic versioning](https://semver.org/); the store reads them from
`manifest.json` and `versions.json`.

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
