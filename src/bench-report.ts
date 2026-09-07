// Turning a benchmark run into something someone will actually paste.
//
// The whole design constraint is that we do not own a 4070 and are not going
// to buy one. Every number for hardware other than the author's has to arrive
// from a stranger who installed the plugin, and a stranger will do exactly one
// thing: run a command and paste what it gives them. So the output of a run is
// not a log to be interpreted — it is a finished Markdown block, correct to
// paste into an issue with nothing added and nothing removed.
//
// Pure, and imports nothing, so the formatting is tested without a GPU.

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
