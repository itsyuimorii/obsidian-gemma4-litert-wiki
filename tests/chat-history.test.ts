// History: which earlier turns a follow-up is sent with.
//
// The panel looks like a conversation whether or not the model is handed
// one, so nothing on screen says when it is not. These tests are the only
// place that difference shows: a question, an answer, then a fragment that
// means nothing without them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { groundingKeyFor, pickHistory, type HistoryTurn } from '../src/pure.ts';

// One token per word: enough to count a ceiling by hand.
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
const pick = (turns: HistoryTurn[], grounding: string, ceiling = 1000) =>
  pickHistory(turns, grounding, ceiling, words);

const Q1 = 'what is the difference between toString and String()';
const A1 = 'toString is a method and throws on null; String() is a function and does not.';

test('a general question with the search box unticked is remembered by the next one', () => {
  const unticked = { ungrounded: false, wholeWiki: false, mode: 'vault' as const, searchNotes: false, attached: 0, notePath: '' };
  // The exchange is filed under the key its answer was generated with...
  const filedAs = groundingKeyFor(unticked);
  const turns: HistoryTurn[] = [
    { role: 'user', content: Q1, grounding: filedAs },
    { role: 'assistant', content: A1, grounding: filedAs },
  ];
  // ...and "in an interview" asks for the history of the key it will be filed under.
  assert.deepEqual(pick(turns, groundingKeyFor(unticked)), [
    { role: 'user', content: Q1 },
    { role: 'assistant', content: A1 },
  ]);
  // What it used to ask for instead, and what it got.
  assert.deepEqual(pick(turns, 'vault'), []);
});

test('"Ask Gemma anyway" and the unticked box are one thread', () => {
  const hatch = groundingKeyFor({ ungrounded: true, wholeWiki: false, mode: 'vault', searchNotes: true, attached: 0, notePath: '' });
  const unticked = groundingKeyFor({ ungrounded: false, wholeWiki: false, mode: 'vault', searchNotes: false, attached: 0, notePath: '' });
  const turns: HistoryTurn[] = [
    { role: 'user', content: Q1, grounding: hatch },
    { role: 'assistant', content: A1, grounding: hatch },
  ];
  assert.equal(pick(turns, unticked).length, 2);
});

test('turns about other material are left out', () => {
  const turns: HistoryTurn[] = [
    { role: 'user', content: 'summarise this note', grounding: 'note:a.md' },
    { role: 'assistant', content: 'It is about caching.', grounding: 'note:a.md' },
    { role: 'user', content: Q1, grounding: 'direct' },
    { role: 'assistant', content: A1, grounding: 'direct' },
    { role: 'user', content: 'what connects my pages', grounding: 'wiki:all' },
    { role: 'assistant', content: 'Three of them cite the same paper.', grounding: 'wiki:all' },
  ];
  assert.deepEqual(pick(turns, 'direct').map((t) => t.content), [Q1, A1]);
  assert.deepEqual(pick(turns, 'note:a.md').map((t) => t.content), ['summarise this note', 'It is about caching.']);
  assert.deepEqual(pick(turns, 'note:b.md'), []);
});

test('several exchanges come back in the order they were said', () => {
  const turns: HistoryTurn[] = [
    { role: 'user', content: 'one', grounding: 'direct' },
    { role: 'assistant', content: 'first answer', grounding: 'direct' },
    { role: 'user', content: 'two', grounding: 'direct' },
    { role: 'assistant', content: 'second answer', grounding: 'direct' },
  ];
  assert.deepEqual(pick(turns, 'direct').map((t) => t.content), ['one', 'first answer', 'two', 'second answer']);
});

test('over the ceiling the oldest turns go first, and whole exchanges with them', () => {
  const turns: HistoryTurn[] = [
    { role: 'user', content: 'old question here', grounding: 'direct' }, // 3
    { role: 'assistant', content: 'old answer of five words', grounding: 'direct' }, // 5
    { role: 'user', content: 'new question here', grounding: 'direct' }, // 3
    { role: 'assistant', content: 'new answer of five words', grounding: 'direct' }, // 5
  ];
  assert.deepEqual(pick(turns, 'direct', 8).map((t) => t.content), ['new question here', 'new answer of five words']);
  // Room for the old answer but not its question: an answer with no
  // question in front of it is not sent.
  assert.deepEqual(pick(turns, 'direct', 13).map((t) => t.content), ['new question here', 'new answer of five words']);
  assert.equal(pick(turns, 'direct', 16).length, 4);
  // Not even the last answer fits: nothing, rather than a question alone.
  assert.deepEqual(pick(turns, 'direct', 4), []);
});

// At a 4096 context the ceiling is 600 tokens and an answer may be 1024.
// Stopping at the first turn that did not fit left the follow-up to one long
// answer with nothing before it — the symptom 1.0.23 fixed for another cause.
test('an answer longer than the ceiling is shortened, not dropped', () => {
  const long = Array.from({ length: 300 }, (_, i) => `w${i}`).join(' ');
  const turns: HistoryTurn[] = [
    { role: 'user', content: 'old question here', grounding: 'direct' },
    { role: 'assistant', content: 'old answer of five words', grounding: 'direct' },
    { role: 'user', content: Q1, grounding: 'direct' }, // 8
    { role: 'assistant', content: long, grounding: 'direct' }, // 300
  ];
  const picked = pick(turns, 'direct', 100);
  assert.deepEqual(picked.map((t) => t.role), ['user', 'assistant']);
  assert.equal(picked[0].content, Q1);
  // The opening of the answer, marked as cut, and the pair fits the ceiling.
  assert.ok(picked[1].content.startsWith('w0 w1 w2 '));
  assert.ok(picked[1].content.endsWith('…'));
  assert.ok(words(picked[0].content) + words(picked[1].content) <= 100);
  // All the room that was left is used.
  assert.equal(words(picked[1].content), 92);
});

test('only the newest answer is shortened', () => {
  const long = Array.from({ length: 300 }, (_, i) => `w${i}`).join(' ');
  const turns: HistoryTurn[] = [
    { role: 'user', content: 'old question here', grounding: 'direct' },
    { role: 'assistant', content: long, grounding: 'direct' },
    { role: 'user', content: 'new question here', grounding: 'direct' },
    { role: 'assistant', content: 'new answer of five words', grounding: 'direct' },
  ];
  assert.deepEqual(pick(turns, 'direct', 100).map((t) => t.content), ['new question here', 'new answer of five words']);
});

test('an answer is not shortened to a fragment', () => {
  const long = Array.from({ length: 300 }, (_, i) => `w${i}`).join(' ');
  const turns: HistoryTurn[] = [
    { role: 'user', content: Q1, grounding: 'direct' }, // 8
    { role: 'assistant', content: long, grounding: 'direct' },
  ];
  // 8 for the question leaves 39: under the least worth sending.
  assert.deepEqual(pick(turns, 'direct', 47), []);
  assert.equal(pick(turns, 'direct', 48).length, 2);
});

test('a question whose answer never came is not sent as history', () => {
  const turns: HistoryTurn[] = [
    { role: 'user', content: Q1, grounding: 'direct' },
    { role: 'assistant', content: A1, grounding: 'direct' },
    { role: 'user', content: 'this one failed', grounding: 'direct' },
  ];
  assert.deepEqual(pick(turns, 'direct').map((t) => t.content), [Q1, A1]);
});

test('a turn goes back as its historyText when it has one', () => {
  const turns: HistoryTurn[] = [
    { role: 'user', content: 'which notes are about js', grounding: 'vault' },
    { role: 'assistant', content: '- **Closures** ...\n- **Promises** ...', grounding: 'vault', historyText: '(A list of matching notes was shown here.)' },
  ];
  assert.equal(pick(turns, 'vault')[1].content, '(A list of matching notes was shown here.)');
});

test('a two-part Vault answer saved before historyText existed is cut at its second part', () => {
  const turns: HistoryTurn[] = [
    { role: 'user', content: 'closures', grounding: 'vault' },
    {
      role: 'assistant',
      content: 'Your note says a closure keeps its scope.\n\n---\n**Gemma 4 E4B adds (not from your notes):**\n\nClosures are common in JS.',
      grounding: 'vault',
    },
  ];
  assert.equal(pick(turns, 'vault')[1].content, 'Your note says a closure keeps its scope.');
});
