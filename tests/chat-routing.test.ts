// Mode routing: the two detectors that let the panel say "wrong mode" and
// offer the right one, instead of leaving a refusal as the last word.
//
// Both are lexical and deliberately narrow. The cost of a miss is one more
// refusal, the same as today. The cost of a false hit is a card offering a
// mode switch under an answer that did not need one — cheap, but it should
// stay rare, so the negatives below matter as much as the positives.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asksAboutOwnNotes, looksLikeRefusal } from '../src/pure.ts';

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

test('the typo and the romanisation from the field are caught', () => {
  assert.ok(asksAboutOwnNotes('我的valut'));
  assert.ok(asksAboutOwnNotes('wo de vault 里有什么内容'));
  assert.ok(asksAboutOwnNotes('my valut has what'));
});

test('CJK possessives and locatives are caught', () => {
  for (const q of [
    '我的笔记里有什么',
    '我的vault里有什么内容',
    '筆記中提到 WebGPU 的有哪些',
    '私のノートには何がありますか',
    'vault 里有什么',
    '我写过什么关于咖啡的',
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
  assert.ok(looksLikeRefusal('I did not follow your request. "我的valut" is unclear. Could you please ask for it another way?'));
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
    '笔记中没有提到这个话题。',
    '无法访问您的个人文件。',
    'ノートには記載がありません。',
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
