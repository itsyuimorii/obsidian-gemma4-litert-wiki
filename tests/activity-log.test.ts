// "What did I add to the wiki this week?" was a prompt, and the model
// answered it from twelve log lines it was handed with no idea what day it
// was. In a real vault those twelve lines were all `relink` entries from
// twelve days earlier, so the answer named pages that were not added, in a
// week that was not this one, plus one page that appeared in neither — it
// came from the catalog. The plugin knows all of this exactly; nothing here
// should ever have been a question for a 4B model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLogEntries, recentlyAdded, daysBetween, describeRecency, ADDED_SHOWN } from '../src/pure.ts';

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
  assert.deepEqual(parseLogEntries('# Activity\n\nnot a log line\n'), []);
});

test('the legacy heading form still parses', () => {
  assert.deepEqual(parseLogEntries('## [2026-01-02] ingest | Old entry'), [
    { date: '2026-01-02', action: 'ingest', title: 'Old entry' },
  ]);
});

test('only ingest and concept count as adding a page, newest first', () => {
  const added = recentlyAdded(parseLogEntries(LOG));
  assert.deepEqual(added.map((e) => `${e.date} ${e.action} ${e.title}`), [
    '2026-09-25 ingest Event loop',
    '2026-09-13 concept finance',
    '2026-09-13 ingest vector-databases',
    '2026-09-01 ingest Closures',
  ]);
  // relink, improve and error are in the log and must not appear.
  assert.ok(!added.some((e) => ['relink', 'improve', 'error'].includes(e.action)));
});

test('a page ingested twice is listed once, at its newest date', () => {
  const added = recentlyAdded(parseLogEntries(LOG));
  assert.equal(added.filter((e) => e.title === 'Event loop').length, 1);
  assert.equal(added.find((e) => e.title === 'Event loop')?.date, '2026-09-25');
});

test('the list is capped, and an empty log yields nothing', () => {
  assert.equal(recentlyAdded(parseLogEntries(LOG), 2).length, 2);
  assert.deepEqual(recentlyAdded([]), []);
  assert.deepEqual(recentlyAdded(parseLogEntries('- [2026-09-13] relink | x\n- [2026-09-14] error | y')), []);
});

test('days are counted as plain days, with no timezone in it', () => {
  assert.equal(daysBetween('2026-09-18', '2026-09-25'), 7);
  assert.equal(daysBetween('2025-12-27', '2026-01-03'), 7);
  assert.equal(daysBetween('2026-02-28', '2026-03-01'), 1);
  assert.equal(daysBetween('2026-09-25', '2026-09-25'), 0);
});

test('the line above the list counts every page and says how recent', () => {
  // The count is the total added, not the three that get a line of their own.
  assert.equal(describeRecency('2026-09-25', '2026-09-25', 12), '12 pages added, the last one today');
  assert.equal(describeRecency('2026-09-24', '2026-09-25', 1), '1 page added, the last one yesterday');
  assert.match(describeRecency('2026-09-20', '2026-09-25', 4), /^4 pages added, the last one 5 days ago$/);
});

test('a gap is named rather than hidden, and the pages are still listed', () => {
  // Between one and two weeks: say the week was empty, but stay in days.
  assert.match(describeRecency('2026-09-15', '2026-09-25', 6), /^6 pages added — nothing in the last week; the most recent was 10 days ago$/);
  // Past two weeks: the day itself is more use than a count.
  assert.match(describeRecency('2026-09-01', '2026-09-25', 6), /^6 pages added — nothing in the last two weeks; the most recent was 2026-09-01$/);
});

test('only the newest few are described, however many were added', () => {
  const many = parseLogEntries(
    Array.from({ length: 12 }, (_, i) => `- [2026-09-13] ingest | page-${i}`).join('\n')
  );
  const added = recentlyAdded(many);
  assert.equal(added.length, 12);
  assert.equal(added.slice(0, ADDED_SHOWN).length, 3);
  // The line still speaks for all twelve, so the rest is a count and a link.
  assert.match(describeRecency(added[0].date, '2026-09-25', added.length), /^12 pages added —/);
});

test('the real log that produced the wrong answer now describes itself honestly', () => {
  // The twelve lines the model actually received, and the day it was asked.
  const real = parseLogEntries(`
- [2026-09-13] relink | vector-databases
- [2026-09-13] relink | rag-vs-fine-tuning
- [2026-09-13] relink | llm-inference-optimization
- [2026-09-13] concept | finance
- [2026-09-14] improve | 3. Closure (frontend master)
`);
  const added = recentlyAdded(real);
  // Not one of the relinks the old answer listed as "added this week".
  assert.deepEqual(added.map((e) => e.title), ['finance']);
  // Twelve days: past a week, not yet past two, so it stays in days.
  assert.equal(describeRecency(added[0].date, '2026-09-25', added.length), '1 page added — nothing in the last week; the most recent was 12 days ago');
});
