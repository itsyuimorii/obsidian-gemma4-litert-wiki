import { Notice, Vault } from 'obsidian';
import { appendLog } from './wiki-store';

// ---------------------------------------------------------------------------
// One notification vocabulary for the whole plugin.
//
// What this replaces: two channels with different rules. Toasts carried an
// emoji convention; the shared status toast carried none at all, including on
// all eight failure paths, which printed a raw exception string and nothing a
// reader could act on. ℹ️ meanwhile did three unrelated jobs — "nothing to
// do", "the plugin did something on its own", and one stray progress message —
// which made the most common mark the least informative. Durations were ten
// different numbers plus fourteen calls that just took Obsidian's default.
//
// The rules here are deliberately few, because a convention nobody can recite
// is not a convention.
// ---------------------------------------------------------------------------

/**
 * What a message is, which decides both its mark and how long it stays.
 *
 * `noop` deliberately has no mark. A command that correctly did nothing is not
 * an event; dressing it up as one is how ℹ️ came to mean nothing at all.
 */
export type NoticeKind =
  /** Working. Stays until replaced by the outcome. */
  | 'progress'
  /** Finished, and something changed. */
  | 'done'
  /** Ran fine, there was simply nothing to do. */
  | 'noop'
  /** The plugin acted on its own, or a fact you did not ask for but need. */
  | 'info'
  /** Needs your attention, or needs you to do something first. */
  | 'warn'
  /** It failed. */
  | 'error';

const MARK: Record<NoticeKind, string> = {
  progress: '⏳',
  done: '✅',
  noop: '',
  info: 'ℹ️',
  warn: '⚠️',
  error: '❌',
};

/**
 * Three durations, not ten. A reader either glances at a message or reads it;
 * there is no third speed, and the only thing a bespoke 9000 communicated was
 * that someone guessed.
 */
export const DURATION = {
  /** Long enough to register a result you already expected. */
  SHORT: 4000,
  /** Long enough to read one sentence naming what changed. */
  NORMAL: 7000,
  /** Long enough to read something you have to act on. */
  LONG: 12000,
} as const;

const DEFAULT_DURATION: Record<NoticeKind, number> = {
  progress: 0,
  done: DURATION.SHORT,
  noop: DURATION.SHORT,
  info: DURATION.NORMAL,
  warn: DURATION.LONG,
  error: DURATION.LONG,
};

export function mark(kind: NoticeKind, text: string): string {
  const m = MARK[kind];
  return m ? `${m} ${text}` : text;
}

/**
 * Show one notification. Prefer this over `new Notice` so the mark and the
 * duration both come from the kind rather than from whoever wrote the call.
 */
export function notify(kind: NoticeKind, text: string, durationMs?: number): Notice {
  return new Notice(mark(kind, text), durationMs ?? DEFAULT_DURATION[kind]);
}

/**
 * Turn a thrown value into a sentence worth showing.
 *
 * Failures used to render as `Improve FAILED — ${err.message}`, which is a
 * developer's string in a user's face: often multi-line, sometimes a stack, and
 * never actionable. Keep the first line as the reason, cap it, and always say
 * where the full story is.
 */
export function failureText(what: string, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const firstLine = raw.split('\n')[0].trim();
  const reason = firstLine.length > 140 ? `${firstLine.slice(0, 137)}…` : firstLine;
  return `${what} failed${reason ? ` — ${reason}` : ''}. Press Cmd/Ctrl+Opt+I for the full error.`;
}

/**
 * Warnings and failures also go to `log.md`.
 *
 * A twelve-second toast is the only time the user ever hears that, say, tags
 * are piling up in the Pending list. Once it fades there is no record anywhere
 * that it happened — the log recorded operations but never anything that went
 * wrong. Best-effort: a plugin must not fail an operation because it could not
 * write about it.
 */
export async function logNotice(vault: Vault, kind: NoticeKind, text: string): Promise<void> {
  if (kind !== 'warn' && kind !== 'error') return;
  await appendLog(vault, kind === 'error' ? 'error' : 'warning', text).catch(() => {});
}

/**
 * Notify and record in one call, for the paths that deserve both.
 */
export function notifyAndLog(vault: Vault, kind: NoticeKind, text: string, durationMs?: number): Notice {
  void logNotice(vault, kind, text);
  return notify(kind, text, durationMs);
}

/**
 * A long-running operation that reports as it goes and then says how it ended.
 *
 * Progress toasts used to be a bare `new Notice(text, 0)` whose later
 * `setMessage` calls dropped whatever mark the first one had, so an operation
 * started as ⏳ and finished as unmarked prose — including when it finished by
 * failing. Here the mark is reapplied on every update, and there is no way to
 * end one without saying which of the three endings it was.
 */
export class Progress {
  private readonly notice: Notice;

  constructor(text: string) {
    this.notice = notify('progress', text);
  }

  /** Replace the running message. Still ⏳. */
  update(text: string) {
    this.notice.setMessage(mark('progress', text));
  }

  /** It worked. */
  done(text: string, durationMs: number = DURATION.SHORT) {
    this.finish('done', text, durationMs);
  }

  /** It ran, and there was nothing to do. */
  noop(text: string, durationMs: number = DURATION.SHORT) {
    this.finish('noop', text, durationMs);
  }

  /** It worked, but there is something you should see. */
  warn(text: string, durationMs: number = DURATION.LONG) {
    this.finish('warn', text, durationMs);
  }

  /** It threw. `what` names the operation, e.g. 'Downloading the model'. */
  fail(what: string, err: unknown, vault?: Vault) {
    const text = failureText(what, err);
    console.error(`[gemma-litert-wiki] ${what} failed`, err);
    if (vault) void logNotice(vault, 'error', text);
    this.finish('error', text, DURATION.LONG);
  }

  /** Close with no final word — the outcome is being shown somewhere else. */
  hide() {
    this.notice.hide();
  }

  private finish(kind: NoticeKind, text: string, durationMs: number) {
    this.notice.setMessage(mark(kind, text));
    window.setTimeout(() => this.notice.hide(), durationMs);
  }
}
