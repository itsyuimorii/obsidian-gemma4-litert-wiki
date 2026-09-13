// The wording is the product here.
//
// The only outside bug report this plugin has ever had was a fresh install
// that did nothing: a runtime file was missing, the failure landed before
// the model prompt, and the user saw `Cannot find module …`. They never came
// back. There is no telemetry to tell us how often that happened, so the
// substitute is a plugin that examines itself and says what to do in a
// sentence. These tests are on the sentence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, diagnosisBlocks, formatDiagnostics, MODEL_BYTES_APPROX, type DiagnosticFacts } from '../src/pure.ts';

const HEALTHY: DiagnosticFacts = {
  webgpu: { ok: true, detail: 'Adapter found. {"vendor":"apple"}' },
  freeBytes: 200e9,
  modelBytes: 3.1e9,
  runtimeBytes: 24e6,
  desktop: true,
  obsidianVersion: '1.11.4',
  pluginVersion: '1.0.17',
  platform: 'darwin',
};

const by = (f: DiagnosticFacts) => Object.fromEntries(diagnose(f).map((c) => [c.name, c]));

test('a working install reports five checks, all ok, and nothing to do', () => {
  const checks = diagnose(HEALTHY);
  assert.equal(checks.length, 5);
  assert.ok(checks.every((c) => c.status === 'ok'), JSON.stringify(checks));
  assert.equal(diagnosisBlocks(checks), false);
  assert.ok(checks.every((c) => c.fix === undefined));
});

test('a fresh install is not broken, it is unfinished', () => {
  // The state ansible42 was in, minus the bug: nothing downloaded yet.
  const fresh = { ...HEALTHY, modelBytes: undefined, runtimeBytes: 0 };
  const c = by(fresh);
  assert.equal(c.Runtime.status, 'warn');
  assert.equal(c.Model.status, 'warn');
  // Nothing is failing, so the report must not read like a fault.
  assert.equal(diagnosisBlocks(diagnose(fresh)), false);
  assert.match(c.Runtime.fix ?? '', /normal before first use/);
});

test('a half-downloaded runtime is a fault, and the fix is to delete it', () => {
  const c = by({ ...HEALTHY, runtimeBytes: 900_000 });
  assert.equal(c.Runtime.status, 'fail');
  assert.match(c.Runtime.detail, /interrupted/);
  assert.match(c.Runtime.fix ?? '', /Delete the wasm\/ folder/);
});

test('no WebGPU is the one failure that makes everything else moot', () => {
  const c = by({ ...HEALTHY, webgpu: { ok: false, detail: 'requestAdapter() resolved to null.' } });
  assert.equal(c.WebGPU.status, 'fail');
  assert.match(c.WebGPU.fix ?? '', /Vulkan/);
  assert.match(c.WebGPU.fix ?? '', /nothing else here can work/);
});

test('mobile is refused in the report, not left to fail later', () => {
  const c = by({ ...HEALTHY, desktop: false });
  assert.equal(c.Platform.status, 'fail');
  assert.match(c.Platform.fix ?? '', /no mobile path/);
});

test('disk space is judged against what is still left to download', () => {
  const empty = { ...HEALTHY, modelBytes: undefined };
  assert.equal(by({ ...empty, freeBytes: 10e9 })['Disk space'].status, 'ok');
  assert.equal(by({ ...empty, freeBytes: 1e9 })['Disk space'].status, 'fail');
  // A partial download already on disk lowers what is still needed.
  const nearlyDone = { ...empty, partialBytes: MODEL_BYTES_APPROX - 0.4e9 };
  assert.equal(by({ ...nearlyDone, freeBytes: 1e9 })['Disk space'].status, 'ok');
});

test('space is not demanded again once the model is there', () => {
  const c = by({ ...HEALTHY, freeBytes: 0.2e9 });
  assert.equal(c['Disk space'].status, 'ok');
  assert.match(c['Disk space'].detail, /already downloaded/);
});

test('an unreadable volume is a note, not a failure', () => {
  const c = by({ ...HEALTHY, freeBytes: undefined, modelBytes: undefined });
  assert.equal(c['Disk space'].status, 'warn');
  assert.equal(diagnosisBlocks(diagnose({ ...HEALTHY, freeBytes: undefined })), false);
});

test('a resumable partial says it resumes, because the fear is starting over', () => {
  const c = by({ ...HEALTHY, modelBytes: undefined, partialBytes: 1.2e9 });
  assert.equal(c.Model.status, 'warn');
  assert.match(c.Model.detail, /1\.20 GB/);
  assert.match(c.Model.fix ?? '', /resumes from where it stopped/);
});

test('the pasteable report carries versions and findings, and no vault content', () => {
  const broken = { ...HEALTHY, webgpu: { ok: false, detail: 'navigator.gpu is not present.' }, modelBytes: undefined, runtimeBytes: 0 };
  const text = formatDiagnostics(broken, diagnose(broken));
  assert.match(text, /^Gemma 4 E4B LLM Wiki 1\.0\.17 on Obsidian 1\.11\.4 \(darwin\)/);
  assert.match(text, /\[FAIL\] WebGPU/);
  assert.match(text, /\[note\] Model/);
  assert.match(text, /What to do:/);
  // No paths: a user forwarding this should not have to audit it first.
  assert.ok(!/\//.test(text.replace(/wasm\/|requestAdapter\(\)|\bn\/a\b/g, '')), text);
});

test('a healthy report has no "what to do" section at all', () => {
  assert.ok(!formatDiagnostics(HEALTHY, diagnose(HEALTHY)).includes('What to do'));
});
