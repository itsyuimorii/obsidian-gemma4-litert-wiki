// manifest.json, checked in milliseconds and with nothing built.
//
// scripts/check-release.mjs is the fuller gate and stays the authority on the
// release payload — but it reads main.js, so it only runs after a build, which
// means it does not run while you are working. These four facts are the ones
// that actually broke: the file was patched into invalid JSON twice by two
// sessions editing it at once, and the word "Obsidian" in the description
// failed the store's automated review on 1.0.2. They are worth failing fast.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const raw = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');

test('manifest.json is valid JSON', () => {
  assert.doesNotThrow(() => JSON.parse(raw));
});

test('the description fits the store limit', () => {
  const { description } = JSON.parse(raw);
  assert.ok(typeof description === 'string' && description.length > 0, 'missing');
  assert.ok(description.length <= 250, `${description.length} characters, limit is 250`);
});

test('the description is one line', () => {
  assert.ok(!/[\r\n]/.test(JSON.parse(raw).description));
});

test('neither the name nor the description says "Obsidian"', () => {
  // The directory rejects it outright: the word is implied by the context of
  // a plugin directory, and the automated review fails the release over it.
  const m = JSON.parse(raw);
  assert.ok(!/obsidian/i.test(m.description), 'description');
  assert.ok(!/obsidian/i.test(m.name), 'name');
  assert.ok(!/obsidian/i.test(m.id), 'id');
});

test('every version-carrying file agrees', () => {
  // A staged manifest.json riding into someone else's commit is how these
  // drift apart, and the store then installs one version's manifest beside
  // another version's code.
  const m = JSON.parse(raw);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(pkg.version, m.version, 'package.json');
  assert.equal(lock.version, m.version, 'package-lock.json');
  assert.equal(lock.packages?.['']?.version, m.version, 'package-lock packages[""]');
});
