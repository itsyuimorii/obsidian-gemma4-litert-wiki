import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffUsage, formatMillis, formatUsageReport } from '../src/pure.ts';

const snap = (o: Record<string, [number, number]>) =>
  Object.fromEntries(Object.entries(o).map(([k, [calls, millis]]) => [k, { calls, millis }]));

test('diff reports only what happened between the snapshots', () => {
  const rows = diffUsage(snap({ ingest: [2, 4000] }), snap({ ingest: [5, 10000] }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].calls, 3);
  assert.equal(rows[0].millis, 6000);
  assert.equal(rows[0].millisPerCall, 2000);
});

test('a task that first appears in the window is included', () => {
  const rows = diffUsage(snap({ ingest: [1, 1000] }), snap({ ingest: [1, 1000], tags: [2, 500] }));
  assert.deepEqual(rows.map((r) => r.task), ['tags']);
});

test('rows are slowest first, ties broken by name so reports are stable', () => {
  const rows = diffUsage(
    {},
    snap({ zebra: [1, 500], provenance: [1, 9000], alpha: [1, 500], tags: [1, 3000] })
  );
  assert.deepEqual(rows.map((r) => r.task), ['provenance', 'tags', 'alpha', 'zebra']);
});

test('share sums to 1 across the window', () => {
  const rows = diffUsage({}, snap({ a: [1, 3000], b: [1, 1000] }));
  assert.equal(rows.find((r) => r.task === 'a')!.share, 0.75);
  assert.equal(rows.reduce((n, r) => n + r.share, 0), 1);
});

test('a reload between snapshots does not produce negative rows', () => {
  // Counters restarted: `after` is smaller than `before`.
  const rows = diffUsage(snap({ ingest: [9, 90000] }), snap({ ingest: [1, 2000] }));
  assert.deepEqual(rows, []);
});

test('snapshots passed the wrong way round produce nothing, not negatives', () => {
  const rows = diffUsage(snap({ ingest: [5, 10000] }), snap({ ingest: [2, 4000] }));
  assert.deepEqual(rows, []);
});

test('a task with no new calls is dropped even if it exists in both', () => {
  const rows = diffUsage(snap({ ingest: [3, 6000] }), snap({ ingest: [3, 6000] }));
  assert.deepEqual(rows, []);
});

test('share is zero rather than NaN when nothing took measurable time', () => {
  const rows = diffUsage({}, snap({ instant: [2, 0] }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].share, 0);
  assert.equal(rows[0].millisPerCall, 0);
});

test('durations read as durations at every size', () => {
  assert.equal(formatMillis(0), '0ms');
  assert.equal(formatMillis(320), '320ms');
  assert.equal(formatMillis(999), '999ms');
  assert.equal(formatMillis(1000), '1.0s');
  assert.equal(formatMillis(1449), '1.4s');
  assert.equal(formatMillis(59_900), '59.9s');
  assert.equal(formatMillis(60_000), '1m 00s');
  assert.equal(formatMillis(125_000), '2m 05s');
});

test('an empty window renders nothing at all, so callers can append blindly', () => {
  assert.equal(formatUsageReport([]), '');
});

test('the report carries a total row', () => {
  const rows = diffUsage({}, snap({ ingest: [2, 8000], tags: [1, 2000] }));
  const md = formatUsageReport(rows);
  assert.match(md, /\| ingest \| 2 \| 8\.0s \| 4\.0s \| 80% \|/);
  assert.match(md, /\| tags \| 1 \| 2\.0s \| 2\.0s \| 20% \|/);
  assert.match(md, /\*\*Total\*\* \| \*\*3\*\* \| \*\*10\.0s\*\*/);
});

test('the report is a table a reader can scan', () => {
  const md = formatUsageReport(diffUsage({}, snap({ a: [1, 1000] })));
  const lines = md.split('\n');
  assert.match(lines[0], /^\| Step \|/);
  assert.match(lines[1], /^\|---\|/);
  assert.equal(lines.length, 4); // header, rule, one row, total
});
