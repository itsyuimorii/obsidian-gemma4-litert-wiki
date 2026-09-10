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
import { asksAboutOwnNotes } from '../src/pure.ts';
import {
  dedupeByName,
  excerptAround,
  parseExpansion,
  phraseOf,
  queryTerms,
  subjectOf,
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
  // "cache" in a heading is 1; "kv" is a two-letter token, matched as a whole word in the heading, 1 more.
  assert.equal(hits[0].score, 2);
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
    { path: 'a/Bulkhead.md', score: 5, tier: 'about' },
    { path: 'b/Bulkhead.md', score: 4.5, tier: 'about' },
    { path: 'a/CSV batch.md', score: 3, tier: 'mentions' },
    { path: 'z/csv batch.md', score: 2, tier: 'mentions' },
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

// --- tokenizer: six languages, real words ------------------------------------

test('Chinese and Japanese are segmented into words, not sliding bigrams', () => {
  const zh = queryTerms('哪几篇笔记提到 js');
  assert.ok(!zh.includes('记提'), JSON.stringify(zh));
  assert.ok(!zh.includes('哪几'), JSON.stringify(zh));
  assert.deepEqual(queryTerms('我关于 coffee 写过什么'), ['coffee']);
  const ja = queryTerms('プロンプトの接頭辞が変わるたびに無効になります');
  assert.ok(ja.includes('プロンプト') && !ja.includes('の') && !ja.includes('ます'), JSON.stringify(ja));
});

test('French, German and Spanish keep their nouns and drop their function words', () => {
  assert.deepEqual(queryTerms("Quelles notes parlent de l'extraction du café ?"), ['extraction', 'café']);
  assert.deepEqual(queryTerms('Welche Notizen erwähnen die Kaffeeextraktion?'), ['kaffeeextraktion']);
  assert.deepEqual(queryTerms('¿Qué notas hablan de la extracción del café?'), ['extracción', 'café']);
});

test('instruction words never become search terms', () => {
  assert.deepEqual(queryTerms('Draft a short outline for coffee'), ['coffee']);
  assert.deepEqual(queryTerms('explain in plain terms what a kv cache is'), ['cache']);
  assert.deepEqual(queryTerms('帮我找一下关于闭包的笔记'), ['闭包']);
});

test('the subject of a chip-filled question is what follows the colon', () => {
  assert.equal(subjectOf('Draft a short outline for: coffe'), 'coffe');
  assert.equal(subjectOf('Which of my notes are about: coffee'), 'coffee');
  assert.equal(subjectOf('Explain, in plain terms: what a KV cache is'), 'what a KV cache is');
  assert.equal(subjectOf('what did I write about coffee'), 'what did I write about coffee');
  // A colon deep inside prose is not a chip prefix.
  const prose = 'The note says one thing and then the other and finally, after all that, this: nothing';
  assert.equal(subjectOf(prose), prose);
});

test('a chip-filled instruction retrieves by its subject only', () => {
  const bodies = new Map([
    ['outline.md', 'A short outline is a draft. Draft the outline, then a short draft again.'],
    ['coffee.md', 'Tried a new coffee. The grind was coarse.'],
    ['other.md', 'Nothing here.'],
  ]);
  const hits = rescoreWithBodies('Draft a short outline for: coffee', [], bodies);
  assert.deepEqual(hits.map((h) => h.path), ['coffee.md']);
});

// --- tiers: about versus mentions ---------------------------------------------

test('a title or tag hit is about; one body mention is mentions; three is about', () => {
  const docs: VaultDoc[] = [
    { path: 'coffee/guide.md', title: 'coffee guide', tags: [], headings: [] },
    { path: 'daily/1.md', title: '2026-09-01', tags: [], headings: [] },
    { path: 'daily/2.md', title: '2026-09-02', tags: [], headings: [] },
    { path: 'daily/3.md', title: '2026-09-03', tags: [], headings: [] },
  ];
  const bodies = new Map([
    ['coffee/guide.md', 'Grind, water, time.'],
    ['daily/1.md', "Coffee's on me, she said, and that was that."],
    ['daily/2.md', 'coffee in the morning, coffee at noon, coffee at night.'],
    ['daily/3.md', 'A day without anything to report.'],
  ]);
  const hits = rescoreWithBodies('coffee', rankVaultDocs('coffee', docs), bodies);
  const tier = Object.fromEntries(hits.map((h) => [h.path, h.tier]));
  assert.equal(tier['coffee/guide.md'], 'about');
  assert.equal(tier['daily/1.md'], 'mentions');
  assert.equal(tier['daily/2.md'], 'about');
  assert.equal(tier['daily/3.md'], undefined);
});

test('the decay has no cliff: a term in half the notes still counts a little', () => {
  const bodies = new Map<string, string>();
  for (let i = 0; i < 10; i++) bodies.set(`n${i}.md`, i < 6 ? `design design design ${i}` : `other ${i}`);
  const wt = weightedTerms('design', bodies);
  assert.ok(wt[0].weight > 0 && wt[0].weight < 0.3, String(wt[0].weight));
});

// --- Chinese question shapes ----------------------------------------------------

test('Chinese list, recent, collection and own-notes questions are recognised', () => {
  assert.ok(looksLikeListQuery('哪几篇笔记提到 js'));
  assert.ok(looksLikeListQuery('我的 JS 笔记有哪些'));
  assert.ok(looksLikeRecentQuery('我最近写了哪些笔记'));
  assert.ok(looksLikeCollectionQuery('我的笔记之间有什么联系'));
  assert.ok(asksAboutOwnNotes('我的 vault 里有什么'));
  assert.ok(asksAboutOwnNotes('wo de vault 里有什么内容'));
});

test('three mentions in a long note are still mentions; three in a short one are about', () => {
  const long = ('Long note about something else. '.repeat(120)) + ' coffee coffee coffee ' + ('More about something else. '.repeat(120));
  const short = 'Coffee today. Coffee grind was coarse. Coffee again tomorrow.';
  const bodies = new Map([['long.md', long], ['short.md', short], ['x.md', 'tea'], ['y.md', 'water']]);
  const tier = Object.fromEntries(rescoreWithBodies('coffee', [], bodies).map((h) => [h.path, h.tier]));
  assert.equal(tier['long.md'], 'mentions');
  assert.equal(tier['short.md'], 'about');
});

test('a list question can lower the bar to any mention of the subject', () => {
  const bodies = new Map<string, string>();
  for (let i = 0; i < 20; i++) bodies.set(`n${i}.md`, i < 12 ? `uses js once: main.js ${i}` : `nothing ${i}`);
  // js is in 60% of notes: light weight, below the answer threshold …
  assert.equal(rescoreWithBodies('which notes mention js', [], bodies, 12).length, 0);
  // … but a list question asks for exactly those notes.
  assert.equal(rescoreWithBodies('which notes mention js', [], bodies, 12, 0.05).length, 12);
});

test('French and Spanish two-letter function words are not search terms', () => {
  assert.deepEqual(queryTerms('quelles notes parlent de design'), ['design']);
  const bodies = new Map([['a.md', 'de la de la design'], ['b.md', 'de de de']]);
  const wt = weightedTerms('quelles notes parlent de design', bodies);
  assert.ok(!wt.some((w) => w.t === 'de'));
});

// --- expansion --------------------------------------------------------------------

test('the model expansion is parsed into keywords and nothing else', () => {
  const raw = 'JavaScript\n- ECMAScript\n2. closures\n* 闭包\n作用域, prototype\nJavaScript is a programming language used for the web.\njs\n\nnode.js';
  const out = parseExpansion(raw, 'js');
  assert.deepEqual(out, ['javascript', 'ecmascript', 'closures', '闭包', '作用域', 'prototype', 'node.js']);
});

test('expansion terms find the note that never spells out the abbreviation', () => {
  const docs: VaultDoc[] = [
    { path: 'w01.md', title: 'W01 执行上下文、作用域、闭包', tags: [], headings: [] },
    { path: 'build.md', title: 'build notes', tags: [], headings: [] },
  ];
  const bodies = new Map([
    ['w01.md', '闭包是函数和它的词法作用域的组合。'],
    ['build.md', 'The build writes main.js to dist.'],
  ]);
  const extra = ['javascript', '闭包', '作用域'];
  const hits = rescoreWithBodies('哪几篇笔记提到 js', rankVaultDocs('哪几篇笔记提到 js', docs, 60, extra), bodies, 5, 0.05, extra);
  assert.equal(hits[0]?.path, 'w01.md');
  assert.equal(hits[0]?.tier, 'about');
});

test('an expansion term weighs less than a typed one', () => {
  const bodies = new Map([['a.md', 'closures everywhere'], ['b.md', 'javascript everywhere'], ['c.md', 'tea']]);
  const wt = weightedTerms('javascript', bodies, ['closures']);
  const typed = wt.find((w) => w.t === 'javascript')!;
  const grown = wt.find((w) => w.t === 'closures')!;
  assert.ok(grown.expanded && grown.weight < typed.weight);
});

test('a generic expansion term in a title does not make the note about the subject', () => {
  const docs: VaultDoc[] = [
    { path: 'webview.md', title: 'WebView architecture decision', tags: [], headings: [] },
    { path: 'w01.md', title: 'W01 执行上下文、作用域、闭包', tags: [], headings: [] },
    { path: 'a.md', title: 'web notes a', tags: [], headings: [] },
    { path: 'b.md', title: 'web notes b', tags: [], headings: [] },
  ];
  const bodies = new Map([
    ['webview.md', 'The WebView cannot talk to the native app directly. Bridge required.'],
    ['w01.md', '闭包是函数和它的词法作用域的组合。'],
    ['a.md', 'web web web'],
    ['b.md', 'web again'],
  ]);
  const extra = ['web', '闭包'];
  const hits = rescoreWithBodies('javascript', rankVaultDocs('javascript', docs, 60, extra), bodies, 8, 0.05, extra);
  const tier = Object.fromEntries(hits.map((h) => [h.path, h.tier]));
  // "web" is a substring of WebView, but expansion terms match whole words; and it is common here.
  assert.notEqual(tier['webview.md'], 'about');
  // 闭包 is rare here, and in the title.
  assert.equal(tier['w01.md'], 'about');
});

// --- Phrases, tags, headings, length ------------------------------------------
//
// The second real vault: "system design" matched every note with "system"
// in one paragraph and "design" in another, a tag react-native counted as
// the word react, a heading counted as much as a title for the tier, and
// the two longest work logs led every list because they hold more words.

test('a two- or three-word Latin subject is a phrase; a longer one is not', () => {
  assert.equal(phraseOf('system design'), 'system design');
  assert.equal(phraseOf('what did I write about react native'), 'react native');
  assert.equal(phraseOf('React Native bridge'), 'react native bridge');
  assert.equal(phraseOf('react'), undefined);
  assert.equal(phraseOf('coffee grind size water temperature'), undefined);
  assert.equal(phraseOf('我关于 React 写过什么'), undefined);
  assert.equal(phraseOf('explain react and vue'), undefined);
});

test('the phrase whole is about; its words apart are a mention', () => {
  const docs: VaultDoc[] = [
    { path: 'sd.md', title: 'System design', tags: [], headings: [] },
    { path: 'w15.md', title: 'W15 RADIO', tags: ['system-design'], headings: [] },
    { path: 'resume.md', title: 'Master Resume', tags: [], headings: [] },
    { path: 'x.md', title: 'x', tags: [], headings: [] },
  ];
  const bodies = new Map([
    ['sd.md', 'Scalability, caching, sharding.'],
    ['w15.md', 'The RADIO framework for a component-level design.'],
    ['resume.md', 'Led the design of the billing system. Owned system health. Design reviews weekly. System upgrades.'],
    ['x.md', 'tea'],
  ]);
  const hits = rescoreWithBodies('Which of my notes are about: system design', rankVaultDocs('Which of my notes are about: system design', docs), bodies, 8, 0.05);
  const tier = Object.fromEntries(hits.map((h) => [h.path, h.tier]));
  assert.equal(tier['sd.md'], 'about');
  // A tag written system-design is the phrase.
  assert.equal(tier['w15.md'], 'about');
  // "system" four times and "design" three times, never together.
  assert.equal(tier['resume.md'], 'mentions');
  assert.equal(tier['x.md'], undefined);
});

test('a tag is the whole word: react-native is not react, dev/react is', () => {
  const docs: VaultDoc[] = [
    { path: 'rn.md', title: 'Bridge notes', tags: ['react-native'], headings: [] },
    { path: 'r.md', title: 'Rendering notes', tags: ['dev/react'], headings: [] },
    { path: 'x.md', title: 'x', tags: [], headings: [] },
  ];
  const ranked = rankVaultDocs('react', docs);
  assert.deepEqual(ranked.map((h) => h.path), ['r.md']);
  assert.deepEqual(ranked[0].metaTyped, ['react']);
});

test('a Chinese tag still matches as a substring', () => {
  const docs: VaultDoc[] = [{ path: 'a.md', title: 'W22', tags: ['前端面试'], headings: [] }];
  assert.equal(rankVaultDocs('面试', docs)[0]?.path, 'a.md');
});

test('a heading hit ranks a note but does not make it about the subject', () => {
  const docs: VaultDoc[] = [
    { path: 'wk.md', title: 'Week 12', tags: [], headings: ['Coffee', 'Tea', 'Water'] },
    { path: 'x.md', title: 'x', tags: [], headings: [] },
  ];
  const ranked = rankVaultDocs('coffee', docs);
  assert.equal(ranked[0]?.path, 'wk.md');
  assert.deepEqual(ranked[0].metaTyped, []);
  const bodies = new Map([['wk.md', 'Coffee: one cup. Tea: two. Water: plenty.'], ['x.md', 'nothing']]);
  const hits = rescoreWithBodies('coffee', ranked, bodies, 5, 0.05);
  assert.equal(hits[0]?.tier, 'mentions');
});

test('a long note does not outrank a short one by holding more words', () => {
  const filler = 'Unrelated paragraph about the weather and the trains. '.repeat(300);
  const bodies = new Map([
    ['long.md', `${filler} React hooks and jsx. ${filler} React again, jsx again, hooks again. ${filler} React, jsx, hooks.`],
    ['short.md', 'React internals: hooks, jsx, fibre. React schedules; hooks order matters; jsx compiles. React, hooks, jsx.'],
    ['x.md', 'tea'],
    ['y.md', 'water'],
  ]);
  const extra = ['hooks', 'jsx'];
  const hits = rescoreWithBodies('react', [], bodies, 5, VAULT_MATCH_MIN, extra);
  assert.equal(hits[0]?.path, 'short.md');
  assert.equal(hits[1]?.path, 'long.md');
});

test('a one-word expansion is one term, whatever the segmenter thinks', () => {
  const bodies = new Map([['a.md', '系统设计面试'], ['b.md', '系统监控与设计评审'], ['c.md', 'tea']]);
  const wt = weightedTerms('system design', bodies, ['系统设计']);
  const names = wt.map((w) => w.t);
  assert.ok(names.includes('系统设计'), names.join(','));
  assert.ok(!names.includes('系统') && !names.includes('设计'), names.join(','));
});

test('a multi-word expansion is a phrase, not its words', () => {
  const bodies = new Map([['a.md', 'the virtual DOM diff'], ['b.md', 'a virtual machine and a DOM tree'], ['c.md', 'tea']]);
  const wt = weightedTerms('react', bodies, ['virtual dom', 'react.js']);
  const names = wt.map((w) => w.t);
  assert.ok(names.includes('virtual dom'), names.join(','));
  assert.ok(!names.includes('virtual') && !names.includes('dom'), names.join(','));
  assert.ok(names.includes('react.js'));
  const t = wt.find((w) => w.t === 'virtual dom')!;
  assert.equal(t.whole, true);
});

test('an expansion makes a note about the subject only if the note names the subject too', () => {
  const docs: VaultDoc[] = [
    { path: 'autocomplete.md', title: 'SD-Autocomplete 组件', tags: [], headings: [] },
    { path: 'w12.md', title: 'W12 UI 组件 I', tags: [], headings: [] },
    { path: 'w17.md', title: 'W17 应用级系统设计 I', tags: [], headings: [] },
    { path: 'a.md', title: 'a', tags: [], headings: [] },
    { path: 'b.md', title: 'b', tags: [], headings: [] },
  ];
  const bodies = new Map([
    ['autocomplete.md', '组件 的接口设计。组件 状态。组件 事件。'],
    ['w12.md', 'React 评分组件、折叠组件、标签页组件。React 的 props。'],
    ['w17.md', '信息流的系统设计。系统设计 要点。系统设计 面试。'],
    ['a.md', '组件 一个'],
    ['b.md', 'tea'],
  ]);
  const react = rescoreWithBodies('我关于 React 写过什么', rankVaultDocs('我关于 React 写过什么', docs, 60, ['组件']), bodies, 8, 0.05, ['组件']);
  const rt = Object.fromEntries(react.map((h) => [h.path, h.tier]));
  assert.equal(rt['autocomplete.md'], 'mentions');
  assert.equal(rt['w12.md'], 'about');
  const sd = rescoreWithBodies('system design', rankVaultDocs('system design', docs, 60, ['系统设计']), bodies, 8, 0.05, ['系统设计']);
  const st = Object.fromEntries(sd.map((h) => [h.path, h.tier]));
  // The expansion is rare here — unique to one note — so it means the subject on its own.
  assert.equal(st['w17.md'], 'about');
});

test('an excerpt window opens around a phrase', () => {
  const body = `${'Filler sentence. '.repeat(60)}The system design round went well.${' More filler. '.repeat(60)}`;
  const out = excerptAround(body, [{ t: 'system design', whole: true }], 300, 80);
  assert.ok(out.includes('system design round'), out.slice(0, 80));
});
