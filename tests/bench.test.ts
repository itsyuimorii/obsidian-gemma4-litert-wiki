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
  evaluateBenchReply,
  formatGpuInfo,
  median,
  typicalSecondsPerCard,
  type BenchEnvironment,
  type BenchMeasurement,
  type BenchTimings,
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

// --- judging one reply ------------------------------------------------------
//
// The four verdicts overlap, which is what makes this worth testing: a
// truncated reply is ALSO unreadable JSON, and a looping reply usually parses
// perfectly. Reporting a cut-off run as "wrong shape" would send a reader
// hunting a prompt bug instead of a token budget.

const TIMINGS: BenchTimings = {
  wallMs: 15200,
  timeToFirstTokenInSecond: 0.74,
  lastPrefillTokensPerSecond: 495,
  lastPrefillTokenCount: 335,
  lastDecodeTokensPerSecond: 29.1,
  lastDecodeTokenCount: 120,
};

const FIXTURE = { id: 'short-en', label: 'Short note (EN)' };
const judge = (reply: string) => evaluateBenchReply(FIXTURE, reply, TIMINGS);

const GOOD = JSON.stringify({
  summary: 'The team replaced webpack with esbuild to cut a 41-second cold start.',
  tags: ['build-tools', 'developer-experience', 'esbuild'],
});

test('a good reply is usable on every count', () => {
  const r = judge(GOOD);
  assert.deepEqual(
    { usableJson: r.usableJson, rightShape: r.rightShape, looping: r.looping, cutOff: r.cutOff },
    { usableJson: true, rightShape: true, looping: false, cutOff: false }
  );
});

test('timings are carried through untouched', () => {
  const r = judge(GOOD);
  assert.equal(r.wallMs, 15200);
  assert.equal(r.ttftSeconds, 0.74);
  assert.equal(r.prefillTokenCount, 335);
  assert.equal(r.decodeTokensPerSecond, 29.1);
  assert.equal(r.fixtureId, 'short-en');
  assert.equal(r.label, 'Short note (EN)');
});

test('a fenced reply is still usable — the model does that constantly', () => {
  const r = judge('Here you go:\n```json\n' + GOOD + '\n```\nHope that helps!');
  assert.equal(r.usableJson, true);
  assert.equal(r.rightShape, true);
});

test('cut off is reported as cut off, not as wrong shape', () => {
  // The distinction that matters: one sends you to the token budget, the
  // other to the prompt.
  const r = judge('{"summary": "The team replaced webpack with esbuild to cut a co');
  assert.equal(r.cutOff, true);
  assert.equal(r.usableJson, false);
  assert.equal(r.rightShape, false, 'shape is unknown, not wrong — reported as not-right');
});

test('unreadable output that is NOT truncation is not blamed on the budget', () => {
  for (const reply of ['I cannot help with that.', '', '   ']) {
    const r = judge(reply);
    assert.equal(r.usableJson, false, JSON.stringify(reply));
    assert.equal(r.cutOff, false, `${JSON.stringify(reply)} is not a truncation`);
  }
});

test('valid JSON of the wrong shape is wrong shape, and not cut off', () => {
  for (const reply of [
    '{"summary": "fine", "tags": ["only", "two"]}',
    '{"summary": "fine", "tags": ["a", "b", "c", "d"]}',
    '{"summary": 42, "tags": ["a", "b", "c"]}',
    '{"summary": "fine", "tags": "a, b, c"}',
    '{"summary": "fine", "tags": ["a", "b", 3]}',
    '{"tags": ["a", "b", "c"]}',
    '{}',
  ]) {
    const r = judge(reply);
    assert.equal(r.usableJson, true, reply);
    assert.equal(r.rightShape, false, reply);
    assert.equal(r.cutOff, false, reply);
  }
});

test('a repetition loop is caught even though the JSON is perfect', () => {
  // The exact failure #109 exists for: shape checks all pass, and the content
  // is one phrase forty times.
  const looped = JSON.stringify({
    summary: 'The note discusses caching. '.repeat(40),
    tags: ['caching', 'notes', 'summary'],
  });
  const r = judge(looped);
  assert.equal(r.usableJson, true, 'it parses');
  assert.equal(r.rightShape, true, 'and the shape is correct — that is the problem');
  assert.equal(r.looping, true, 'and it is still caught');
});

test('a loop that ran past the budget is caught even though nothing parses', () => {
  // Judged on the whole reply, not on parsed fields — a loop that never closes
  // its brace would otherwise be invisible to a parsed-fields-only check.
  const r = judge('{"summary": "' + 'the same clause again and again. '.repeat(30));
  assert.equal(r.usableJson, false);
  assert.equal(r.cutOff, true);
  assert.equal(r.looping, true, 'both flags are true, and both are reported');
});

test('a long genuine summary is not mistaken for a loop', () => {
  const real = JSON.stringify({
    summary:
      'The team moved off webpack because a cold start took 41 seconds, migrated three custom loaders, ' +
      'replaced the SVG loader with plain imports, turned the YAML loader into a build step, and now runs ' +
      'type checking separately in parallel rather than inside the bundler.',
    tags: ['build-tools', 'migration', 'esbuild'],
  });
  assert.equal(judge(real).looping, false);
});

test('the hash is stable for identical replies and differs for different ones', () => {
  // This is the whole cross-GPU determinism check, so it has to be exact.
  assert.equal(judge(GOOD).replyHash, judge(GOOD).replyHash);
  assert.notEqual(judge(GOOD).replyHash, judge(GOOD + ' ').replyHash);
  assert.match(judge(GOOD).replyHash, /^[0-9a-f]{8}$/);
});

test('judging is pure — same reply, same verdict, every time', () => {
  const first = JSON.stringify(judge(GOOD));
  for (let i = 0; i < 10; i++) assert.equal(JSON.stringify(judge(GOOD)), first);
});

test('a judged reply drops straight into the report', () => {
  const report = buildBenchmarkReport(ENV, [judge(GOOD), judge('nonsense')]);
  assert.match(report, /1\/2 usable/);
  assert.match(report, /`short-en`: unreadable JSON/);
});

// --- the GPU line -----------------------------------------------------------

test('the GPU line uses what the adapter filled in, in a fixed order', () => {
  assert.equal(formatGpuInfo({ vendor: 'apple', architecture: 'common-3' }), 'apple · common-3');
  assert.equal(
    formatGpuInfo({ architecture: 'common-3', vendor: 'apple' }),
    'apple · common-3',
    'order is fixed by the field list, not by the object — so two reports from one chip group together'
  );
});

test('empty adapter fields are dropped rather than printed as blanks', () => {
  // `device` and `description` are frequently empty strings in Chromium.
  assert.equal(
    formatGpuInfo({ vendor: 'nvidia', architecture: 'ada-lovelace', device: '', description: '   ' }),
    'nvidia · ada-lovelace'
  );
});

test('a GPU line is always produced, whatever the adapter says', () => {
  for (const info of [null, undefined, {}, { vendor: '' }, { vendor: 42, device: null }]) {
    const out = formatGpuInfo(info as Record<string, unknown> | null | undefined);
    assert.ok(out.length > 0, JSON.stringify(info));
    assert.ok(!out.includes('undefined') && !out.includes('null'), out);
  }
});

test('a full adapter report keeps all four fields', () => {
  assert.equal(
    formatGpuInfo({
      vendor: 'nvidia',
      architecture: 'ada-lovelace',
      device: 'NVIDIA GeForce RTX 4070',
      description: 'D3D12',
    }),
    'nvidia · ada-lovelace · NVIDIA GeForce RTX 4070 · D3D12'
  );
});
