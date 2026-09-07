import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateSettings, SETTINGS_VERSION } from '../src/pure.ts';

const KNOWN = ['settingsVersion', 'wikiDir', 'contextTokens', 'devCommands', 'staleDays'];

test('null (first run) yields a stamped, empty shape and is not marked changed', () => {
  const r = migrateSettings(null, KNOWN);
  assert.deepEqual(r.data, { settingsVersion: SETTINGS_VERSION });
  assert.equal(r.changed, false);
});

test('unversioned data is version 0 and gets stamped', () => {
  const r = migrateSettings({ wikiDir: 'x', contextTokens: 100 }, KNOWN);
  assert.equal(r.data.settingsVersion, SETTINGS_VERSION);
  assert.equal(r.data.wikiDir, 'x');
  assert.equal(r.changed, true);
});

test('0 -> 1 drops keys this build does not know', () => {
  const r = migrateSettings({ wikiDir: 'x', oldRenamedKey: true, another: 3 }, KNOWN);
  assert.equal('oldRenamedKey' in r.data, false);
  assert.equal('another' in r.data, false);
  assert.equal(r.data.wikiDir, 'x');
});

test('lastThread survives even though it has no default', () => {
  const thread = [{ role: 'user', content: 'hi' }];
  const r = migrateSettings({ lastThread: thread }, KNOWN);
  assert.deepEqual(r.data.lastThread, thread);
});

test('current version passes through untouched and unchanged', () => {
  const cur = { settingsVersion: SETTINGS_VERSION, wikiDir: 'x', lastThread: [] };
  const r = migrateSettings(cur, KNOWN);
  assert.deepEqual(r.data, cur);
  assert.equal(r.changed, false);
});

test('a garbage version stamp is treated as 0, not trusted', () => {
  const r = migrateSettings({ settingsVersion: 'lots', junk: 1 }, KNOWN);
  assert.equal(r.data.settingsVersion, SETTINGS_VERSION);
  assert.equal('junk' in r.data, false);
});

test('a future version is left alone rather than downgraded', () => {
  const future = { settingsVersion: SETTINGS_VERSION + 5, wikiDir: 'x', unknownFutureKey: 1 };
  const r = migrateSettings(future, KNOWN);
  assert.deepEqual(r.data, future);
  assert.equal(r.changed, false);
});

test('an array on disk is not an object and is replaced', () => {
  const r = migrateSettings([1, 2], KNOWN);
  assert.deepEqual(r.data, { settingsVersion: SETTINGS_VERSION });
  assert.equal(r.changed, true);
});
