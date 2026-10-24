// The interface languages (#166). Every file in src/texts/ is held to the
// keys of en.ts here, so a new language is tested by adding its file and
// nothing else.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { activeLanguage, resolveLanguage, setLanguage, t, tn } from '../src/i18n.ts';
import { EN_TEXTS, en } from '../src/texts/en.ts';
import { LANGUAGES, type Language } from '../src/texts/index.ts';

const TEXTS_DIR = join(import.meta.dirname, '..', 'src', 'texts');
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

async function languageFiles(): Promise<{ file: string; language: Language }[]> {
  const out: { file: string; language: Language }[] = [];
  for (const file of readdirSync(TEXTS_DIR).filter((f) => f.endsWith('.ts') && f !== 'index.ts')) {
    const mod = (await import(join(TEXTS_DIR, file))) as Record<string, unknown>;
    const language = Object.values(mod).find(
      (v): v is Language => !!v && typeof v === 'object' && 'code' in v && 'texts' in v
    );
    assert.ok(language, `${file} exports no language`);
    out.push({ file, language });
  }
  return out;
}

test('every language file has exactly the keys of en.ts', async () => {
  const want = Object.keys(EN_TEXTS).sort();
  for (const { file, language } of await languageFiles()) {
    const have = Object.keys(language.texts).sort();
    const missing = want.filter((k) => !have.includes(k));
    const extra = have.filter((k) => !want.includes(k));
    assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, file);
  }
});

test('every language file is in the language list, under its file name', async () => {
  const listed = LANGUAGES.map((l) => l.code).sort();
  const files = (await languageFiles()).map(({ file, language }) => {
    assert.equal(`${language.code}.ts`, file);
    return language.code;
  });
  assert.deepEqual(listed, files.sort());
});

test('a translation keeps every placeholder of the English text', async () => {
  for (const { file, language } of await languageFiles()) {
    for (const [key, english] of Object.entries(EN_TEXTS)) {
      const text = language.texts[key as keyof typeof EN_TEXTS];
      if (text === undefined) continue;
      assert.deepEqual(placeholders(text), placeholders(english), `${file} ${key}`);
      assert.equal(text.includes('{b}'), english.includes('{b}'), `${file} ${key}`);
    }
  }
});

test('a count key comes as a .one and .other pair', () => {
  const keys = Object.keys(EN_TEXTS);
  for (const key of keys) {
    const m = /^(.*)\.(one|other)$/.exec(key);
    if (!m) continue;
    assert.ok(keys.includes(`${m[1]}.one`) && keys.includes(`${m[1]}.other`), key);
  }
});

test('the setting wins when it names a language there is a file for', () => {
  assert.equal(resolveLanguage('ja', 'en').code, 'ja');
  assert.equal(resolveLanguage('zh', 'ja').code, 'zh');
  assert.equal(resolveLanguage('en', 'zh').code, 'en');
});

test('auto follows Obsidian, by exact code and then by its base', () => {
  assert.equal(resolveLanguage('auto', 'ja').code, 'ja');
  assert.equal(resolveLanguage('auto', 'zh').code, 'zh');
  assert.equal(resolveLanguage('auto', 'zh-TW').code, 'zh');
  assert.equal(resolveLanguage('auto', 'de').code, 'en');
  assert.equal(resolveLanguage('auto', '').code, 'en');
});

test('a setting naming a language with no file falls back to Obsidian', () => {
  assert.equal(resolveLanguage('fr', 'ja').code, 'ja');
});

test('t fills placeholders and leaves unknown ones as written', () => {
  setLanguage(en);
  assert.equal(t('chat.saved', { path: 'a/b.md' }), 'Saved: a/b.md');
  assert.equal(t('chat.saved'), 'Saved: {path}');
});

test('tn picks the form for the count', () => {
  setLanguage(en);
  assert.equal(tn('chat.context.note', 1), 'Your notes · 1 file');
  assert.equal(tn('chat.context.note', 379), 'Your notes · 379 files');
  assert.equal(tn('chat.history.meta', 2, { mode: 'Vault', when: 'now' }), 'Vault · 2 questions · now');
});

test('a key a language lacks shows the English text', () => {
  const partial: Language = { code: 'xx', name: 'Test', texts: { 'chat.stop': 'XSTOP' } };
  setLanguage(partial);
  try {
    assert.equal(t('chat.stop'), 'XSTOP');
    assert.equal(t('chat.send'), 'Send (Enter)');
  } finally {
    setLanguage(en);
  }
  assert.equal(activeLanguage().code, 'en');
});

test('switching language changes the text', () => {
  const ja = LANGUAGES.find((l) => l.code === 'ja')!;
  setLanguage(ja);
  try {
    assert.notEqual(t('chat.stop'), 'Stop');
  } finally {
    setLanguage(en);
  }
});
