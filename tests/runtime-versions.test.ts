// The runtime keeps the same file names in every release, so each version
// lives in its own folder under wasm/ and an upgrade clears out the others
// (#167). These tests are on which entries count as another version's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { staleRuntimeEntries } from '../src/pure.ts';

test('another version folder is stale, the current one is kept', () => {
  assert.deepEqual(staleRuntimeEntries(['0.15.0', '0.18.0'], '0.18.0'), ['0.15.0']);
});

test('a prerelease folder is a version folder too', () => {
  assert.deepEqual(
    staleRuntimeEntries(['0.19.0-nightly.20261023', '0.18.0'], '0.18.0'),
    ['0.19.0-nightly.20261023']
  );
});

test('runtime files left flat in wasm/ by an older build are stale, partials included', () => {
  const flat = [
    'litertlm_wasm_internal.js',
    'litertlm_wasm_internal.wasm',
    'litertlm_wasm_asyncify_internal.wasm.partial',
    'litertlm_wasm_compat_asyncify_internal.js',
  ];
  assert.deepEqual(staleRuntimeEntries([...flat, '0.18.0'], '0.18.0'), flat);
});

test('anything that is not a runtime file or a version folder is left alone', () => {
  assert.deepEqual(
    staleRuntimeEntries(['package.json', 'notes.md', '.DS_Store', 'backup', '0.18', 'v0.15.0'], '0.18.0'),
    []
  );
});

test('a fresh install has nothing stale', () => {
  assert.deepEqual(staleRuntimeEntries([], '0.18.0'), []);
  assert.deepEqual(staleRuntimeEntries(['0.18.0'], '0.18.0'), []);
});
