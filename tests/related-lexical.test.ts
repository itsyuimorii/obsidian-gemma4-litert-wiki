// Relink's model-free pre-pass: which pages relate on the evidence already in
// the metadata, before any model is asked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { queryTerms, scoreEntries, suggestRelated, type IndexEntry } from '../src/pure.ts';

const e = (linkPath: string, title: string, summary: string): IndexEntry => ({ linkPath, title, summary });
const tags = (o: Record<string, string[]>) => new Map(Object.entries(o));

const espresso = e('w/espresso', 'Espresso basics', 'Grind size, dose and pressure for a balanced shot');
const grinder = e('w/grinder', 'Grinder cleaning', 'Why the grinder needs cleaning and how often');
const webgpu = e('w/webgpu', 'WebGPU adapter', 'Adapter limits and feature detection in the renderer');
const unrelated = e('w/taxes', 'Tax notes', 'Deadlines for the annual filing');

test('one shared tag qualifies on its own', () => {
  const r = suggestRelated(espresso, [grinder, webgpu], tags({ 'w/espresso': ['coffee'], 'w/grinder': ['coffee'] }));
  assert.deepEqual(r.map((x) => x.entry.linkPath), ['w/grinder']);
  assert.deepEqual(r[0].sharedTags, ['coffee']);
});

test('a single overlapping word is not a relation', () => {
  // "grind" appears in both, and nothing else does.
  const r = suggestRelated(espresso, [grinder], tags({}));
  assert.deepEqual(r, []);
});

test('three overlapping terms qualify without any shared tag', () => {
  const a = e('w/a', 'Prompt cache', 'How the prompt cache is invalidated between runs');
  const b = e('w/b', 'Cache invalidation', 'When the prompt cache is invalidated and why runs differ');
  const r = suggestRelated(a, [b], tags({}));
  assert.equal(r.length, 1);
  assert.ok(r[0].termHits >= 3);
});

test('a page never suggests itself', () => {
  const r = suggestRelated(espresso, [espresso, grinder], tags({ 'w/espresso': ['coffee'], 'w/grinder': ['coffee'] }));
  assert.deepEqual(r.map((x) => x.entry.linkPath), ['w/grinder']);
});

test('tags outrank overlap, and ties break by path', () => {
  const t1 = e('w/t1', 'Tagged only', 'Nothing in common textually');
  const o1 = e('w/o1', 'Overlap only', 'Grind size dose pressure balanced shot');
  const r = suggestRelated(espresso, [o1, t1], tags({ 'w/espresso': ['coffee'], 'w/t1': ['coffee'] }));
  assert.deepEqual(r.map((x) => x.entry.linkPath), ['w/t1', 'w/o1']);
  // Same input, same order, every time.
  const again = suggestRelated(espresso, [t1, o1], tags({ 'w/espresso': ['coffee'], 'w/t1': ['coffee'] }));
  assert.deepEqual(again.map((x) => x.entry.linkPath), ['w/t1', 'w/o1']);
});

test('capped at max, best first', () => {
  const cands = ['a', 'b', 'c', 'd'].map((n) => e(`w/${n}`, n, ''));
  const t = tags(Object.fromEntries([['w/x', ['k']], ...cands.map((c) => [c.linkPath, ['k']])]));
  const r = suggestRelated(e('w/x', 'x', ''), cands, t, 2);
  assert.equal(r.length, 2);
});

test('missing tag entries are treated as no tags, not an error', () => {
  assert.deepEqual(suggestRelated(espresso, [unrelated], new Map()), []);
});

test('CJK summaries match on bigrams', () => {
  const a = e('w/ja1', '挽き目', '挽き目は抽出速度を決める最も重要な変数');
  const b = e('w/ja2', '抽出', '抽出速度と挽き目の関係についてのメモ');
  const r = suggestRelated(a, [b], tags({}));
  assert.equal(r.length, 1);
});

test('queryTerms is the same tokeniser retrieval uses', () => {
  // If these ever diverge, "related" would mean two different things.
  const idx = [espresso, grinder, webgpu];
  const viaScore = scoreEntries('grinder cleaning', idx).map((x) => x.linkPath);
  const terms = queryTerms('grinder cleaning');
  assert.deepEqual(terms, ['grinder', 'cleaning']);
  assert.equal(viaScore[0], 'w/grinder');
});
