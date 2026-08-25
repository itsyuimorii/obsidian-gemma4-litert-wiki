# Tag vocabulary reuse test (#38 / #37)

Verifies that ingest **reuses existing tags** instead of inventing a fresh
synonym every time, in both tiers:

1. **No vocabulary yet** — ingest prefers the tags already in use on the wiki
   (frequency-ranked fallback).
2. **Vocabulary exists** — after "Clean up tags" writes `schema.md`, ingest
   prefers those exact tags.

Manual test — the model only runs inside Obsidian, so this can't run in CI.
The four fixtures below deliberately overlap (all about LLM evaluation), so a
working build makes the same concept collapse onto **one** tag across pages
(`llm-evaluation`, not `llm-eval` on one page and `evals` on the next).

## How to run

Use a scratch wiki folder if you don't want to touch your real one (Settings →
Knowledge folder name → e.g. `gemma-wiki-test`), then:

1. Reload the plugin so the latest build is active.
2. Paste each fixture into its own **new throwaway note**.
3. **Tier 2 (fallback, no schema yet):** ingest **A**, then **B**, then **C**
   (`Ingest active note into wiki` on each; approve the preview). Watch the
   tags on the drafted cards.
   - Pass: by **C**, tags reuse spellings already chosen for **A**/**B** — the
     shared concept keeps one tag, not a new synonym each time.
4. **Build the vocabulary:** run **Clean up tags** (Settings → Schema →
   *Clean up tags*, or the command palette). Approve the preview. Open
   `gemma-wiki-test/schema.md` and confirm the `## Tags` section is filled with
   a deduped list.
5. **Tier 1 (vocabulary exists):** ingest **D**. 
   - Pass: **D**'s tags are drawn from the `schema.md` vocabulary, reusing the
     exact spellings — no fresh synonym for a concept the vocabulary already
     names.

## Pass criteria

- The same concept gets the **same tag** across A/B/C/D (no `llm-eval` vs
  `llm-evaluation` vs `evals` split).
- After step 4, `schema.md` `## Tags` is a clean deduped list, and any tag a
  later ingest used that isn't in it lands under `## Pending`, not `Tags` (#35).
- Empty-wiki safety: on a brand-new wiki with zero pages, the first ingest
  still works (nothing to prefer yet — it just invents tags normally).
- Cost: the injected list is capped at 40 tags, so a large wiki never blows the
  context.

---

## Fixture A

```markdown
## how i evaluate an LLM prompt

before shipping a prompt i score it on a small labeled set. i track accuracy,
but also how often the model refuses or hallucinates. cheap offline evals beat
guessing. a golden set of 20 hand-checked examples catches most regressions.
```

## Fixture B

```markdown
## eval harness notes

built a tiny harness that runs the model over a fixed question set and diffs
answers against expected ones. the point of evaluation is catching drift when i
change the prompt. pass rate on the golden set is the one number i watch.
```

## Fixture C

```markdown
## measuring answer quality

quality = does the answer match the source, not just does it sound right.
grounded answers cite their source note. i sample a few pages a week and check
whether each claim is actually supported — a manual spot-check, not a metric.
```

## Fixture D

```markdown
## regression testing prompts

every prompt change gets re-run against the golden set before merge. if pass
rate drops, the change is reverted. this is the same idea as unit tests, but
for model behavior instead of code.
```

Expect A–D to converge on a shared tag for LLM evaluation / testing (e.g.
`llm-evaluation`) rather than four different spellings, and D specifically to
pull its tags from the `schema.md` vocabulary written in step 4.
