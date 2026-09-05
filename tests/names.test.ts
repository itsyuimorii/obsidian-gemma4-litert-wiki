// Names: what a tag, a slug and a vault filename are allowed to be.
//
// Every case here is a bug that shipped. The scripts are not decoration — a
// vault written in Chinese, Japanese, Korean, Russian, Greek, Arabic, Hebrew,
// Thai or Devanagari used to collapse to one tag called `untitled` and one
// card called `untitled.md` that every note in turn overwrote.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isUsableTag, safeFileName, slugify } from '../src/pure.ts';

test('slugify keeps letters from every script', () => {
  // The twelve samples that used to collapse to the same string.
  assert.equal(slugify('设计模式'), '设计模式');
  assert.equal(slugify('デザイン'), 'デザイン');
  assert.equal(slugify('디자인'), '디자인');
  assert.equal(slugify('Дизайн'), 'дизайн');
  assert.equal(slugify('Σχεδίαση'), 'σχεδίαση');
  assert.equal(slugify('تصميم'), 'تصميم');
  assert.equal(slugify('עיצוב'), 'עיצוב');
  assert.equal(slugify('ออกแบบ'), 'ออกแบบ');
});

test('slugify keeps the combining marks a word is built out of', () => {
  // The regression this class was added for: dropping \p{M} split the word
  // into `ड-ज-इन`, because the vowel signs are marks rather than letters.
  assert.equal(slugify('डिज़ाइन'), 'डिज़ाइन');
  assert.ok(!slugify('डिज़ाइन').includes('-'), 'no vowel sign was dropped');
});

test('slugify keeps Latin diacritics instead of mangling them', () => {
  assert.equal(slugify('résumé'), 'résumé'); // was `resume`
  assert.equal(slugify('łódź'), 'łódź'); //     was `d`
});

test('slugify is a slug: lower case, hyphen-joined, untrimmed of nothing', () => {
  assert.equal(slugify('LLM Eval'), 'llm-eval');
  assert.equal(slugify('  spaced  out  '), 'spaced-out');
  assert.equal(slugify('---edges---'), 'edges');
  assert.equal(slugify('a/b:c*d?e'), 'a-b-c-d-e');
});

test('slugify never returns the empty string', () => {
  for (const input of ['', '   ', '!!!', '---', '。、！']) {
    assert.equal(slugify(input), 'untitled', JSON.stringify(input));
  }
});

test('slugify is idempotent', () => {
  for (const s of ['LLM Eval', 'डिज़ाइन', '设计 模式', 'résumé', '']) {
    assert.equal(slugify(slugify(s)), slugify(s), s);
  }
});

test('isUsableTag rejects a slug that is only digits and hyphens', () => {
  for (const junk of ['4328', '70-', '#45）', '2026', '---', '', '!!!']) {
    assert.equal(isUsableTag(junk), false, JSON.stringify(junk));
  }
});

test('isUsableTag keeps a tag that merely starts with digits', () => {
  // The line the rule deliberately does not cross: these have the same shape
  // as the junk above, and a rule sharp enough to drop `#45）` drops these too.
  for (const real of ['45-打开对应文件', '2026-回顾', 'llm-eval', '3d-graphics']) {
    assert.equal(isUsableTag(real), true, real);
  }
});

// Vaults sync to Windows, where these characters cannot appear in a filename
// and a name may not end in a dot or a space.
const ILLEGAL = /[\\/:*?"<>|#^[\]\u0000-\u001f]/;

test('safeFileName strips everything a filesystem objects to', () => {
  const nasty = [
    'What is 3/4 of X?',
    'C:\\Users\\me\\notes',
    'a<b>c|d"e*f?g',
    'tag #hashtag ^block [[link]]',
    'trailing dots...',
    '   .leading',
    'bell\u0007and\u0000null',
  ];
  for (const input of nasty) {
    const out = safeFileName(input, 'fallback');
    assert.ok(!ILLEGAL.test(out), `${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
    assert.ok(!/[.\s]$/.test(out), `must not end in a dot or space: ${JSON.stringify(out)}`);
    assert.ok(!/^[.\s]/.test(out), `must not start with a dot or space: ${JSON.stringify(out)}`);
    assert.ok(out.length > 0 && out.length <= 80, `length ${out.length}`);
  }
});

test('safeFileName keeps the words, unlike slugify', () => {
  // The whole reason this is not slugify(): the file lands among someone's
  // own notes, where `2026 roadmap.md` is what a person would have typed.
  assert.equal(safeFileName('2026 roadmap', 'x'), '2026 roadmap');
  assert.equal(safeFileName('How does caching work?', 'x'), 'How does caching work');
});

test('safeFileName falls back when nothing survives', () => {
  for (const empty of ['', '???', '...', '   ', '\u0000\u0001']) {
    assert.equal(safeFileName(empty, 'Untitled question'), 'Untitled question');
  }
});

test('safeFileName caps the length', () => {
  assert.equal(safeFileName('x'.repeat(500), 'f').length, 80);
});
