// Vault mode retrieval: rank from metadata, refine from bodies, and decide
// whether a question wants a list of notes or an answer.
//
// The threshold is the thing to get right. Below it a general question
// ("what is a KV cache") grounds in whatever note happens to share one word,
// and the answer arrives wearing a Sources row it did not earn. Above it a
// note plainly about the subject is skipped. VAULT_MATCH_MIN sits where a
// title or tag hit, or two distinct terms, is enough and one stray word is not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeByName,
  excerptAround,
  looksLikeListQuery,
  looksLikeCollectionQuery,
  looksLikeRecentQuery,
  rankVaultDocs,
  rescoreWithBodies,
  VAULT_MATCH_MIN,
  vaultHistoryText,
  weightedTerms,
  type VaultDoc,
} from '../src/pure.ts';

const DOCS: VaultDoc[] = [
  { path: 'coffee/grind size.md', title: 'grind size', tags: ['coffee', 'extraction'], headings: ['Why finer is faster'] },
  { path: 'coffee/water temperature.md', title: 'water temperature', tags: ['coffee'], headings: ['Dark roasts'] },
  { path: 'dev/closures.md', title: 'closures', tags: ['js', 'javascript'], headings: ['Scope chain', 'Common bugs'] },
  { path: 'dev/litert on device.md', title: 'litert on device', tags: ['ai'], headings: ['Shader compilation', 'KV cache'] },
  { path: 'daily/2026-09-09.md', title: '2026-09-09', tags: [], headings: [] },
];

// --- rankVaultDocs ---------------------------------------------------------

test('a title hit outranks a heading hit', () => {
  const hits = rankVaultDocs('grind size', DOCS);
  assert.equal(hits[0].path, 'coffee/grind size.md');
  assert.ok(hits[0].score >= 3);
});

test('a tag hit is worth a title hit, so "my js notes" finds the tagged note', () => {
  const hits = rankVaultDocs('which of my js notes are about scope', DOCS);
  assert.equal(hits[0].path, 'dev/closures.md');
  assert.ok(hits[0].score >= 3);
});

test('a heading hit scores, but low', () => {
  const hits = rankVaultDocs('KV cache', DOCS);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, 'dev/litert on device.md');
  // "kv" is two letters and queryTerms drops it; "cache" in a heading is 1.
  assert.equal(hits[0].score, 1);
});

test('nothing matches, nothing is returned', () => {
  assert.deepEqual(rankVaultDocs('quantum chromodynamics', DOCS), []);
  assert.deepEqual(rankVaultDocs('', DOCS), []);
  assert.deepEqual(rankVaultDocs('the and of', DOCS), []);
});

test('results are capped and best-first', () => {
  const many: VaultDoc[] = Array.from({ length: 100 }, (_, i) => ({
    path: `n/${i}.md`, title: i % 2 ? `coffee ${i}` : `tea ${i}`, tags: [], headings: [],
  }));
  const hits = rankVaultDocs('coffee', many, 10);
  assert.equal(hits.length, 10);
  assert.ok(hits.every((h) => Number(h.path.match(/(\d+)\.md$/)?.[1]) % 2 === 1));
});

test('Japanese questions match Japanese titles and tags', () => {
  const docs: VaultDoc[] = [
    { path: 'a.md', title: 'コーヒー抽出', tags: ['コーヒー'], headings: [] },
    { path: 'b.md', title: 'クロージャ', tags: ['js'], headings: [] },
  ];
  assert.equal(rankVaultDocs('コーヒーについて何を書いた', docs)[0]?.path, 'a.md');
  assert.equal(rankVaultDocs('クロージャとは', docs)[0]?.path, 'b.md');
});

// --- rescoreWithBodies -----------------------------------------------------

test('a rare word once is a match; a word in every note is not', () => {
  const bodies = new Map([
    ['daily/1.md', 'Tried a new coffee today. The grind was too coarse and the shot ran fast.'],
    ['daily/2.md', 'Meeting notes. The outline of the talk is due next week.'],
    ['daily/3.md', 'Another day. Wrote the outline for the report.'],
    ['daily/4.md', 'Outline first, then prose. Always.'],
  ]);
  const hits = rescoreWithBodies('coffee grind', [], bodies);
  assert.equal(hits[0]?.path, 'daily/1.md');
  assert.ok(hits[0].score >= VAULT_MATCH_MIN);
  // "outline" is in three of four notes: near-zero weight, no match.
  assert.deepEqual(rescoreWithBodies('what is a KV cache outline', [], bodies), []);
});

test('connective pieces every note shares do not let the longest note win', () => {
  // Two-character pieces of a question in a language without word spaces —
  // most are shared by every note in that language. The note that carries
  // the actual subject must outrank the long note that carries the pieces.
  const filler = 'このメモについて、ノートに書いたことをまとめる。'.repeat(40);
  const bodies = new Map<string, string>();
  for (let i = 0; i < 10; i++) bodies.set(`long${i}.md`, `${filler} 項目${i}`);
  bodies.set('js.md', 'クロージャについてのメモ。JavaScript の scope chain を整理した。');
  const hits = rescoreWithBodies('私のノートについて JavaScript のメモはどれ', [], bodies);
  assert.equal(hits[0]?.path, 'js.md');
});

test('two-letter tokens match as whole words and carry weight', () => {
  const bodies = new Map([
    ['a.md', 'Notes on js closures and the scope chain.'],
    ['b.md', 'JSON is not js. Also json again, and jsx.'],
    ['c.md', 'Nothing relevant at all here.'],
    ['d.md', 'A recipe for bread.'],
    ['e.md', 'Travel plans for October.'],
  ]);
  const hits = rescoreWithBodies('my js notes', [], bodies);
  assert.equal(hits[0]?.path, 'a.md');
  assert.ok(!hits.some((h) => h.path === 'c.md'));
});

test('a repeated word gains at most three counts and never beats three distinct rare words', () => {
  const bodies = new Map([
    ['spam.md', 'coffee '.repeat(40)],
    ['real.md', 'coffee grind extraction — three of the words, once each'],
    ['other.md', 'tea and biscuits'],
  ]);
  const hits = rescoreWithBodies('coffee grind extraction', [], bodies);
  assert.equal(hits[0].path, 'real.md');
  const spam = hits.find((h) => h.path === 'spam.md');
  assert.ok(!spam || spam.score < hits[0].score);
});

test('identical bodies in two folders count once', () => {
  const same = 'The same file kept in two places, about coffee grind.';
  const bodies = new Map([['a/dup.md', same], ['b/dup.md', same], ['c/other.md', 'tea']]);
  const hits = rescoreWithBodies('coffee grind', [], bodies);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, 'a/dup.md');
});

test('prior metadata score carries into the body pass', () => {
  const prior = rankVaultDocs('grind size', DOCS);
  const bodies = new Map([
    ['coffee/grind size.md', 'Finer grind, faster extraction.'],
    ['other.md', 'unrelated'],
  ]);
  const hits = rescoreWithBodies('grind size', prior, bodies);
  assert.equal(hits[0].path, 'coffee/grind size.md');
  assert.ok(hits[0].score > prior[0].score);
});

test('the body pass returns at most max, best first', () => {
  const bodies = new Map<string, string>();
  for (let i = 0; i < 12; i++) bodies.set(`n${i}.md`, `coffee grind term${i} ${'term'.repeat(0)}`);
  bodies.set('x.md', 'nothing here');
  // Seven rare terms, one per note; "coffee grind" is in twelve of thirteen and weighs nothing.
  const hits = rescoreWithBodies('term1 term2 term3 term4 term5 term6 term7 coffee grind', [], bodies, 5);
  assert.equal(hits.length, 5);
  assert.ok(hits[0].score >= hits[4].score);
  assert.ok(hits.every((h) => /^n[1-7]\.md$/.test(h.path)));
});

// --- looksLikeRecentQuery --------------------------------------------------

test('questions about what was written recently', () => {
  for (const q of [
    'Which notes did I edit recently?',
    'what did I write this week',
    'show me the notes I added in the last few days',
    'what have I been working on lately',
    '最近書いたノートは',
    '今週編集したメモを見せて',
  ]) assert.ok(looksLikeRecentQuery(q), q);
});

test('a time word alone is not a recent-notes question', () => {
  for (const q of ['what is the latest version of Node', 'today is Tuesday', 'recent advances in batteries', 'which of my notes mention coffee', ''])
    assert.equal(looksLikeRecentQuery(q), false, q);
});

// --- looksLikeListQuery ----------------------------------------------------

test('questions that want a list of notes', () => {
  for (const q of [
    'which of my notes mention WebGPU',
    'Which notes are about coffee?',
    'what files do I have on javascript',
    'list my notes about closures',
    'find notes on grind size',
    'how many notes do I have about AI',
    'どのノートが WebGPU に触れていますか',
    'コーヒーに関するノートを一覧して',
    'クロージャに関するノートを探して',
    'AI に関する記事はどれ',
    '何件のノートがコーヒーについて書いていますか',
  ]) assert.ok(looksLikeListQuery(q), q);
});

test('questions that want an answer, not a list', () => {
  for (const q of [
    'what is a KV cache',
    'what did I write about grind size',
    'summarise my notes on coffee',
    'explain closures',
    'コーヒー抽出の原理は何ですか',
    '',
  ]) assert.equal(looksLikeListQuery(q), false, q);
});

// --- excerptAround ---------------------------------------------------------


test('a short note is returned whole', () => {
  assert.equal(excerptAround('Just a line about coffee.', ['coffee'], 500), 'Just a line about coffee.');
});

test('a long note yields the windows around the terms, not its opening', () => {
  const intro = 'Intro paragraph about nothing in particular. '.repeat(30);
  const body = intro + 'Here is the one sentence that mentions coffee and grind size.' + ' Trailing text. '.repeat(30);
  const out = excerptAround(body, ['coffee', 'grind'], 600, 80);
  assert.ok(out.includes('mentions coffee and grind size'));
  assert.ok(!out.startsWith('Intro paragraph'), 'should not start at the top');
  assert.ok(out.startsWith('…'), 'marks that text was skipped');
  assert.ok(out.length <= 620);
});

test('overlapping windows merge; distant ones are joined with an ellipsis line', () => {
  const body = 'coffee '.padEnd(400, 'x') + ' tea ' + 'y'.repeat(2000) + ' coffee again';
  const out = excerptAround(body, ['coffee'], 1200, 50);
  assert.equal(out.split('\n…\n').length, 2);
});

test('no term found falls back to the opening, marked', () => {
  const body = 'A long note. '.repeat(100);
  const out = excerptAround(body, ['zebra'], 200);
  assert.ok(out.endsWith('…'));
  assert.ok(out.length <= 201);
  assert.ok(out.startsWith('A long note.'));
});

test('the character cap is respected even with many hits', () => {
  const body = ('coffee ' + 'z'.repeat(300) + ' ').repeat(40);
  const out = excerptAround(body, ['coffee'], 1000, 100);
  assert.ok(out.length <= 1001, String(out.length));
});

// --- looksLikeCollectionQuery ----------------------------------------------

test('questions about the collection, not about a subject in it', () => {
  for (const q of [
    'What connects my notes?',
    'what themes come up across my vault',
    'what am I missing',
    'which questions are still open',
    'do any of my notes contradict each other',
    'what did I add this week',
    'ノート同士のつながりは',
    '全体としてどんなテーマがある',
  ]) assert.ok(looksLikeCollectionQuery(q), q);
});

test('questions about a subject are not collection questions', () => {
  for (const q of [
    'what have I written about coffee',
    'which of my notes mention WebGPU',
    'explain closures',
    'summarise the note on grind size',
    '',
  ]) assert.equal(looksLikeCollectionQuery(q), false, q);
});

// --- dedupeByName ------------------------------------------------------------

test('two hits with the same note name keep only the first', () => {
  const hits = dedupeByName([
    { path: 'a/Bulkhead.md', score: 5 },
    { path: 'b/Bulkhead.md', score: 4.5 },
    { path: 'a/CSV batch.md', score: 3 },
    { path: 'z/csv batch.md', score: 2 },
  ]);
  assert.deepEqual(hits.map((h) => h.path), ['a/Bulkhead.md', 'a/CSV batch.md']);
});

// --- vaultHistoryText --------------------------------------------------------

test('only the grounded part of a two-part answer goes back into history', () => {
  const grounded = 'Your notes say X.';
  assert.equal(vaultHistoryText('both', grounded), grounded);
});

test('a list answer goes back as one line that names no note', () => {
  const t = vaultHistoryText('list', '- **W01** about closures\n- **Blind 75** algorithms');
  assert.ok(t && !/W01|Blind/.test(t));
});

test('other shapes keep their content', () => {
  assert.equal(vaultHistoryText('none', 'x'), undefined);
  assert.equal(vaultHistoryText('overview', 'x'), undefined);
});

// --- excerpting follows the weights ----------------------------------------

test('the rare word late in a note wins the budget over a common word on line one', () => {
  // "about" on every line from the top; "coffee" once, far down.
  const filler = 'This line is about something or other and nothing more. '.repeat(40);
  const body = filler + 'Finally: the one paragraph about coffee, grind size and the shot.' + ' Tail. '.repeat(20);
  const bodies = new Map([['a.md', body], ['b.md', 'about about about'], ['c.md', 'about this and that']]);
  const wt = weightedTerms('what did I write about coffee', bodies)
    .filter((w) => w.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .map(({ t, whole }) => ({ t, whole }));
  assert.equal(wt[0]?.t, 'coffee', JSON.stringify(wt));
  const out = excerptAround(body, wt, 400, 120);
  assert.ok(out.includes('paragraph about coffee'), out.slice(0, 120));
});

test('a whole-word term drives the excerpt too', () => {
  const body = 'x '.repeat(300) + 'The build writes main.js and a js helper. ' + 'y '.repeat(300);
  const out = excerptAround(body, [{ t: 'js', whole: true }], 200, 60);
  assert.ok(out.includes('js helper'));
});
