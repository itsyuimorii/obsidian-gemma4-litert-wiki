// Korean questions (#169).
//
// Korean attaches particles to the noun, so the word in a question is
// rarely the string in a note: the question says 로스팅에, the note says
// 로스팅을. And with no Korean stopwords, the grammar of the question —
// 대해, 쓴, 노트는, 어느 — was weighted like its subject, so the note that
// happened to use those words won.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  asksAboutOwnNotes,
  cardGrounding,
  looksLikeCollectionQuery,
  looksLikeListQuery,
  looksLikeRecentQuery,
  looksLikeRefusal,
  queryTerms,
  rankVaultDocs,
  rescoreWithBodies,
} from '../src/pure.ts';

const COFFEE =
  '커피 로스팅은 생두를 가열해 향을 만드는 과정이다. 로스팅을 길게 하면 쓴맛이 강해지고 ' +
  '산미는 줄어든다. 라이트 로스팅은 과일 향이 남는다.';
// Uses the words of the question's grammar in ordinary prose.
const SLEEP =
  '수면과 기억에 대해 쓴 노트는 많지 않다. 어느 날 밤 잠을 충분히 자면 기억이 정리된다는 ' +
  '연구를 읽었다. 깊은 수면 단계에서 해마가 낮의 기억을 다시 재생한다.';
const INTEREST =
  '복리는 이자에 다시 이자가 붙는 구조이다. 원금이 클수록, 기간이 길수록 효과가 커진다. ' +
  '72의 법칙으로 두 배가 되는 기간을 어림한다.';
const BODIES = new Map([
  ['coffee-roasting.md', COFFEE],
  ['sleep-and-memory.md', SLEEP],
  ['compound-interest.md', INTEREST],
]);

const QUESTION = '커피 로스팅에 대해 쓴 노트는 어느 것인가요';

test('a Korean question is searched on its subject, not its grammar', () => {
  assert.deepEqual(queryTerms(QUESTION), ['커피', '로스팅']);
});

test('the note about the subject wins, not the note that shares the grammar', () => {
  const hits = rescoreWithBodies(QUESTION, [], BODIES);
  assert.equal(hits[0]?.path, 'coffee-roasting.md');
  assert.ok(!hits.some((h) => h.path === 'sleep-and-memory.md'), JSON.stringify(hits));
});

test('particles come off the noun', () => {
  assert.deepEqual(queryTerms('수면과 기억을'), ['수면', '기억']);
  assert.deepEqual(queryTerms('로스팅에서는'), ['로스팅']);
  assert.deepEqual(queryTerms('노트들은'), []);
});

test('a short word that only looks like it ends in a particle keeps its last syllable', () => {
  // 사과 is "apple", not 사 with 과 attached.
  assert.deepEqual(queryTerms('사과'), ['사과']);
  assert.deepEqual(queryTerms('복리'), ['복리']);
});

test('what kind of Korean question it is, is recognised', () => {
  assert.equal(looksLikeListQuery(QUESTION), true);
  assert.equal(looksLikeListQuery('어떤 노트가 커피에 관한 거야'), true);
  assert.equal(asksAboutOwnNotes('내 노트에서 수면에 관한 것은?'), true);
  assert.equal(looksLikeRecentQuery('최근에 쓴 노트'), true);
  assert.equal(looksLikeRecentQuery('이번 주에 추가한 메모 보여줘'), true);
  assert.equal(looksLikeCollectionQuery('노트들 사이의 연결은?'), true);
  assert.equal(looksLikeCollectionQuery('내 노트에서 빠진 것은?'), true);
});

test('a plain Korean question about a subject is none of those', () => {
  const q = '커피 로스팅 온도는 몇 도가 좋아?';
  assert.equal(looksLikeListQuery(q), false);
  assert.equal(asksAboutOwnNotes(q), false);
  assert.equal(looksLikeRecentQuery(q), false);
  assert.equal(looksLikeCollectionQuery(q), false);
});

test('a Korean refusal is recognised, and a Korean answer is not', () => {
  assert.equal(looksLikeRefusal('노트에는 커피에 대한 언급이 없습니다.'), true);
  assert.equal(looksLikeRefusal('죄송하지만 해당 정보를 찾을 수 없습니다.'), true);
  assert.equal(looksLikeRefusal('제공된 자료에 포함되어 있지 않습니다.'), true);
  assert.equal(looksLikeRefusal('질문이 명확하지 않습니다. 다시 말씀해 주세요.'), true);
  assert.equal(looksLikeRefusal('로스팅을 길게 하면 쓴맛이 강해지고 산미는 줄어듭니다.'), false);
});

test('a faithful Korean key point is borne out by its note', () => {
  const g = cardGrounding({ keyPoints: ['라이트 로스팅에서는 과일 향이 남는다.'], mentions: ['로스팅'] }, COFFEE);
  assert.equal(g.weakestPoint, 1);
  assert.deepEqual(g.missingMentions, []);
  const invented = cardGrounding({ keyPoints: ['다크 로스팅은 카페인 함량을 크게 높인다.'], mentions: [] }, COFFEE);
  assert.ok(invented.weakestPoint !== null && invented.weakestPoint < 0.5, `weakestPoint ${invented.weakestPoint}`);
});

test('a particle left behind by a Latin word is not a term', () => {
  // ICU splits React에서 into React and 에서.
  assert.deepEqual(queryTerms('React에서 상태 관리'), ['react', '상태', '관리']);
  assert.deepEqual(queryTerms('GPU로'), ['gpu']);
});

test('technical words that share a form with collection words keep their questions searchable', () => {
  for (const q of ['디자인 패턴에 대해 쓴 노트', '데이터베이스 연결 풀 설정', '깃 충돌 해결 방법', '파일 검색 알고리즘']) {
    assert.equal(looksLikeCollectionQuery(q), false, q);
    assert.equal(looksLikeListQuery(q), false, q);
  }
  assert.deepEqual(queryTerms('데이터베이스 연결'), ['데이터베이스', '연결']);
});

test('a Korean question finds the note by its title and tags', () => {
  const docs = [
    { path: 'sleep.md', title: '수면과 기억', tags: ['건강'], headings: [] },
    { path: 'roasting.md', title: '커피 로스팅 기초', tags: ['커피'], headings: ['로스팅 단계'] },
  ];
  assert.equal(rankVaultDocs(QUESTION, docs)[0]?.path, 'roasting.md');
  assert.equal(rankVaultDocs('수면에 관한 노트', docs)[0]?.path, 'sleep.md');
});
