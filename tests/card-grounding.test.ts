// Card grounding: what a source note bears out of its card, by matching.
//
// The provenance spot-check asks the model about eight pages. Which eight
// used to be the first eight in file order, every run. Matching every card
// against its note costs nothing and says where to look first.

import test from 'node:test';
import assert from 'node:assert/strict';
import { cardGrounding, mostSuspect, pickForSpotCheck, rankedPlaces } from '../src/pure.ts';

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

// #168. The key-point score measured paraphrase distance: "operations",
// "must", "occur" and "within" were counted as claims, and "read" and
// "write" were dropped as instruction words. A faithful rewording became
// the most suspect point in the wiki on every run.
const TX_NOTE = 'All reads and writes happen inside a transaction.';

test('a faithful paraphrase is not ranked as suspect', () => {
  const g = cardGrounding({ keyPoints: ['All read and write operations must occur within a transaction.'], mentions: [] }, TX_NOTE);
  assert.equal(g.weakestPoint, 1);
  assert.equal(g.suspicion, 0);
});

test('a point the note never made is still ranked as suspect', () => {
  const g = cardGrounding({ keyPoints: ['Deadlocked transactions are retried automatically by the scheduler.'], mentions: [] }, TX_NOTE);
  assert.ok(g.weakestPoint !== null && g.weakestPoint < 0.5, `weakestPoint ${g.weakestPoint}`);
});

// A seeded generator, so the runs below are the same on every machine.
function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The wiki in #168: twelve cards, no two at the same score, eight places.
const TWELVE = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, suspicion: (12 - i) / 10 }));

test('most places still go to the most suspect pages', () => {
  const picked = pickForSpotCheck(TWELVE, 8, seeded(1)).map((p) => p.id);
  assert.equal(picked.length, 8);
  assert.equal(new Set(picked).size, 8);
  assert.deepEqual(picked.slice(0, 5), ['p0', 'p1', 'p2', 'p3', 'p4']);
});

// Each of the seven pages below the top five has three chances in seven per
// run, so the odds that one is still unread after ten runs are under 3%.
test('every page is reached within ten runs, however low it scores', () => {
  const random = seeded(7);
  const seen = new Set<string>();
  for (let run = 0; run < 10; run++) for (const p of pickForSpotCheck(TWELVE, 8, random)) seen.add(p.id);
  assert.equal(seen.size, 12);
});

test('the places left over are not always given to the same pages', () => {
  const random = seeded(3);
  const sets = new Set<string>();
  for (let run = 0; run < 6; run++) sets.add(pickForSpotCheck(TWELVE, 8, random).map((p) => p.id).sort().join(','));
  assert.ok(sets.size > 2, `${sets.size} distinct sets`);
});

test('a small sample is all ranked, and a wiki smaller than the sample is checked whole', () => {
  assert.deepEqual(pickForSpotCheck(TWELVE, 2, seeded(1)).map((p) => p.id), ['p0', 'p1']);
  assert.equal(pickForSpotCheck(TWELVE.slice(0, 5), 8, seeded(1)).length, 5);
  assert.deepEqual(pickForSpotCheck(TWELVE, 0, seeded(1)), []);
});

// The report labels each page "least borne out" or "drawn at random" by its
// position, so the ranked pages have to be the ones that come first.
test('the first rankedPlaces pages of a pick are the ranked ones, whatever the size', () => {
  for (let limit = 0; limit <= 12; limit++) {
    const picked = pickForSpotCheck(TWELVE, limit, seeded(limit + 1)).map((p) => p.id);
    const ranked = rankedPlaces(picked.length);
    const want = TWELVE.slice(0, ranked).map((p) => p.id);
    assert.deepEqual(picked.slice(0, ranked), want, `limit ${limit}`);
  }
  assert.equal(rankedPlaces(8), 5);
  assert.equal(rankedPlaces(2), 2);
  assert.equal(rankedPlaces(0), 0);
});
