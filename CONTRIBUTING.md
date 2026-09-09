# Contributing

## Running it

```
npm ci
npm run build          # esbuild → main.js
npm test               # node:test over tests/*.test.ts, no build step needed (Node 24+)
npm run lint           # eslint with the community store's own rule set
npm run check:release  # manifest, versions.json, CHANGELOG, README/command agreement
```

All four run in CI on every pull request, and a release runs them again from a clean
checkout before it builds. To try a build in a vault, copy `main.js`, `manifest.json` and
`styles.css` into `<vault>/.obsidian/plugins/gemma-litert-wiki/` and reload the plugin.

## Where things go

- **`src/pure.ts`** — functions with no Obsidian import. Anything that can live here should,
  because it is the only code the tests can reach directly. If you are adding logic, start
  by asking whether its core can be a pure function with a test.
- **`src/main.ts`** — commands and the pipeline. Model calls go through `timed()` so the
  per-step report keeps working.
- **`src/node-api.ts`** — the whole Node surface, declared. Do not import `node:*` anywhere
  else.
- **`tests/`** — `node:test`, one file per concern. `docs.test.ts` checks that every
  registered command appears in both READMEs; adding a command without documenting it
  fails the build on purpose.

## Two rules the code does not bend

1. **Raw notes are never modified by the model without a preview.** Exactly two commands
   touch a note the user wrote, and both show the whole result first.
2. **Nothing enters the wiki that did not come from a note the user wrote.** Ungrounded
   answers (Direct mode, the escape hatch) carry no sources and cannot be filed.

A change that needs to cross either line is a different plugin, and the pull request will
say so rather than merge it.

## Pull requests

Say what problem the change solves before what it does. Keep the diff to that problem.
Commit messages here are written as prose — what was wrong, what changed, why that
shape — and a reader a year from now should understand the decision from the message
alone.
