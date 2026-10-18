// Chat history: what a past thread keeps, what it is called, and how many
// survive. The panel only draws these; every rule about what is kept lives in
// src/chat-archive.ts and is checked here.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveThread,
  capThread,
  HISTORY_LIMIT,
  parseHistory,
  removeThread,
  threadMode,
  threadTitle,
  type ArchivedThread,
} from '../src/chat-archive.ts';
import type { ChatTurnRecord } from '../src/wiki-store.ts';

const q = (content: string, grounding = 'note:a.md'): ChatTurnRecord => ({ role: 'user', content, grounding });
const a = (content: string, grounding = 'note:a.md'): ChatTurnRecord => ({ role: 'assistant', content, grounding });

test('a thread is capped to its most recent turns and never opens on an answer', () => {
  const turns: ChatTurnRecord[] = [];
  for (let i = 0; i < 15; i++) turns.push(q(`q${i}`), a(`a${i}`));
  const kept = capThread(turns);
  assert.equal(kept.length, 20);
  assert.equal(kept[0].role, 'user');
  assert.equal(kept[0].content, 'q5');
  assert.equal(kept.at(-1)?.content, 'a14');
});

test('a thread over the character ceiling loses its oldest turns first', () => {
  const big = 'x'.repeat(25_000);
  const kept = capThread([q('first'), a(big), q('second'), a(big), q('third'), a(big)]);
  assert.ok(kept.reduce((n, t) => n + t.content.length, 0) <= 60_000);
  assert.equal(kept[0].role, 'user');
  assert.equal(kept.at(-1)?.content, big);
});

test('the title is the first question, on one line, cut at 80 characters', () => {
  assert.equal(threadTitle([q('  what   is\nV60 grind? '), a('fine')]), 'what is V60 grind?');
  const long = 'word '.repeat(40);
  const title = threadTitle([q(long), a('ok')]);
  assert.equal(title.length, 80);
  assert.ok(title.endsWith('…'));
  assert.equal(threadTitle([a('orphan')]), 'Untitled chat');
});

test('the mode is the one the thread was last answered in', () => {
  assert.equal(threadMode([q('x', 'note:a.md'), a('y', 'note:a.md')]), 'note');
  assert.equal(threadMode([q('x', 'note:a.md'), a('y', 'wiki:all')]), 'wiki');
  assert.equal(threadMode([q('x', 'vault'), a('y', 'vault')]), 'vault');
  // Gemma on its own is asked from Vault, so that is where it goes back to.
  assert.equal(threadMode([q('x', 'direct'), a('y', 'direct')]), 'vault');
  assert.equal(threadMode([q('x')].map((t) => ({ ...t, grounding: undefined }))), 'note');
});

test('archiving puts the thread first and drops a question left unanswered', () => {
  const history = archiveThread([], [q('one'), a('first answer'), q('stopped halfway')], 1000, () => 'id1');
  assert.equal(history.length, 1);
  assert.deepEqual(
    history[0].turns.map((t) => t.content),
    ['one', 'first answer']
  );
  assert.equal(history[0].title, 'one');
  assert.equal(history[0].savedAt, 1000);
  assert.equal(history[0].id, 'id1');
});

test('a thread with no answer is not archived at all', () => {
  const before: ArchivedThread[] = [];
  assert.equal(archiveThread(before, [q('nothing came back')], 1, () => 'x'), before);
  assert.equal(archiveThread(before, [], 1, () => 'x'), before);
});

test('history keeps the most recent threads only', () => {
  let history: ArchivedThread[] = [];
  for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
    history = archiveThread(history, [q(`q${i}`), a('a')], i, () => `id${i}`);
  }
  assert.equal(history.length, HISTORY_LIMIT);
  assert.equal(history[0].title, `q${HISTORY_LIMIT + 4}`);
  assert.equal(history.at(-1)?.title, 'q5');
});

test('removing a thread leaves the others in order', () => {
  let history: ArchivedThread[] = [];
  for (const id of ['a', 'b', 'c']) history = archiveThread(history, [q(id), a('x')], 0, () => id);
  assert.deepEqual(removeThread(history, 'b').map((t) => t.id), ['c', 'a']);
  assert.equal(removeThread(history, 'missing').length, 3);
});

test('a history file that is damaged reads as what can be salvaged from it', () => {
  assert.deepEqual(parseHistory(null), []);
  assert.deepEqual(parseHistory('not json'), []);
  assert.deepEqual(parseHistory('{"threads": 3}'), []);
  const good = { id: 'g', title: 'kept', mode: 'wiki', savedAt: 5, turns: [q('x'), a('y')] };
  const raw = JSON.stringify({
    version: 1,
    threads: [good, { id: 'no turns', title: 't', mode: 'note', savedAt: 1, turns: [] }, { nonsense: true }],
  });
  assert.deepEqual(parseHistory(raw), [good]);
  // An unknown mode is read as This note rather than dropping the thread.
  const odd = JSON.stringify({ version: 1, threads: [{ ...good, mode: 'direct' }] });
  assert.equal(parseHistory(odd)[0].mode, 'note');
});
