// Retrieval: which pages a question reaches, and in what order.
//
// The property that matters most here is boring and easy to lose: the same
// question over the same index must return the same pages in the same order
// every time. An answer that changes between two identical asks is the one
// failure a user cannot tell from the model being unreliable.

import test from 'node:test';
import assert from 'node:assert/strict';
import { linkNeighbours, scoreEntries, type IndexEntry } from '../src/pure.ts';

const entry = (linkPath: string, title: string, summary: string): IndexEntry => ({
  linkPath,
  title,
  summary,
});

const INDEX: IndexEntry[] = [
  entry('gemma-wiki/sources/caching', 'Caching', 'How the prompt cache is invalidated between runs'),
  entry('gemma-wiki/sources/evals', 'Evals', 'Notes on grading model output against a rubric'),
  entry('gemma-wiki/sources/retrieval', 'Retrieval', 'Lexical scoring over the index, then the link graph'),
  entry('gemma-wiki/sources/deploy', 'Deploy', 'Release checklist and the store submission'),
  entry('gemma-wiki/concepts/tokens', 'Tokens', 'Counting tokens for the context window'),
];

test('scoring is deterministic across repeated identical calls', () => {
  const runs = new Set(
    Array.from({ length: 25 }, () =>
      scoreEntries('how is the prompt cache invalidated', INDEX)
        .map((e) => e.linkPath)
        .join('|')
    )
  );
  assert.equal(runs.size, 1, [...runs].join('  ///  '));
});

test('scoring does not depend on the order the index arrives in', () => {
  const forward = scoreEntries('token counting for the context window', INDEX).map((e) => e.linkPath);
  const reversed = scoreEntries('token counting for the context window', [...INDEX].reverse()).map(
    (e) => e.linkPath
  );
  assert.deepEqual(new Set(forward), new Set(reversed));
});

test('a question made only of function words retrieves nothing', () => {
  // "what's the common mistake between X and Y" used to retrieve every page
  // that merely contained "common" and "between".
  for (const q of ['what is the most common', 'how does this work', 'tell me about these']) {
    assert.deepEqual(scoreEntries(q, INDEX), [], q);
  }
});

test('an empty or punctuation-only question retrieves nothing', () => {
  for (const q of ['', '   ', '???', '。、！']) {
    assert.deepEqual(scoreEntries(q, INDEX), [], JSON.stringify(q));
  }
});

test('at most three pages come back', () => {
  const many = Array.from({ length: 50 }, (_, i) =>
    entry(`p/${i}`, `Caching ${i}`, 'the prompt cache and the rubric and the index')
  );
  assert.ok(scoreEntries('cache rubric index', many).length <= 3);
});

test('a CJK question reaches CJK pages', () => {
  // Issue #23: a whitespace/ASCII tokenizer dropped CJK entirely, so a
  // Chinese or Japanese question matched zero pages.
  const cjkIndex = [
    entry('w/a', '設計パターン', 'ソフトウェア設計のパターンについてのメモ'),
    entry('w/b', '料理', '今日の晩ごはんの記録'),
  ];
  const hits = scoreEntries('設計パターンとは', cjkIndex).map((e) => e.linkPath);
  assert.deepEqual(hits, ['w/a']);
});

test('a single-character CJK question is still a term', () => {
  const idx = [entry('w/a', '猫', '猫についてのメモ')];
  assert.equal(scoreEntries('猫', idx).length, 1);
});

test('scoring reads titles as well as summaries', () => {
  const idx = [
    entry('w/a', 'Quantisation', 'unrelated prose'),
    entry('w/b', 'Something else', 'also unrelated'),
  ];
  assert.deepEqual(scoreEntries('quantisation', idx).map((e) => e.linkPath), ['w/a']);
});

// ---------------------------------------------------------------------------

const links = (graph: Record<string, string[]>): Record<string, Record<string, number>> =>
  Object.fromEntries(
    Object.entries(graph).map(([src, tgts]) => [src, Object.fromEntries(tgts.map((t) => [t, 1]))])
  );

const NB = {
  allEntries: INDEX,
  maxExtra: 5,
  wikiPrefix: 'gemma-wiki/',
};

test('link expansion follows a seed outwards', () => {
  const out = linkNeighbours({
    ...NB,
    resolvedLinks: links({ 'gemma-wiki/sources/caching.md': ['gemma-wiki/concepts/tokens.md'] }),
    seeds: [INDEX[0]],
  });
  assert.deepEqual(out.map((e) => e.linkPath), ['gemma-wiki/concepts/tokens']);
});

test('link expansion follows backlinks too', () => {
  // The half that finds the concept page a card never links to.
  const out = linkNeighbours({
    ...NB,
    resolvedLinks: links({ 'gemma-wiki/concepts/tokens.md': ['gemma-wiki/sources/caching.md'] }),
    seeds: [INDEX[0]],
  });
  assert.deepEqual(out.map((e) => e.linkPath), ['gemma-wiki/concepts/tokens']);
});

test('a seed is never returned as its own neighbour', () => {
  const out = linkNeighbours({
    ...NB,
    resolvedLinks: links({
      'gemma-wiki/sources/caching.md': ['gemma-wiki/sources/caching.md', 'gemma-wiki/sources/evals.md'],
    }),
    seeds: [INDEX[0]],
  });
  assert.deepEqual(out.map((e) => e.linkPath), ['gemma-wiki/sources/evals']);
});

test('links out of the wiki folder are ignored', () => {
  const out = linkNeighbours({
    ...NB,
    resolvedLinks: links({ 'my notes/diary.md': ['gemma-wiki/sources/caching.md'] }),
    seeds: [INDEX[0]],
  });
  assert.deepEqual(out, []);
});

test('link expansion respects maxExtra, and returns nothing for zero', () => {
  const graph = links({
    'gemma-wiki/sources/caching.md': [
      'gemma-wiki/sources/evals.md',
      'gemma-wiki/sources/retrieval.md',
      'gemma-wiki/sources/deploy.md',
    ],
  });
  assert.equal(linkNeighbours({ ...NB, resolvedLinks: graph, seeds: [INDEX[0]], maxExtra: 2 }).length, 2);
  assert.deepEqual(linkNeighbours({ ...NB, resolvedLinks: graph, seeds: [INDEX[0]], maxExtra: 0 }), []);
  assert.deepEqual(linkNeighbours({ ...NB, resolvedLinks: graph, seeds: [], maxExtra: 5 }), []);
});

test('link expansion is deterministic', () => {
  const graph = links({
    'gemma-wiki/sources/caching.md': ['gemma-wiki/sources/evals.md', 'gemma-wiki/concepts/tokens.md'],
    'gemma-wiki/sources/deploy.md': ['gemma-wiki/sources/caching.md'],
  });
  const runs = new Set(
    Array.from({ length: 25 }, () =>
      linkNeighbours({ ...NB, resolvedLinks: graph, seeds: [INDEX[0]] })
        .map((e) => e.linkPath)
        .join('|')
    )
  );
  assert.equal(runs.size, 1, [...runs].join('  ///  '));
});

test('a link to a page with no index entry is not offered', () => {
  const out = linkNeighbours({
    ...NB,
    resolvedLinks: links({ 'gemma-wiki/sources/caching.md': ['gemma-wiki/sources/not-indexed.md'] }),
    seeds: [INDEX[0]],
  });
  assert.deepEqual(out, []);
});
