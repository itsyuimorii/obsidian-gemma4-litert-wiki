// Card grounding: what a source note bears out of its card, by matching.
//
// The provenance spot-check asks the model about eight pages. Which eight
// used to be the first eight in file order, every run. Matching every card
// against its note costs nothing and says where to look first.

import test from 'node:test';
import assert from 'node:assert/strict';
import { cardGrounding, mostSuspect } from '../src/pure.ts';

const NOTE =
  'The perfect espresso shot uses 18 grams of coffee and extracts for 28 seconds. ' +
  'A burr grinder gives an even grind. WebGPU has nothing to do with it.';

test('a mention the note uses is found, whatever its case or spacing', () => {
  const g = cardGrounding({ keyPoints: [], mentions: ['Espresso', 'burr grinder', 'Web GPU', 'web-gpu'] }, NOTE);
  assert.deepEqual(g.missingMentions, []);
  assert.equal(g.suspicion, 0);
});

test('a mention the note never uses is reported', () => {
  const g = cardGrounding({ keyPoints: [], mentions: ['espresso', 'La Marzocco', ' '] }, NOTE);
  assert.deepEqual(g.missingMentions, ['La Marzocco']);
  // One of two real mentions; the blank one is not a mention.
  assert.equal(g.suspicion, 0.5);
});

test("a mention that is only in the note's name is found", () => {
  const card = { keyPoints: [], mentions: ['Pour-over guide'] };
  assert.deepEqual(cardGrounding(card, NOTE).missingMentions, ['Pour-over guide']);
  assert.deepEqual(cardGrounding(card, NOTE, 'Pour over guide').missingMentions, []);
});

test('a key point the note supports scores high, and one it does not scores low', () => {
  const faithful = cardGrounding({ keyPoints: ['Espresso extraction takes 28 seconds with 18 grams of coffee.'], mentions: [] }, NOTE);
  const invented = cardGrounding({ keyPoints: ['Milk should be steamed to sixty degrees for a latte.'], mentions: [] }, NOTE);
  assert.ok(faithful.weakestPoint !== null && faithful.weakestPoint >= 0.8, `faithful: ${faithful.weakestPoint}`);
  assert.ok(invented.weakestPoint !== null && invented.weakestPoint <= 0.2, `invented: ${invented.weakestPoint}`);
  assert.ok(invented.suspicion > faithful.suspicion);
});

test('the weakest key point is the one that counts', () => {
  const g = cardGrounding(
    {
      keyPoints: ['A burr grinder gives an even grind.', 'Milk should be steamed to sixty degrees for a latte.'],
      mentions: [],
    },
    NOTE
  );
  assert.ok(g.weakestPoint !== null && g.weakestPoint <= 0.2);
});

test('a card in one script about a note in another is not scored on its words', () => {
  const japanese = '完璧なエスプレッソは18グラムのコーヒーを使い、28秒で抽出します。グラインダーは均一な挽き目を作ります。';
  const g = cardGrounding({ keyPoints: ['Espresso extraction takes 28 seconds with 18 grams of coffee.'], mentions: [] }, japanese);
  assert.equal(g.weakestPoint, null);
  assert.equal(g.suspicion, 0);
  // The mention check still stands: a name is a name in any script.
  assert.deepEqual(cardGrounding({ keyPoints: [], mentions: ['エスプレッソ', 'ラテ'] }, japanese).missingMentions, ['ラテ']);
});

test('a key point too short to compare is left out', () => {
  assert.equal(cardGrounding({ keyPoints: ['Espresso.'], mentions: [] }, NOTE).weakestPoint, null);
});

test('the most suspect pages come first', () => {
  const pages = [
    { id: 'clean', suspicion: 0 },
    { id: 'bad', suspicion: 1.4 },
    { id: 'worse', suspicion: 2 },
  ];
  assert.deepEqual(mostSuspect(pages, 2, () => 0).map((p) => p.id), ['worse', 'bad']);
  assert.deepEqual(mostSuspect(pages, 0), []);
});

// Most cards tie at zero. Breaking that tie by file order is how the check
// came to read the same eight pages on every run.
test('pages that tie are not always taken in the same order', () => {
  const pages = ['a', 'b', 'c', 'd'].map((id) => ({ id, suspicion: 0 }));
  const forwards = [0.1, 0.2, 0.3, 0.4];
  const backwards = [0.4, 0.3, 0.2, 0.1];
  const pick = (rolls: number[]) => {
    let i = 0;
    return mostSuspect(pages, 2, () => rolls[i++]).map((p) => p.id);
  };
  assert.deepEqual(pick(forwards), ['a', 'b']);
  assert.deepEqual(pick(backwards), ['d', 'c']);
});
