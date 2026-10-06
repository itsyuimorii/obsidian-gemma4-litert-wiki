// Follow-ups: what a fragment is searched as.
//
// The model is handed the earlier turns, so it knows what "in an interview"
// continues. The search is not a model: it matched the fragment's own words,
// found interview notes or nothing, and the answer was grounded in the wrong
// material before the model read a word of history. A short question is
// searched together with the one before it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { followUpQuery, groundingKeyFor } from '../src/pure.ts';

const FIRST = 'toString vs String() difference';

test('a fragment is searched with the question it continues', () => {
  assert.equal(followUpQuery('and for arrays?', FIRST), `${FIRST} and for arrays?`);
  assert.equal(followUpQuery('in an interview', FIRST), `${FIRST} in an interview`);
  assert.equal(followUpQuery('why?', FIRST), `${FIRST} why?`);
});

test('a question long enough to name its own subject is searched alone', () => {
  const q = 'what is the difference between toString and String()';
  assert.equal(followUpQuery(q, 'how do closures capture variables'), q);
  assert.equal(followUpQuery('What did I write about coffee', FIRST), 'What did I write about coffee');
});

test('nothing before it, or only itself before it, leaves the question as typed', () => {
  assert.equal(followUpQuery('in an interview', undefined), 'in an interview');
  assert.equal(followUpQuery('in an interview', '  '), 'in an interview');
  // "Ask anyway" and Regenerate re-ask the same words.
  assert.equal(followUpQuery('in an interview', 'in an interview'), 'in an interview');
});

test('a question about the vault itself is not a follow-up to a subject', () => {
  for (const q of ['what did I write recently', 'which notes are about js']) {
    assert.equal(followUpQuery(q, FIRST), q);
  }
});

// The thread a question is filed under and the thread its history is read
// from have to be the same thread. With the search box unticked they were
// not: the turn was recorded as 'direct' and the next question asked for the
// history of 'vault', so every follow-up to a general question arrived alone.
test('Vault with the search box unticked reads the thread it writes to', () => {
  const base = { ungrounded: false, wholeWiki: false, mode: 'vault' as const, notePath: '' };
  assert.equal(groundingKeyFor({ ...base, searchNotes: false, attached: 0 }), 'direct');
  // Attached notes are still read, so that answer is grounded.
  assert.equal(groundingKeyFor({ ...base, searchNotes: false, attached: 1 }), 'vault');
  assert.equal(groundingKeyFor({ ...base, searchNotes: true, attached: 0 }), 'vault');
});

test('the other threads keep their keys', () => {
  const base = { ungrounded: false, wholeWiki: false, searchNotes: true, attached: 0, notePath: 'a/b.md' };
  assert.equal(groundingKeyFor({ ...base, mode: 'vault', ungrounded: true }), 'direct');
  assert.equal(groundingKeyFor({ ...base, mode: 'wiki' }), 'wiki');
  assert.equal(groundingKeyFor({ ...base, mode: 'wiki', wholeWiki: true }), 'wiki:all');
  assert.equal(groundingKeyFor({ ...base, mode: 'note' }), 'note:a/b.md');
});
