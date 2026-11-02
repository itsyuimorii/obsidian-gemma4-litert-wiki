// A bulk delete in the wiki fires one event per page while the rest are still
// going, so the prune sweep can reach a page that is already gone. That must
// read as nothing to do, not as "Prune failed — ENOENT".

import test from 'node:test';
import assert from 'node:assert/strict';
import { isMissingFileError } from '../src/pure.ts';

test('isMissingFileError: the Node error code', () => {
  const err = Object.assign(new Error('open failed'), { code: 'ENOENT' });
  assert.equal(isMissingFileError(err), true);
});

test('isMissingFileError: the message Obsidian passes on', () => {
  const err = new Error("ENOENT: no such file or directory, open '/vault/gemma-wiki/cards/espresso-brew-ratio.md'");
  assert.equal(isMissingFileError(err), true);
});

test('isMissingFileError: any other failure still counts', () => {
  assert.equal(isMissingFileError(Object.assign(new Error('denied'), { code: 'EACCES' })), false);
  assert.equal(isMissingFileError(new Error('disk full')), false);
  assert.equal(isMissingFileError(undefined), false);
});
