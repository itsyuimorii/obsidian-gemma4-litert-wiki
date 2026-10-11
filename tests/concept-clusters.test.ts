// Concept clusters: which subjects enough pages share to deserve a page
// above them.
//
// Two things ask this: the picker that builds a concept page, and the Tidy
// check that reports the subjects still without one. They used to be one
// loop inside the command, which is why Tidy could not ask.

import test from 'node:test';
import assert from 'node:assert/strict';
import { conceptClusters, type ConceptSource } from '../src/pure.ts';

const page = (linkPath: string, tags: string[], mentions: string[] = [], isConcept = false): ConceptSource => ({
  linkPath,
  tags,
  mentions,
  isConcept,
});

test('a subject is offered once enough pages share it', () => {
  const pages = [page('cards/a', ['coffee']), page('cards/b', ['coffee']), page('cards/c', ['tea'])];
  assert.deepEqual(conceptClusters(pages, 2), [{ key: 'coffee', label: 'coffee', members: ['cards/a', 'cards/b'] }]);
  assert.deepEqual(conceptClusters(pages, 3), []);
});

test('a tag on one page and a mention on another are the same subject', () => {
  const pages = [page('cards/a', ['espresso']), page('cards/b', [], ['Espresso'])];
  const [cluster, ...rest] = conceptClusters(pages, 2);
  assert.equal(rest.length, 0);
  assert.equal(cluster.key, 'espresso');
  // The first spelling seen names it.
  assert.equal(cluster.label, 'espresso');
  assert.deepEqual(cluster.members, ['cards/a', 'cards/b']);
});

test('a page carrying a subject as both tag and mention counts once', () => {
  const pages = [page('cards/a', ['grinder'], ['Grinder']), page('cards/b', ['grinder'])];
  assert.deepEqual(conceptClusters(pages, 2)[0].members, ['cards/a', 'cards/b']);
  // One page naming the subject twice is still one page.
  assert.deepEqual(conceptClusters([page('cards/a', ['grinder'], ['Grinder'])], 2), []);
});

test('a concept page is never a member of a cluster', () => {
  const pages = [
    page('cards/a', ['coffee']),
    page('cards/b', ['coffee']),
    page('concepts/coffee', ['concept', 'coffee'], [], true),
  ];
  assert.deepEqual(conceptClusters(pages, 2)[0].members, ['cards/a', 'cards/b']);
  // And it does not lift a subject over the threshold by itself.
  assert.deepEqual(conceptClusters([pages[0], pages[2]], 2), []);
});

test('tags that say what a page is are not subjects', () => {
  const pages = [page('cards/a', ['answer', 'chat', 'concept']), page('cards/b', ['answer', 'chat', 'concept'])];
  assert.deepEqual(conceptClusters(pages, 2), []);
  // The same words arriving as mentions are skipped too.
  const viaMentions = [page('cards/a', [], ['Answer', ' ']), page('cards/b', [], ['answer', ''])];
  assert.deepEqual(conceptClusters(viaMentions, 2), []);
});

test('the largest cluster comes first', () => {
  const pages = [
    page('cards/a', ['tea', 'coffee']),
    page('cards/b', ['tea', 'coffee']),
    page('cards/c', ['coffee']),
  ];
  assert.deepEqual(
    conceptClusters(pages, 2).map((c) => [c.label, c.members.length]),
    [
      ['coffee', 3],
      ['tea', 2],
    ]
  );
});
