// Pages that are about the same thing — and, just as importantly, pages that
// are not.
//
// The cost of a false pair is a checkbox nobody trusts, which is worse than no
// finding at all, so the "these are NOT duplicates" cases below carry as much
// weight as the positive ones.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalTag,
  findDuplicatePairs,
  type DuplicateCandidate,
} from '../src/pure.ts';

let clock = 1000;
const page = (
  title: string,
  mentions: string[] = [],
  linkPath = `gemma-wiki/sources/${title.toLowerCase().replace(/\s+/g, '-')}`
): DuplicateCandidate => ({ linkPath, title, mentions, mtime: clock++ });

const find = (pages: DuplicateCandidate[], extra: Partial<Parameters<typeof findDuplicatePairs>[0]> = {}) =>
  findDuplicatePairs({ pages, cap: 20, ...extra });

// --- canonical names -------------------------------------------------------

test('a name with no alias is just its slug', () => {
  assert.equal(canonicalTag('LLM Eval'), 'llm-eval');
  assert.equal(canonicalTag('LLM Eval', {}), 'llm-eval');
});

test('an alias resolves, and resolves transitively', () => {
  const aliases = { evals: 'llm-eval', evaluation: 'evals' };
  assert.equal(canonicalTag('evals', aliases), 'llm-eval');
  assert.equal(canonicalTag('Evaluation', aliases), 'llm-eval');
});

test('a hand-written alias cycle terminates', () => {
  // `a: b` beside `b: a` is a thing a person will write in a file they own.
  const out = canonicalTag('a', { a: 'b', b: 'a' });
  assert.ok(out === 'a' || out === 'b', out);
  assert.equal(canonicalTag('a', { a: 'b', b: 'a' }), out, 'and is stable');
});

test('an alias pointing at itself is not a loop', () => {
  assert.equal(canonicalTag('x', { x: 'x' }), 'x');
});

test('aliases work across scripts', () => {
  assert.equal(canonicalTag('大規模言語モデル', { 大規模言語モデル: 'llm' }), 'llm');
});

// --- the positive cases ----------------------------------------------------

test('two notes with the same title are a pair', () => {
  const { pairs } = find([page('Espresso'), page('Espresso', [], 'gemma-wiki/sources/espresso-2')]);
  assert.equal(pairs.length, 1);
  assert.match(pairs[0].because, /both pages are called/);
});

test('a page whose title the other one mentions is a pair', () => {
  const { pairs } = find([
    page('Espresso', ['crema']),
    page('Morning routine', ['espresso', 'sourdough']),
  ]);
  assert.equal(pairs.length, 1);
  assert.match(pairs[0].because, /is named on the other page/);
});

test('two shared mentions are a pair; one is not', () => {
  const two = find([
    page('Note A', ['espresso', 'grinder']),
    page('Note B', ['espresso', 'grinder']),
    page('Filler', ['unrelated']),
  ]);
  assert.equal(two.pairs.length, 1);
  assert.match(two.pairs[0].because, /both name/);

  const one = find([page('Note A', ['espresso']), page('Note B', ['espresso', 'kettle'])]);
  assert.deepEqual(one.pairs, []);
});

test('aliases are what make a cross-name pair visible', () => {
  const pages = [page('Note A', ['llm-eval']), page('Note B', ['evals'])];
  // Without the alias table the two names are unrelated…
  assert.deepEqual(find(pages).pairs, []);
  // …and with it they are the same subject. One shared mention still is not
  // enough on its own, so give them a second name in common.
  const withSecond = [page('Note C', ['llm-eval', 'rubric']), page('Note D', ['evals', 'rubric'])];
  assert.deepEqual(find(withSecond).pairs, []);
  assert.equal(find(withSecond, { aliases: { evals: 'llm-eval' } }).pairs.length, 1);
});

test('an aliased title matches an aliased mention', () => {
  const pages = [page('Evals', ['rubric']), page('Grading notes', ['llm-eval'])];
  assert.deepEqual(find(pages).pairs, []);
  assert.equal(find(pages, { aliases: { evals: 'llm-eval' } }).pairs.length, 1);
});

// --- the negative cases, which matter as much ------------------------------

test('pages that already link to each other are not reported', () => {
  const pages = [page('Espresso'), page('Espresso', [], 'gemma-wiki/sources/espresso-2')];
  const linked = (a: string, b: string) => (a.includes('espresso') && b.includes('espresso'));
  assert.deepEqual(find(pages, { linked }).pairs, []);
});

test('a mention carried by much of the wiki is a topic, not an identity', () => {
  // Every page mentions "ai" and "notes". Without the topic filter this is
  // ten pages all pairing with each other on two shared mentions.
  const pages = Array.from({ length: 10 }, (_, i) => page(`Note ${i}`, ['ai', 'notes']));
  assert.deepEqual(find(pages).pairs, []);
});

test('an identifying mention still counts on a wiki full of a common one', () => {
  const pages = [
    ...Array.from({ length: 8 }, (_, i) => page(`Filler ${i}`, ['ai', 'notes'])),
    page('Note A', ['ai', 'notes', 'espresso', 'grinder']),
    page('Note B', ['ai', 'notes', 'espresso', 'grinder']),
  ];
  const { pairs } = find(pages);
  assert.equal(pairs.length, 1);
  assert.match(pairs[0].because, /espresso/);
});

test('unrelated pages produce nothing', () => {
  const { pairs, total } = find([
    page('ETF basics', ['vanguard', 'index-fund']),
    page('TCP retransmission', ['congestion-window']),
    page('Sourdough', ['starter']),
  ]);
  assert.deepEqual(pairs, []);
  assert.equal(total, 0);
});

test('a page is never paired with itself', () => {
  const one = page('Espresso', ['crema']);
  assert.deepEqual(find([one, one]).pairs, []);
});

test('titles that slugify to nothing do not all collide on untitled', () => {
  // Both slugify to `untitled`, which would otherwise read as the same title.
  assert.deepEqual(find([page('!!!'), page('???', [], 'gemma-wiki/sources/q')]).pairs, []);
});

test('an empty or single-page wiki is handled', () => {
  assert.deepEqual(find([]), { pairs: [], total: 0 });
  assert.deepEqual(find([page('Only one')]), { pairs: [], total: 0 });
});

// --- reporting -------------------------------------------------------------

test('the newest pair is reported first, and truncation stays visible', () => {
  // Six same-titled pairs, so six findings against a cap of three.
  const pages = Array.from({ length: 12 }, (_, i) =>
    page(`Topic ${Math.floor(i / 2)}`, [], `gemma-wiki/sources/p${i}`)
  );
  const { pairs, total } = findDuplicatePairs({ pages, cap: 3 });
  assert.equal(pairs.length, 3);
  assert.equal(total, 6);
  // page() hands out increasing mtimes, so the last page made is the newest.
  assert.ok(pairs[0].a.linkPath === 'gemma-wiki/sources/p11' || pairs[0].b.linkPath === 'gemma-wiki/sources/p11');
});

test('a cap of zero returns nothing rather than everything', () => {
  const pages = [page('Espresso'), page('Espresso', [], 'gemma-wiki/sources/e2')];
  assert.deepEqual(findDuplicatePairs({ pages, cap: 0 }), { pairs: [], total: 0 });
});

test('the result is deterministic', () => {
  const pages = [
    page('Espresso', ['crema', 'grinder']),
    page('Coffee log', ['espresso', 'grinder']),
    page('Grinder notes', ['grinder', 'burr']),
  ];
  const shape = () => find(pages).pairs.map((p) => `${p.a.linkPath}|${p.b.linkPath}|${p.because}`).join('\n');
  const first = shape();
  for (let i = 0; i < 10; i++) assert.equal(shape(), first);
});
