# Save answers into your notes

**Status:** design, approved in chat, not yet implemented
**Date:** 2026-09-01

## The problem

`answers/` and `chats/` are folders the plugin writes into and then never reads.
Verified against every path that could read them:

| Mechanism | Reads `answers/` or `chats/`? | Why not |
|---|---|---|
| Retrieval (`loadPages`) | No | `pageDirs()` is `[cards/, concepts/]` |
| `index.md` | No | the save path deliberately skips `upsertIndexEntry` |
| Review board | No | `buildReviewBoard` filters by `isWikiPage` |
| Lint | No | same filter |
| Drift (`read_hashes`) | No | written by `buildAnswerPage`, read only inside the `isWikiPage` filter that excludes it |
| `Turn this answer into a note` | Gone | removed in `00e74b4` |

So two frontmatter fields are decoration. `derived: true` is read at exactly one
line — `wiki-store.ts:1205`, inside a branch that cannot be reached, because no
answer ever gets an index entry to be iterated over. `read_hashes` is written on
every save and read by a block in `review-board.ts` that its own file filter
guarantees will never see it.

Two further consequences follow from the *location* rather than from the
bookkeeping:

1. **A saved answer can never become material.** `auto-ingest.ts:80` is
   `if (f.path.startsWith(wikiPrefix)) continue;` — scanning skips the whole of
   `gemma-wiki/`. A file in `answers/` is one the ingest pipeline is hard-coded
   to walk past, so the only route by which anything becomes retrievable is
   closed to it by construction.

2. **A saved answer dies with the folder.** The plugin tells you `gemma-wiki/`
   is safe to delete and rebuilds itself, which is true of cards and concept
   pages and false of your saved answers. They are the one irreplaceable thing
   inside a directory labelled disposable.

And the complaint that started this: with any volume, `answers/` is a flat pile
of slugified question filenames, in a folder you have no reason to open.

## The decision

Keep the save button. Change where it writes.

```
today   [Save to wiki]   ->  gemma-wiki/answers/<slug>.md
after   [Save as note]   ->  <the source note's folder>/<question>.md
```

One button, one press, the same preview gate. Only the destination moves.

The label changes with it: "to wiki" is the misleading half, since the wiki is
the one thing that never read the file.

### Why this is not the command that was just deleted

`Turn this answer into a note` was a *second* command, run later, against an
already-saved file, with a folder picker, a note format and three callouts of
documentation — machinery added to move a file the plugin had just put in the
wrong place. This removes the wrong place. It is one step where there were two,
it has no picker, and its net effect on the codebase is subtraction.

The tension worth stating plainly: `00e74b4` argued that writing it yourself is
the point. This design does not write prose for you — it files, and records the
provenance a copy-paste loses silently. Whether that crosses the line is a
judgement the author has made in favour of filing.

## Where a saved answer goes

| Mode | Destination |
|---|---|
| **This note** | the folder of the open note |
| **Wiki** | the folder of the note behind the first source |
| neither resolves | the folder of the open note, then the vault root |

Resolvable because every card carries `source:` in its frontmatter pointing at
the user's note (`wiki-store.ts:1321` already relies on this). Given a Sources
entry — a card path — read its `source:`, take the parent folder.

One new setting pins everything to a fixed folder instead:

```ts
// settings.ts — GemmaWikiSettings
/** Where "Save as note" writes. Blank = beside the note the answer came from. */
answerFolder: string;   // default ''
```

Blank is the default because the complaint being fixed is "I do not know where
things went"; beside the source is the answer a person would give if asked
where it should be. The setting exists for people who would rather have one
pile they chose than several they did not.

## What the file looks like

```markdown
---
written_by: gemma-4-E4B-it-web
created: 2026-09-01
sources:
  - "[[litert on device]]"
  - "[[webmcp notes]]"
---

# what keeps coming up across all of these?

Three threads run through all four pages…

## Sources

- [[litert on device]]
- [[webmcp notes]]
```

- `written_by` and `sources` are the two facts a copy-paste destroys. They are
  the whole reason a button beats Cmd+C.
- `tags:` is **not** written. Adding tags to a file in the user's own vault is
  presumptuous; when the note is later ingested, its card gets tags, which is
  where model-chosen tags belong.
- `read_hashes` and `derived` are gone. Both were only ever read by code that
  cannot see this folder, and after this change the file is not the plugin's to
  track at all.
- `sources` links point at the **cards**, matching what the Sources row shows.

### Filenames

Card paths and tags keep `slugify()`. This file does not: it lands among the
user's own notes, where filenames are human text, so it uses the question with
only filesystem-illegal characters removed.

```ts
/** A note filename from arbitrary text. Unlike slugify(), this keeps the words:
 *  the file lands in the user's own vault, where `2026 roadmap.md` is normal and
 *  `2026-roadmap.md` is the plugin imposing a house style on someone's folder. */
export function safeFileName(text: string, fallback: string): string
```

Strips `/ \ : * ? " < > | # ^ [ ]`, control characters and leading dots;
collapses whitespace; trims; caps length; falls back to a timestamp when
nothing survives. Appends ` 2`, ` 3` … on collision rather than overwriting —
this folder is the user's, and silently replacing a file in it is not a thing
the plugin may do.

The name itself is `gemma — <what it did> — <what it was about>`:

| Part | Rule |
|---|---|
| `gemma —` | Always. The one marker visible in the file explorer, which shows no frontmatter and truncates around thirty characters — so a suffix or a property is invisible exactly when you are scanning a folder to tell your own writing from the model's. `gemma` rather than `AI` because it names which model; the build is in `written_by`. |
| what it did | The chip or skill label (*Summarize*, *Flashcards*), or the typed question, capped at 60 characters. |
| what it was about | The source title — **only when there is exactly one source.** In Wiki mode an answer can read four cards, and naming it after the first claims it is about one note when it is about the set. |

Action before topic, and the order carries weight. Several answers about one
note are told apart by what was asked, not by the topic they share, so at the
sidebar's width action-first stays legible where topic-first does not:

```
gemma — Summarize — The perfe…      gemma — The perfect espress…
gemma — Summarize — Brewing t…      gemma — The perfect espress…
        distinguishable                     identical
```

This is also what fixes the case that prompted the rule: a chip's `ask` is
"Summarize this note", which names no note, so two saves in one folder gave
`Summarize this note` and `Summarize this note 2`. The chip's short `label`
already existed on `SuggestionSpec` and was simply never passed down —
`runSuggestion` sent `text` alone while skills sent `skillLabel`. Both now send
`promptLabel`, since a chip is not a skill and the parameter should not claim it
is.

The H1 inside the note carries the title without the `gemma —` prefix:
`written_by` sits two lines above it and says the same thing better.

## What is removed

| Removed | Where |
|---|---|
| `answers/`, `chats/` from the scaffold | `wiki-store.ts:312-313`, `:630` |
| both folder READMEs | `wiki-store.ts:569`, `:591` |
| `answerPagePath`, `chatTranscriptPath` | `wiki-store.ts:1261`, `:1412` |
| `buildChatTranscript` | `wiki-store.ts:1418` |
| `saveConversation` + the header floppy button | `chat-view.ts:394`, `:498` |
| the `derived` option on `buildAnswerPage` | `wiki-store.ts` |
| the `answers` branch and `answersPrefix` in `loadPages` | `wiki-store.ts:1199` |
| the "trust the page" heading block | `chat-view.ts:981` |
| the `read_hashes` block in the review board | `review-board.ts:67-85` |

`ChatTurnRecord` (`wiki-store.ts:1406`) **stays** — the in-memory `turns` array
still uses it. Only the transcript builder goes.

Scaffold goes from 9 entries to 7. `loadPages` returns a string rather than
`{ pages, answers }`, since the second half is now always empty.

Skill outputs (Quiz, Flashcards, Find gaps) take the same path as any other
answer — no special case, which is what lets `derived` go.

## Prerequisite: this is blocking

`slugify()` (`wiki-store.ts:79`) is `replace(/[^a-z0-9]+/g, '-')`. Twelve of
twenty-one language samples collapse entirely to `untitled` — every non-Latin
script. Separately, `wikiPagePath()` (`wiki-store.ts:88`) keys card paths on
`file.basename`, so two notes with the same filename in different folders
overwrite each other's card and then re-draft each other forever.

Both must land **before or with** this change, not after.

The reason is specific to this design rather than general: today a filename
collision clobbers a file inside `gemma-wiki/`, a folder the plugin owns and
tells you is disposable. After this change the same collision clobbers a file
**in the user's own notes folder**. Same bug, different blast radius.

Sequencing therefore is:

1. Unicode-aware `slugify` (`\p{L}\p{N}`, filesystem-illegal characters only).
2. Card paths keyed on the note's full path, not its basename; batch scan
   deduplicates by target path and reports a collision instead of silently
   keeping the last write.
3. This design.

Steps 1 and 2 stand on their own and are worth shipping independently — they are
not caused by this change and they affect every non-English user today.

## Existing vaults

Files already in `answers/` and `chats/` are **not moved**. The plugin does not
touch files in the user's vault that it did not just write, and a migration that
relocates a hundred files on upgrade is exactly the kind of help nobody asked
for.

On the first load after upgrade, if either folder exists and is non-empty, one
notice: these two folders are no longer written to; anything worth keeping can
be moved wherever you keep notes, and anything moved out becomes ingestable.
Empty folders are left alone too — deleting a directory in someone's vault to
tidy up our own scaffold is not proportionate.

New vaults simply never get the two folders.

## Edge cases

| Case | Behaviour |
|---|---|
| Ungrounded answer (the escape hatch) | Save stays unavailable, as today. A model guess must not become a note that can later be ingested as material. |
| Answer with no sources | falls through to the open note's folder, then the vault root |
| The source card's note has been deleted | fall through as above; the answer still records the `sources` links |
| Target filename exists | ` 2`, ` 3` … appended; never overwritten |
| `answerFolder` set to a folder that does not exist | created, the same as any wiki write |
| Saved note is later ingested | becomes an ordinary card. The loop card → answer → note → card is bounded by a human pressing two buttons. |

## Testing

- `safeFileName` across the twelve scripts that break `slugify` today, plus
  filesystem-illegal characters, plus a string with nothing left after
  stripping.
- Destination resolution: This-note mode, Wiki mode with a resolvable first
  source, Wiki mode with a deleted source note, no sources, `answerFolder` set.
- Collision: save the same question twice, assert two files.
- Assert `gemma-wiki/` contains nothing after a save — the point of the change,
  and the assertion that fails loudly if a destination regression creeps back.
- Assert a saved note appears in `findIngestCandidates` output, which is the
  claim that the front door is actually open.

## Out of scope

- **Conversation persistence.** Turns are in-memory and a closed panel loses
  them (`chat-view.ts:178`, `onClose` saves nothing). Worth building, and it is
  what made option B viable, but it is not required by this design and should
  not be smuggled into it.
- Any change to what is retrieved. Cards and concept pages remain the only
  material, and the rule this serves is unchanged: nothing the wiki retrieves
  comes from anywhere but a note in the user's own vault.

## Follow-on

The demo deck's scene 12 (save the answer) and scene 13 (trust layers) describe
the design as it stood two revisions ago — answers retrieved second under a
"trust the page" heading. Both need rebuilding once this lands, and not before,
so it is done once.
