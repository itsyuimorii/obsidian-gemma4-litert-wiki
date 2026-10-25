import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractionOutputTokens,
  extractionPrompt,
  keyPointTarget,
  noteLanguage,
  splitVocabulary,
  applyTagCheck,
  tagCheckPrompt,
  tagsToVerify,
} from '../src/pure.ts';

const CHINESE_WITH_TERMS = [
  '## 运算符',
  '',
  '- 空值合并运算符 `??` 从一列变量中选取已定义的值。`a ?? b` 的结果是 a，除非 a 为 null。',
  '- **`a&&b`**：a 成立吗？成立就看 b，不成立直接停。',
  '',
  '```js',
  'const result = value ?? fallback; // a long line of code that is all latin letters',
  '```',
].join('\n');

test('noteLanguage: Chinese prose with English terms and code is Chinese', () => {
  assert.equal(noteLanguage(CHINESE_WITH_TERMS), 'Chinese');
});

test('noteLanguage: code blocks do not outvote the prose', () => {
  const code = '```\n' + 'function veryLongEnglishIdentifierName() {}\n'.repeat(40) + '```\n';
  assert.equal(noteLanguage(CHINESE_WITH_TERMS + '\n' + code), 'Chinese');
});

test('noteLanguage: kana makes it Japanese, Hangul Korean, Latin script null', () => {
  assert.equal(noteLanguage('エスプレッソの抽出は二十八秒が目安です。豆の量は十八グラム。'), 'Japanese');
  assert.equal(noteLanguage('에스프레소 추출 시간은 이십팔 초가 기준입니다.'), 'Korean');
  assert.equal(noteLanguage('Espresso extraction takes about 28 seconds with 18 grams.'), null);
  assert.equal(noteLanguage("L'extraction d'un espresso prend environ vingt-huit secondes."), null);
});

test('noteLanguage: a few CJK words in an English note leave it English', () => {
  const note = 'This English note about the API contract mentions 中文 once. '.repeat(10);
  assert.equal(noteLanguage(note), null);
});

test('keyPointTarget: a short note without headings keeps the old minimum of three', () => {
  assert.equal(keyPointTarget('Espresso takes 28 seconds.'), 3);
});

test('keyPointTarget: one point per section, capped at twelve', () => {
  const sections = (n: number) => Array.from({ length: n }, (_, i) => `## Section ${i}\n\nText.\n`).join('\n');
  assert.equal(keyPointTarget(sections(7)), 7);
  assert.equal(keyPointTarget(sections(57)), 12);
});

test('keyPointTarget: headings inside code fences are not sections', () => {
  const note = '## Real\n\n```md\n## not a heading\n## nor this\n## nor this\n## nor this\n```\n';
  assert.equal(keyPointTarget(note), 3);
});

test('keyPointTarget: a long note without headings grows with its length', () => {
  const long = 'A sentence of ordinary English prose about one subject. '.repeat(400);
  assert.ok(keyPointTarget(long) > 5);
  assert.ok(keyPointTarget(long) <= 12);
});

test('extractionOutputTokens: unchanged up to five points, more room past that', () => {
  assert.equal(extractionOutputTokens(3), 768);
  assert.equal(extractionOutputTokens(5), 768);
  assert.ok(extractionOutputTokens(12) > extractionOutputTokens(6));
});

test('splitVocabulary: tags the note names are set apart, nothing is dropped', () => {
  const vocab = ['data-science', 'programming', 'software-architecture', 'javascript'];
  const { named, others } = splitVocabulary(vocab, '# Data types\n\nJavaScript has seven primitive types.');
  assert.deepEqual(named, ['javascript']);
  assert.deepEqual(others, ['data-science', 'programming', 'software-architecture']);
});

test('splitVocabulary: half of a tag is not enough', () => {
  const { named } = splitVocabulary(['data-science'], 'How this API stores user data.');
  assert.deepEqual(named, []);
});

test('splitVocabulary: a word inside another word does not count', () => {
  const { named } = splitVocabulary(['rag', 'coffee'], 'The barista drags the coffee tamper.');
  assert.deepEqual(named, ['coffee']);
});

test('splitVocabulary: a note in another script names nothing and keeps the order', () => {
  const vocab = ['espresso', 'llm-evaluation', 'finance'];
  assert.deepEqual(splitVocabulary(vocab, '复利是利息再生利息。'), { named: [], others: vocab });
});

test('extractionPrompt: names the language, the point count and the ranked tags', () => {
  const p = extractionPrompt({
    note: CHINESE_WITH_TERMS,
    vocabulary: ['data-science', 'javascript'],
    naming: 'singular noun',
  });
  assert.match(p.system, /in Chinese/);
  assert.match(p.system, new RegExp(`About ${p.keyPoints} key_points`));
  assert.match(p.system, /Other tags in the wiki: data-science, javascript\./);
  assert.match(p.system, /convention: singular noun/);
  assert.equal(p.outputTokens, extractionOutputTokens(p.keyPoints));
});

test('extractionPrompt: an empty wiki offers no list and a Latin note no named language', () => {
  const p = extractionPrompt({ note: 'Espresso takes 28 seconds.', vocabulary: [], naming: '' });
  assert.doesNotMatch(p.system, /tags in the wiki/i);
  assert.doesNotMatch(p.system, /convention/);
  assert.match(p.system, /in the language of the note/);
});

test('tagsToVerify: only listed tags the note does not name', () => {
  const vocab = ['data-science', 'software-architecture', 'javascript'];
  assert.deepEqual(tagsToVerify(['javascript', 'data-science', 'three-js'], vocab, ['javascript']), ['data-science']);
  assert.deepEqual(tagsToVerify(['three-js'], vocab, []), []);
});

test('tagCheckPrompt: lists every tag in the reply shape', () => {
  assert.match(tagCheckPrompt(['data-science', 'touchdesigner']), /\{"data-science": true, "touchdesigner": true\}/);
});

test('applyTagCheck: drops only explicit false, keeps order', () => {
  const tags = ['touchdesigner', 'software-architecture', 'arduino'];
  assert.deepEqual(applyTagCheck(tags, { 'software-architecture': false, arduino: true }), ['touchdesigner', 'arduino']);
  assert.deepEqual(applyTagCheck(tags, { 'software-architecture': 'false' }), ['touchdesigner', 'arduino']);
});

test('applyTagCheck: a missing or garbled verdict keeps the tag', () => {
  const tags = ['espresso', 'coffee-brewing'];
  assert.deepEqual(applyTagCheck(tags, {}), tags);
  assert.deepEqual(applyTagCheck(tags, { espresso: 'maybe' }), tags);
});

test('applyTagCheck: a card never ends with no tag', () => {
  assert.deepEqual(applyTagCheck(['data-science', 'programming'], { 'data-science': false, programming: false }), [
    'data-science',
  ]);
});

test('extractionPrompt: a CJK note keeps its tags in English', () => {
  const p = extractionPrompt({ note: CHINESE_WITH_TERMS, vocabulary: [], naming: '' });
  assert.match(p.system, /Tags stay in English/);
  assert.doesNotMatch(extractionPrompt({ note: 'Plain English.', vocabulary: [], naming: '' }).system, /Tags stay/);
});
