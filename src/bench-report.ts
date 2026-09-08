// Turning a benchmark run into something someone will actually paste.
//
// The whole design constraint is that we do not own a 4070 and are not going
// to buy one. Every number for hardware other than the author's has to arrive
// from a stranger who installed the plugin, and a stranger will do exactly one
// thing: run a command and paste what it gives them. So the output of a run is
// not a log to be interpreted — it is a finished Markdown block, correct to
// paste into an issue with nothing added and nothing removed.
//
// Pure, so every decision here is tested without a GPU. What the command
// itself is left holding is only the parts that genuinely need one: creating a
// conversation, sending a message, and reading the clock.

import { contentHash } from './pure.ts';
import { looksRepetitive, parseModelJson } from './model-output.ts';

export interface BenchMeasurement {
  fixtureId: string;
  label: string;
  /** Wall clock for the whole call, which is what a user actually waits. */
  wallMs: number;
  ttftSeconds: number;
  prefillTokensPerSecond: number;
  prefillTokenCount: number;
  decodeTokensPerSecond: number;
  decodeTokenCount: number;
  /** Output checks, all from helpers the plugin already ships. */
  usableJson: boolean;
  rightShape: boolean;
  looping: boolean;
  cutOff: boolean;
  /**
   * Hash of the model's reply. Greedy sampling means this SHOULD be identical
   * on every machine running the same model — different backends rounding
   * differently could flip an argmax and diverge, and nobody has checked. Two
   * pasted reports with different hashes is the check.
   */
  replyHash: string;
}

export interface BenchEnvironment {
  /** From `adapter.info` — vendor / architecture / device, whatever it gives. */
  gpu: string;
  pluginVersion: string;
  obsidianVersion: string;
  platform: string;
  /** Pinned during the run; the ingest budget scales with it, so it changes the numbers. */
  contextTokens: number;
  /**
   * First model call of the session, including one-time shader compilation.
   * Reported on its own line and never folded into a per-note average: it is
   * paid once per session, and averaging it in makes every note look four
   * times slower than it is.
   */
  coldStartSeconds: number | null;
  /** Apple Silicon in particular throttles hard on battery. Null when unknown. */
  onBattery: boolean | null;
}

const f1 = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : '—');
const f2 = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : '—');

/** Median, not mean: one thermally-throttled outlier should not move the headline. */
export function median(values: number[]): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The one number a reader wants: how long one card takes on this machine. */
export function typicalSecondsPerCard(measurements: BenchMeasurement[]): number {
  return median(measurements.map((m) => m.wallMs / 1000));
}

export function buildBenchmarkReport(
  env: BenchEnvironment,
  measurements: BenchMeasurement[]
): string {
  const rows = measurements
    .map(
      (m) =>
        `| ${m.label} | ${m.prefillTokenCount} | ${f1(m.wallMs / 1000)} s | ${f2(m.ttftSeconds)} s | ` +
        `${f1(m.prefillTokensPerSecond)} | ${f1(m.decodeTokensPerSecond)} |`
    )
    .join('\n');

  const typical = typicalSecondsPerCard(measurements);
  const usable = measurements.filter((m) => m.usableJson && m.rightShape && !m.looping && !m.cutOff);
  const problems: string[] = [];
  for (const m of measurements) {
    const flags = [
      !m.usableJson && 'unreadable JSON',
      m.usableJson && !m.rightShape && 'wrong shape',
      m.looping && 'repetition loop',
      m.cutOff && 'cut off',
    ].filter(Boolean);
    if (flags.length) problems.push(`\`${m.fixtureId}\`: ${flags.join(', ')}`);
  }

  const power =
    env.onBattery === null ? 'unknown' : env.onBattery ? '**on battery**' : 'plugged in';

  return [
    `**${f1(typical)} s per card** · cold start ${env.coldStartSeconds === null ? '—' : `${f1(env.coldStartSeconds)} s` } · ${usable.length}/${measurements.length} usable`,
    '',
    `- **GPU**: ${env.gpu}`,
    `- **Platform**: ${env.platform}`,
    `- **Obsidian**: ${env.obsidianVersion} · **plugin**: ${env.pluginVersion}`,
    `- **Context window setting**: ${env.contextTokens} · **power**: ${power}`,
    '',
    '| Note | Input tokens | Wall | Time to first token | Prefill tok/s | Decode tok/s |',
    '|---|---|---|---|---|---|',
    rows,
    '',
    problems.length
      ? `Output problems: ${problems.join(' · ')}`
      : 'Output: all five parsed, correctly shaped, no loops, none cut off.',
    '',
    '<details><summary>Reply hashes (for checking whether output is identical across GPUs)</summary>',
    '',
    '```',
    ...measurements.map((m) => `${m.fixtureId.padEnd(10)} ${m.replyHash}`),
    '```',
    '',
    '</details>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Judging one reply
// ---------------------------------------------------------------------------

/** What the engine reports back about a single generation. */
export interface BenchTimings {
  wallMs: number;
  timeToFirstTokenInSecond: number;
  lastPrefillTokensPerSecond: number;
  lastPrefillTokenCount: number;
  lastDecodeTokensPerSecond: number;
  lastDecodeTokenCount: number;
}

/**
 * Turn one model reply into a row of the table.
 *
 * This is the quality half of the benchmark and the half that is easy to get
 * quietly wrong, because the four verdicts overlap: a truncated reply is also
 * unreadable JSON, and a looping reply usually parses perfectly. Reporting a
 * cut-off run as "wrong shape" would send a reader looking for a prompt bug
 * instead of a token budget, so each flag is decided independently from the
 * evidence for it, and the report prints all of them.
 *
 * `looping` is deliberately judged on the WHOLE reply rather than on the
 * parsed summary: a loop that runs past the token budget never becomes valid
 * JSON, so a check that only looked at parsed fields would miss exactly the
 * case this fixture set includes a link dump to provoke.
 */
export function evaluateBenchReply(
  fixture: { id: string; label: string },
  reply: string,
  timings: BenchTimings
): BenchMeasurement {
  const read = parseModelJson<Record<string, unknown>>(reply);
  const rec = read.ok ? read.value : {};
  return {
    fixtureId: fixture.id,
    label: fixture.label,
    wallMs: timings.wallMs,
    ttftSeconds: timings.timeToFirstTokenInSecond,
    prefillTokensPerSecond: timings.lastPrefillTokensPerSecond,
    prefillTokenCount: timings.lastPrefillTokenCount,
    decodeTokensPerSecond: timings.lastDecodeTokensPerSecond,
    decodeTokenCount: timings.lastDecodeTokenCount,
    usableJson: read.ok,
    rightShape:
      read.ok &&
      typeof rec.summary === 'string' &&
      Array.isArray(rec.tags) &&
      rec.tags.length === 3 &&
      rec.tags.every((t: unknown) => typeof t === 'string'),
    looping: looksRepetitive(reply).repetitive,
    cutOff: !read.ok && read.reason === 'cut-off',
    replyHash: contentHash(reply),
  };
}

/**
 * The GPU line, from whatever `adapter.info` chose to fill in.
 *
 * Chromium reliably populates `vendor` and `architecture`; `device` and
 * `description` are frequently empty strings, and printing those as blanks in
 * a table other people read is worse than leaving them out. Order is fixed so
 * two reports from the same chip produce the same string and can be grouped.
 */
export function formatGpuInfo(info: Record<string, unknown> | null | undefined): string {
  if (!info) return 'adapter reported no identity';
  const parts = ['vendor', 'architecture', 'device', 'description']
    .map((k) => {
      const v = info[k];
      return typeof v === 'string' ? v.trim() : '';
    })
    .filter(Boolean);
  return parts.length ? parts.join(' · ') : 'adapter reported no identity';
}
