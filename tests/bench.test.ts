// The benchmark corpus and the report it produces.
//
// Neither can be run against a GPU from here, so what is testable is the part
// that decides whether the numbers are comparable at all: that the fixtures
// stay inside the budget every machine shares, that they cover the shapes they
// claim to, and that the report is a finished paste rather than something a
// reader has to interpret.

import test from 'node:test';
import assert from 'node:assert/strict';
import { BENCH_CORPUS } from '../src/bench-corpus.ts';
import {
  buildBenchmarkReport,
  median,
  typicalSecondsPerCard,
  type BenchEnvironment,
  type BenchMeasurement,
} from '../src/bench-report.ts';
import { estimateImproveTokens } from '../src/pure.ts';

// --- the corpus -------------------------------------------------------------

test('every fixture has an id, a label and a stated reason to exist', () => {
  for (const f of BENCH_CORPUS) {
    assert.ok(f.id && /^[a-z][a-z0-9-]*$/.test(f.id), f.id);
    assert.ok(f.label.length > 3, f.id);
    assert.ok(f.why.length > 40, `${f.id} needs a real justification, not a label`);
    assert.ok(f.text.trim().length > 100, f.id);
  }
});

test('fixture ids are unique', () => {
  const ids = BENCH_CORPUS.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, ids.join(', '));
});

test('every fixture fits the smallest ingest budget any machine will use', () => {
  // budget('ingest') clamps UP to 2600 tokens even at the 4096 minimum context
  // setting, so a fixture under that is never truncated. One that got clamped
  // would measure the clamp instead of the note, making the number depend on a
  // user setting rather than on the machine.
  for (const f of BENCH_CORPUS) {
    const tokens = estimateImproveTokens(f.text);
    assert.ok(tokens < 2000, `${f.id} is ~${tokens} tokens — too close to the 2600 floor`);
  }
});

test('the corpus covers the shapes it claims to', () => {
  const byId = new Map(BENCH_CORPUS.map((f) => [f.id, f.text]));

  // CJK, because it costs ~4x the tokens per character and a table without it
  // misleads every CJK user.
  const ja = byId.get('ja');
  assert.ok(ja, 'a CJK fixture is required');
  assert.ok(/[぀-ヿ一-鿿]/.test(ja!), 'the ja fixture must actually be CJK');

  // Fenced code, the content most likely to be mangled.
  const code = byId.get('code');
  assert.ok(code && (code.match(/```/g) ?? []).length >= 4, 'the code fixture needs real fenced blocks');

  // A low-information note — the shape most likely to trigger a repetition loop.
  const sparse = byId.get('sparse');
  assert.ok(sparse, 'a sparse fixture is required');
  assert.ok((sparse!.match(/https?:\/\//g) ?? []).length >= 8, 'the sparse fixture should be mostly links');

  // A long note, to make prefill dominate — that is where GPUs differ most.
  const long = estimateImproveTokens(byId.get('long-en') ?? '');
  const short = estimateImproveTokens(byId.get('short-en') ?? '');
  assert.ok(long > short * 2, `long-en (${long}) should dwarf short-en (${short})`);
});

test('the CJK fixture really is token-dense relative to its length', () => {
  // The property that justifies its place: far more tokens per character.
  const ja = BENCH_CORPUS.find((f) => f.id === 'ja')!;
  const en = BENCH_CORPUS.find((f) => f.id === 'short-en')!;
  const jaRatio = estimateImproveTokens(ja.text) / ja.text.length;
  const enRatio = estimateImproveTokens(en.text) / en.text.length;
  assert.ok(jaRatio > enRatio * 3, `ja ${jaRatio.toFixed(2)} vs en ${enRatio.toFixed(2)} tokens/char`);
});

test('no fixture carries a real URL that could rot or track', () => {
  for (const f of BENCH_CORPUS) {
    for (const url of f.text.match(/https?:\/\/[^\s)]+/g) ?? []) {
      assert.match(url, /^https?:\/\/example\.(org|com|net)/, `${f.id}: ${url}`);
    }
  }
});

// --- the report -------------------------------------------------------------

const ENV: BenchEnvironment = {
  gpu: 'apple · common-3',
  pluginVersion: '1.0.11',
  obsidianVersion: '1.11.4',
  platform: 'MacIntel',
  contextTokens: 4096,
  coldStartSeconds: 28.1,
  onBattery: false,
};

const m = (over: Partial<BenchMeasurement> = {}): BenchMeasurement => ({
  fixtureId: 'short-en',
  label: 'Short note (EN)',
  wallMs: 15200,
  ttftSeconds: 0.74,
  prefillTokensPerSecond: 495,
  prefillTokenCount: 335,
  decodeTokensPerSecond: 29.1,
  decodeTokenCount: 120,
  usableJson: true,
  rightShape: true,
  looping: false,
  cutOff: false,
  replyHash: 'deadbeef',
  ...over,
});

test('the headline is seconds per card, not tokens per second', () => {
  // tok/s is the underlying physics; "how long is one card" is the decision.
  const report = buildBenchmarkReport(ENV, [m()]);
  assert.match(report.split('\n')[0], /15\.2 s per card/);
});

test('cold start is reported separately and never averaged in', () => {
  const report = buildBenchmarkReport(ENV, [m({ wallMs: 15200 }), m({ wallMs: 15200 })]);
  assert.match(report, /cold start 28\.1 s/);
  assert.match(report, /15\.2 s per card/, 'the 28s cold cost must not move the per-card figure');
});

test('the typical figure is a median, so one throttled outlier does not move it', () => {
  const ms = [m({ wallMs: 15000 }), m({ wallMs: 16000 }), m({ wallMs: 90000 })];
  assert.equal(typicalSecondsPerCard(ms), 16);
});

test('median handles even counts and empty input', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([5]), 5);
  assert.ok(Number.isNaN(median([])));
});

test('everything needed to compare two reports is in the report', () => {
  const report = buildBenchmarkReport(ENV, [m()]);
  for (const needed of ['apple · common-3', '1.0.11', '1.11.4', 'MacIntel', '4096', 'plugged in']) {
    assert.ok(report.includes(needed), `missing ${needed}`);
  }
});

test('the context window setting is always stated, because it changes the numbers', () => {
  // budget('ingest') scales with it, so two machines on different settings are
  // not comparable and the report has to say which was used.
  const report = buildBenchmarkReport({ ...ENV, contextTokens: 32768 }, [m()]);
  assert.match(report, /Context window setting\*\*: 32768/);
});

test('unknown power state is not reported as plugged in', () => {
  const report = buildBenchmarkReport({ ...ENV, onBattery: null }, [m()]);
  assert.match(report, /power\*\*: unknown/);
  assert.ok(!report.includes('plugged in'));
});

test('battery is called out, because Apple Silicon throttles on it', () => {
  assert.match(buildBenchmarkReport({ ...ENV, onBattery: true }, [m()]), /\*\*on battery\*\*/);
});

test('a clean run says so plainly', () => {
  const report = buildBenchmarkReport(ENV, [m(), m()]);
  assert.match(report, /all five parsed, correctly shaped, no loops, none cut off/);
  assert.match(report, /2\/2 usable/);
});

test('each output problem is named against its fixture', () => {
  const report = buildBenchmarkReport(ENV, [
    m({ fixtureId: 'sparse', looping: true }),
    m({ fixtureId: 'long-en', usableJson: false, cutOff: true }),
    m({ fixtureId: 'code', rightShape: false }),
  ]);
  assert.match(report, /`sparse`: repetition loop/);
  assert.match(report, /`long-en`: unreadable JSON, cut off/);
  assert.match(report, /`code`: wrong shape/);
  assert.match(report, /0\/3 usable/);
});

test('reply hashes are included, so two GPUs can be compared for divergence', () => {
  // Greedy sampling should make output identical across machines; different
  // backends rounding differently could flip an argmax. Nobody has checked,
  // and two pasted reports are the check.
  const report = buildBenchmarkReport(ENV, [m({ fixtureId: 'ja', replyHash: 'abc12345' })]);
  assert.match(report, /ja\s+abc12345/);
});

test('the report is valid Markdown a table renders from', () => {
  const report = buildBenchmarkReport(ENV, BENCH_CORPUS.map((f) => m({ fixtureId: f.id, label: f.label })));
  const lines = report.split('\n');
  const header = lines.findIndex((l) => l.startsWith('| Note |'));
  assert.ok(header >= 0, 'no table header');
  assert.match(lines[header + 1], /^\|(-+\|){6}$/, 'separator must match the column count');
  const dataRows = lines.filter((l) => l.startsWith('| ') && !l.startsWith('| Note |'));
  assert.equal(dataRows.length, BENCH_CORPUS.length, 'one row per fixture');
  // Six columns means eight pieces once the leading and trailing pipes split.
  for (const row of [lines[header], ...dataRows]) assert.equal(row.split('|').length, 8, row);
});

test('a missing benchmark number degrades to a dash rather than NaN', () => {
  const report = buildBenchmarkReport({ ...ENV, coldStartSeconds: null }, [
    m({ prefillTokensPerSecond: NaN, ttftSeconds: NaN }),
  ]);
  assert.ok(!report.includes('NaN'), report);
  assert.match(report, /cold start —/);
});
