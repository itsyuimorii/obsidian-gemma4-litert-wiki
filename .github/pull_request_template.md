## What this changes, and why

<!-- The problem first. A reader should be able to tell from this paragraph whether the
     change is the right shape before looking at the diff. -->

## Checks

- [ ] `npm test` — every test passes (pure functions in `src/pure.ts` get tests; new commands must be documented in both READMEs or the docs test fails)
- [ ] `npm run lint` — 0 errors, warnings within budget
- [ ] `npm run build && npm run check:release` — ALL PASS
- [ ] Raw notes are still never modified without a preview, and nothing enters the wiki that did not come from a note the user wrote
