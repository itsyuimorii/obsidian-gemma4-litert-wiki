import type { ChatTurnRecord } from './wiki-store';

/**
 * Past chat threads, as the 🕘 menu lists them.
 *
 * Kept apart from `lastThread` in data.json on purpose. That one is the
 * thread on screen, saved so a close or a restart does not cost it; this is
 * every thread the user moved on from with ＋, and at thirty threads of up to
 * 60,000 characters each it does not belong in a file that is rewritten on
 * every settings change. It lives in its own file in the plugin's folder —
 * never in the vault, because nothing in it was approved for writing there,
 * and nothing that reads the vault should ever read it back as material.
 *
 * Pure: the view does the reading and writing; every rule about what is kept
 * is here, where it can be tested.
 */

export type ThreadMode = 'note' | 'vault' | 'wiki';

export interface ArchivedThread {
  id: string;
  /** The first question, as a person would name the conversation. */
  title: string;
  /** Where it was last answered from — the icon in the list, and the mode it reopens in. */
  mode: ThreadMode;
  /** Epoch milliseconds when it was archived. */
  savedAt: number;
  turns: ChatTurnRecord[];
}

/** How many past threads are kept. Older ones fall off the end. */
export const HISTORY_LIMIT = 30;
const MAX_TURNS = 20;
const MAX_CHARS = 60_000;
const MAX_TITLE = 80;
const HISTORY_VERSION = 1;

/**
 * The thread as it is kept: the most recent exchanges, a character ceiling on
 * top for the case where a few answers are enormous, and never opening on an
 * answer, which would restore as an answer to nothing. Trimmed from the front,
 * so what survives is what you were last looking at.
 */
export function capThread(turns: readonly ChatTurnRecord[]): ChatTurnRecord[] {
  const kept = turns.slice(-MAX_TURNS);
  while (kept.length && kept.reduce((n, t) => n + t.content.length, 0) > MAX_CHARS) kept.shift();
  while (kept.length && kept[0].role === 'assistant') kept.shift();
  return kept;
}

export function threadTitle(turns: readonly ChatTurnRecord[]): string {
  const first = turns.find((t) => t.role === 'user')?.content.replace(/\s+/g, ' ').trim();
  if (!first) return 'Untitled chat';
  return first.length > MAX_TITLE ? `${first.slice(0, MAX_TITLE - 1).trimEnd()}…` : first;
}

/**
 * The mode a thread was last answered in, read from its grounding keys.
 * An ungrounded answer ('direct') was asked from Vault — with Notes first
 * unticked, or through "Ask Gemma anyway" — so that is where it reopens.
 */
export function threadMode(turns: readonly ChatTurnRecord[]): ThreadMode {
  const key = [...turns].reverse().find((t) => t.grounding)?.grounding ?? '';
  if (key.startsWith('wiki')) return 'wiki';
  if (key === 'vault' || key === 'direct') return 'vault';
  return 'note';
}

/**
 * Put a thread at the top of the history. A question left without an answer
 * (stopped, or failed) is dropped from its end, and a thread with no answer
 * at all is not worth a row — the input is returned unchanged.
 */
export function archiveThread(
  history: readonly ArchivedThread[],
  turns: readonly ChatTurnRecord[],
  now: number,
  newId: () => string
): ArchivedThread[] {
  const answered = [...turns];
  while (answered.length && answered.at(-1)!.role === 'user') answered.pop();
  const kept = capThread(answered);
  if (!kept.some((t) => t.role === 'assistant')) return history as ArchivedThread[];
  const thread: ArchivedThread = {
    id: newId(),
    title: threadTitle(kept),
    mode: threadMode(kept),
    savedAt: now,
    turns: kept.map((t) => ({ ...t })),
  };
  return [thread, ...history].slice(0, HISTORY_LIMIT);
}

export function removeThread(history: readonly ArchivedThread[], id: string): ArchivedThread[] {
  return history.filter((t) => t.id !== id);
}

export function serializeHistory(history: readonly ArchivedThread[]): string {
  return JSON.stringify({ version: HISTORY_VERSION, threads: history });
}

function isTurn(v: unknown): v is ChatTurnRecord {
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  return (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string';
}

/**
 * Read the history file. Whatever cannot be read is skipped rather than
 * thrown: a damaged file should cost the threads that are damaged, not the
 * panel. A mode this build does not know reopens in This note.
 */
export function parseHistory(raw: string | null): ArchivedThread[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const threads = (data as { threads?: unknown } | null)?.threads;
  if (!Array.isArray(threads)) return [];
  const out: ArchivedThread[] = [];
  for (const v of threads) {
    if (!v || typeof v !== 'object') continue;
    const t = v as Record<string, unknown>;
    if (typeof t.id !== 'string' || typeof t.title !== 'string' || typeof t.savedAt !== 'number') continue;
    if (!Array.isArray(t.turns) || !t.turns.length || !t.turns.every(isTurn)) continue;
    const mode: ThreadMode = t.mode === 'vault' || t.mode === 'wiki' ? t.mode : 'note';
    out.push({ id: t.id, title: t.title, mode, savedAt: t.savedAt, turns: t.turns });
  }
  return out.slice(0, HISTORY_LIMIT);
}
