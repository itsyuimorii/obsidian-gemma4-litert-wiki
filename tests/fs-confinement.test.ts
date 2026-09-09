// The plugin writes gigabytes outside the vault API — the model, the WebGPU
// runtime, and the partial downloads of both — because vault.adapter buffers
// a whole file into memory and cannot resume a dropped download from a byte
// offset. That means the Node fs module, and "uses fs" honestly reads as
// "can read and write any file on the system".
//
// It cannot: every path goes through one guard first. These are the cases
// that guard exists for, and a traversal that slipped through would be the
// difference between a plugin that reads its own folder and one that reads
// the user's SSH keys.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fsNode from 'node:fs';
import pathNode from 'node:path';
import { confineFilesystemTo, filesystemRoot, fs } from '../src/node-api.ts';

const ROOT = fsNode.mkdtempSync(pathNode.join(os.tmpdir(), 'gemma-confine-'));
confineFilesystemTo(ROOT);

test('the root is resolved once and cannot be widened later', () => {
  confineFilesystemTo(os.tmpdir());
  assert.equal(filesystemRoot(), pathNode.resolve(ROOT));
});

test('a path inside the plugin folder is allowed', () => {
  const p = pathNode.join(ROOT, 'wasm', 'x.wasm');
  fs.mkdirSync(pathNode.join(ROOT, 'wasm'), { recursive: true });
  fs.writeFileSync(p, 'hello');
  assert.equal(fs.existsSync(p), true);
  assert.equal(fs.statSync(p).size, 5);
  assert.deepEqual(fs.readdirSync(pathNode.join(ROOT, 'wasm')), ['x.wasm']);
});

test('a sibling whose name starts with the root is refused', () => {
  assert.throws(() => fs.existsSync(`${ROOT}-evil/secret`), /outside this plugin/);
});

test('traversal out of the folder is refused, however it is spelled', () => {
  for (const p of [
    pathNode.join(ROOT, '..', 'other', 'notes.md'),
    pathNode.join(ROOT, 'wasm', '..', '..', '..', 'id_rsa'),
    `${ROOT}/./../../etc/passwd`,
    '/etc/passwd',
  ]) {
    assert.throws(() => fs.existsSync(p), /outside this plugin/, p);
    assert.throws(() => fs.writeFileSync(p, 'x'), /outside this plugin/, p);
    assert.throws(() => fs.rmSync(p), /outside this plugin/, p);
    assert.throws(() => fs.createWriteStream(p), /outside this plugin/, p);
  }
});

test('both ends of a rename are checked', () => {
  const ok = pathNode.join(ROOT, 'a');
  fs.writeFileSync(ok, 'x');
  assert.throws(() => fs.renameSync(ok, pathNode.join(ROOT, '..', 'b')), /outside this plugin/);
  assert.throws(() => fs.renameSync(pathNode.join(ROOT, '..', 'b'), ok), /outside this plugin/);
});

test('the async surface refuses too', async () => {
  await assert.rejects(() => fs.promises.rm('/etc/passwd'), /outside this plugin/);
  await assert.rejects(() => fs.promises.stat('/etc/passwd'), /outside this plugin/);
  await assert.rejects(
    () => fs.promises.rename(pathNode.join(ROOT, 'a'), '/tmp/elsewhere'),
    /outside this plugin/
  );
});

test('readFile reports a refusal through its callback, as it reports a missing file', async () => {
  const err = await new Promise<Error | null>((resolve) => {
    fs.readFile('/etc/passwd', (e) => resolve(e));
  });
  assert.match(String(err?.message), /outside this plugin/);
});

test('the root itself is allowed', () => {
  assert.equal(fs.existsSync(ROOT), true);
});
