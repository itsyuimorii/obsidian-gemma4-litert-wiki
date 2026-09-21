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

// --- Which GPU, and whether a better one is probably idle beside it --------
//
// Issue #149: a Windows laptop with an NVIDIA card ran the model on the
// Intel integrated GPU. The runtime already asks for the high-performance
// adapter; Windows decides anyway, and only the user's own graphics setting
// changes that. The plugin cannot see the card it was not given, so all it
// can do is name the one it has and, when that one is the kind that usually
// has a faster neighbour, say where the switch is.

import { integratedGpuOnWindows } from '../src/pure.ts';

const gpu = (platform: string, vendor?: string, description?: string): DiagnosticFacts => ({
  ...HEALTHY,
  platform,
  webgpu: { ok: true, detail: `Adapter found. ${description ?? ''}`, vendor, description },
});

test('an Intel integrated GPU on Windows is a note that names the graphics setting', () => {
  const f = gpu('Windows', 'intel', 'Intel(R) Iris(R) Xe Graphics');
  assert.equal(integratedGpuOnWindows(f), true);
  const c = Object.fromEntries(diagnose(f).map((x) => [x.name, x]));
  assert.equal(c.WebGPU.status, 'warn');
  assert.match(c.WebGPU.fix ?? '', /Settings > System > Display > Graphics/);
  assert.match(c.WebGPU.fix ?? '', /High performance/);
  assert.equal(diagnosisBlocks(diagnose(f)), false);
});

test('a dedicated GPU is simply ok', () => {
  for (const [v, d] of [['nvidia', 'NVIDIA GeForce RTX 4060 Laptop GPU'], ['amd', 'AMD Radeon RX 7600'], ['intel', 'Intel(R) Arc(TM) A770 Graphics']]) {
    const f = gpu('Windows', v, d);
    assert.equal(integratedGpuOnWindows(f), false, d);
    assert.equal(diagnose(f).find((x) => x.name === 'WebGPU')?.status, 'ok', d);
  }
});

test('AMD integrated graphics are told apart from AMD cards', () => {
  assert.equal(integratedGpuOnWindows(gpu('Windows', 'amd', 'AMD Radeon(TM) Graphics')), true);
  assert.equal(integratedGpuOnWindows(gpu('Windows', 'amd', 'AMD Radeon Vega 8 Graphics')), true);
});

test('macOS and Linux are left alone, and so is an adapter with no info', () => {
  assert.equal(integratedGpuOnWindows(gpu('macOS', 'apple', 'Apple M2')), false);
  assert.equal(integratedGpuOnWindows(gpu('Linux', 'intel', 'Mesa Intel(R) UHD Graphics 620')), false);
  assert.equal(integratedGpuOnWindows(gpu('Windows')), false);
});

test('the report names the GPU', () => {
  const f = gpu('Windows', 'nvidia', 'NVIDIA GeForce RTX 4060 Laptop GPU');
  assert.match(formatDiagnostics(f, diagnose(f)), /RTX 4060/);
});
