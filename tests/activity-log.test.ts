// "What did I add to the wiki this week?" was a prompt, and the model
// answered it from twelve log lines it was handed with no idea what day it
// was. In a real vault those twelve lines were all `relink` entries from
// twelve days earlier, so the answer named pages that were not added, in a
// week that was not this one, plus one page that appeared in neither — it
// came from the catalog. The plugin knows all of this exactly; nothing here
// should ever have been a question for a 4B model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLogEntries, pagesAddedSince, isoDaysBefore, lastAddedDate } from '../src/pure.ts';

const LOG = `# Activity

- [2026-09-01] ingest | Closures
- [2026-09-13] ingest | vector-databases
- [2026-09-13] concept | finance
- [2026-09-13] relink | vector-databases
- [2026-09-13] relink | rag-vs-fine-tuning
- [2026-09-14] improve | 3. Closure (frontend master)
- [2026-09-24] ingest | Event loop
- [2026-09-24] error | Prune failed — ENOENT: no such file or directory
- [2026-09-25] ingest | Event loop
`;

test('every dated line parses, and nothing else does', () => {
  const e = parseLogEntries(LOG);
  assert.equal(e.length, 9);
  assert.deepEqual(e[0], { date: '2026-09-01', action: 'ingest', title: 'Closures' });
  assert.equal(e.at(-1)?.title, 'Event loop');
  assert.deepEqual(parseLogEntries('# Activity\n\nnot a log line\n'), []);
});

test('the legacy heading form still parses', () => {
  assert.deepEqual(parseLogEntries('## [2026-01-02] ingest | Old entry'), [
    { date: '2026-01-02', action: 'ingest', title: 'Old entry' },
  ]);
});

test('only ingest and concept count as adding a page', () => {
  const added = pagesAddedSince(parseLogEntries(LOG), '2026-09-13');
  assert.deepEqual(added.map((e) => `${e.date} ${e.action} ${e.title}`), [
    '2026-09-25 ingest Event loop',
    '2026-09-13 concept finance',
    '2026-09-13 ingest vector-databases',
  ]);
  // relink, improve and error are in the window and must not appear.
  assert.ok(!added.some((e) => ['relink', 'improve', 'error'].includes(e.action)));
});

test('a page ingested twice is listed once, at its newest date', () => {
  const added = pagesAddedSince(parseLogEntries(LOG), '2026-09-01');
  assert.equal(added.filter((e) => e.title === 'Event loop').length, 1);
  assert.equal(added.find((e) => e.title === 'Event loop')?.date, '2026-09-25');
});

test('the window excludes what falls before it', () => {
  const e = parseLogEntries(LOG);
  assert.deepEqual(pagesAddedSince(e, '2026-09-20').map((x) => x.title), ['Event loop']);
  assert.deepEqual(pagesAddedSince(e, '2026-09-26'), []);
  assert.equal(pagesAddedSince(e, '2026-09-01').length, 4);
  assert.equal(pagesAddedSince(e, '2026-09-01', 2).length, 2);
});

test('the window is counted in plain days, with no timezone in it', () => {
  assert.equal(isoDaysBefore('2026-09-25', 7), '2026-09-18');
  assert.equal(isoDaysBefore('2026-01-03', 7), '2025-12-27');
  assert.equal(isoDaysBefore('2026-03-01', 1), '2026-02-28');
});

test('when nothing is in the window, the last time anything was added is known', () => {
  const e = parseLogEntries(LOG);
  assert.equal(lastAddedDate(e), '2026-09-25');
  assert.equal(lastAddedDate(parseLogEntries('- [2026-09-13] relink | x\n- [2026-09-14] error | y')), undefined);
  assert.equal(lastAddedDate([]), undefined);
});

test('the real tail that produced the wrong answer yields nothing for this week', () => {
  // The twelve lines the model actually received, and the day it was asked.
  const real = parseLogEntries(`
- [2026-09-13] relink | vector-databases
- [2026-09-13] relink | rag-vs-fine-tuning
- [2026-09-13] relink | llm-inference-optimization
- [2026-09-13] concept | finance
- [2026-09-14] improve | 3. Closure (frontend master)
`);
  assert.deepEqual(pagesAddedSince(real, isoDaysBefore('2026-09-25', 7)), []);
  assert.equal(lastAddedDate(real), '2026-09-13');
});
