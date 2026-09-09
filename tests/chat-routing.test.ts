// Mode routing: the two detectors that let the panel say "wrong mode" and
// offer the right one, instead of leaving a refusal as the last word.
//
// Both are lexical and deliberately narrow. The cost of a miss is one more
// refusal, the same as today. The cost of a false hit is a card offering a
// mode switch under an answer that did not need one — cheap, but it should
// stay rare, so the negatives below matter as much as the positives.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asksAboutOwnNotes, looksLikeRefusal, stripLeadingRefusal } from '../src/pure.ts';

// --- asksAboutOwnNotes -----------------------------------------------------

test('possessive + a word for the vault is about own notes', () => {
  for (const q of [
    "what's in my vault",
    'What is in my vault?',
    'summarise my notes on coffee',
    'what does my wiki say about extraction',
    'which of my files mention WebGPU',
    'list everything in our knowledge base',
    'what have you got in your notes about me',
  ]) assert.ok(asksAboutOwnNotes(q), q);
});

test('the typo from the field is caught', () => {
  assert.ok(asksAboutOwnNotes('my valut has what'));
  assert.ok(asksAboutOwnNotes('what is in my valut'));
});

test('Japanese possessives and locatives are caught', () => {
  for (const q of [
    '私のノートには何がある',
    '私の vault には何が入っていますか',
    'ノートの中で WebGPU に触れているのはどれ',
    '僕のメモには何がありますか',
    'vault には何がある',
    'コーヒーについて私が書いたこと',
  ]) assert.ok(asksAboutOwnNotes(q), q);
});

test('"what did I write" is about own notes', () => {
  assert.ok(asksAboutOwnNotes('what did I write about grind size'));
  assert.ok(asksAboutOwnNotes('which notes have I added this week'));
  assert.ok(asksAboutOwnNotes('What did I save yesterday?'));
});

test('"in the vault / across the wiki" is about own notes', () => {
  assert.ok(asksAboutOwnNotes('what topics come up across the wiki'));
  assert.ok(asksAboutOwnNotes('find contradictions in the whole vault'));
});

test('a question that merely contains the word vault is not', () => {
  for (const q of [
    'explain what an Obsidian vault is',
    'what is a vault in banking',
    'how do I create a new vault',
    'write a note to my landlord',
    'what does a wiki need to stay healthy',
    'Explain, in plain terms: what a KV cache is',
    '',
    '   ',
  ]) assert.equal(asksAboutOwnNotes(q), false, q);
});

// --- looksLikeRefusal ------------------------------------------------------

test('the three refusals from the field are caught', () => {
  assert.ok(looksLikeRefusal(
    'I do not have access to your personal files, notes, or any private "vault." Therefore, I cannot tell you what content is in your vault.'
  ));
  assert.ok(looksLikeRefusal('I did not follow your request. "my valut" is unclear. Could you please ask for it another way?'));
  assert.ok(looksLikeRefusal('The note does not mention grain shortages.'));
});

test('other honest refusals are caught', () => {
  for (const a of [
    'Nothing in your wiki is about this. The four pages filed cover on-device inference.',
    'This is not in your notes.',
    'There is no information about Rome in the material provided.',
    'The pages do not cover water temperature.',
    "I can't find anything about that in the note.",
    'I am unable to determine this from the text.',
    'ノートにはこの話題への言及がありません。',
    'あなたの個人ファイルにはアクセスできません。',
    'ノートには記載がありません。',
    'その点は分かりません。',
  ]) assert.ok(looksLikeRefusal(a), a);
});

test('a real answer is not a refusal, even with a caveat later', () => {
  for (const a of [
    'Finer grounds expose more surface, so water extracts faster — too fine and you cross into bitterness. Your note pins the target window at 18–22%.',
    'The 28.1 s figure is shader compilation, not weight loading, so it is a one-time cost per session.',
    'Three measurements are recorded: cold start, warm prefill, and decode.\n\n' +
      'The note does not mention which GPU was used, ' +
      'but the numbers are consistent with an M-series laptop.',
    'A KV cache stores the keys and values computed for earlier tokens so they are not recomputed.',
    '',
  ]) assert.equal(looksLikeRefusal(a), false, a.slice(0, 40));
});

test('only the opening of the answer is read', () => {
  const good = 'Finer grounds expose more surface. '.repeat(10);
  const late = good + 'I do not have access to your files.';
  assert.equal(looksLikeRefusal(late), false);
});

// --- stripLeadingRefusal ---------------------------------------------------

test('a leading "no access" sentence is dropped when an answer follows', () => {
  const out = stripLeadingRefusal(
    'Since I do not have access to your personal notes, I cannot tell you what you specifically wrote about coffee.\n\n' +
    'However, I can provide you with some general knowledge about coffee.\n\n' +
    '**What is Coffee?**\nCoffee is a beverage made from the roasted seeds of the Coffea plant.'
  );
  assert.ok(out.startsWith('I can provide you with some general knowledge about coffee.'), out.slice(0, 80));
  assert.ok(out.includes('**What is Coffee?**'));
  assert.ok(!/do not have access/.test(out));
});

test('a bare refusal is returned untouched', () => {
  const bare = 'I do not have access to your personal notes or wiki.';
  assert.equal(stripLeadingRefusal(bare), bare);
});

test('an answer that does not open with a refusal is returned untouched', () => {
  const good = 'Coffee is a beverage made from roasted seeds.\n\nIt originated in Ethiopia.';
  assert.equal(stripLeadingRefusal(good), good);
});

test('a refusal in the first sentence of a run-on paragraph is dropped', () => {
  const out = stripLeadingRefusal('I cannot see your notes. Coffee is a beverage made from roasted seeds, brewed hot or cold, and drunk worldwide.');
  assert.ok(out.startsWith('Coffee is a beverage'), out);
});

test('Chinese refusals are caught again', () => {
  for (const a of ['笔记中没有提到这个话题。', '无法访问您的个人文件。', '根据您提供的笔记内容，没有明确提到"js"这个词汇的笔记。'])
    assert.ok(looksLikeRefusal(a), a);
});
