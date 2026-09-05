// Reading what the model actually said.
//
// Three questions this file answers, none of which the engine will answer for
// us: where the JSON is, whether the generation finished, and whether it
// collapsed into a loop. Like src/pure.ts it imports nothing but its sibling,
// so tests/ can run it under `node --test` without an Obsidian to run inside.

// The `.ts` is load-bearing, and only here: Node resolves ESM specifiers
// literally, so a test importing this file needs this import to name a real
// path. esbuild and tsc both accept it, and main.ts — which is only ever
// bundled — keeps the extensionless form the rest of src/ uses.
import { estimateImproveTokens } from './pure.ts';

// ---------------------------------------------------------------------------
// Where the JSON is
// ---------------------------------------------------------------------------

/**
 * The result of looking for a JSON object in a model's reply.
 *
 * `unterminated` is the case worth having a name for. A brace that opens and
 * never closes is not a model that answered badly — it is a model that was
 * still talking when the token budget ran out, and the caller's response to
 * that should be to try again rather than to report an empty result.
 */
export type JsonScan =
  | { kind: 'ok'; json: string }
  | { kind: 'none' }
  | { kind: 'unterminated'; partial: string };

/**
 * Find the first complete JSON object in a model's reply.
 *
 * This replaces two strategies that were in use side by side and failed on
 * different inputs. Four call sites took `/\{[\s\S]*\}/`, which runs from the
 * first brace to the LAST one anywhere in the reply — so a closing brace in
 * the prose afterwards, or a second object, silently produced something that
 * was not valid JSON. Three stripped ```json fences off the ends, which does
 * nothing when the model puts a sentence before the fence.
 *
 * Braces are counted instead, skipping over string literals so that a `}`
 * inside a value does not close the object, and skipping escapes so that a
 * `\"` does not end a string. Everything before the first brace and after the
 * matching one is ignored, which makes fences, preambles and sign-offs all the
 * same uninteresting case.
 */
export function scanJsonObject(raw: string): JsonScan {
  const start = raw.indexOf('{');
  if (start === -1) return { kind: 'none' };

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { kind: 'ok', json: raw.slice(start, i + 1) };
    }
  }
  return { kind: 'unterminated', partial: raw.slice(start) };
}

/** Why reading a model's JSON failed, in words a notice can use. */
export type ParseFailure = 'no-json' | 'cut-off' | 'invalid-json';

export type ParsedJson<T> = { ok: true; value: T } | { ok: false; reason: ParseFailure };

/**
 * Parse the first JSON object in a model's reply.
 *
 * The failure is always named. Five of the model calls here used to return
 * `[]` or `null` when this went wrong, which is the same thing they return
 * when the model genuinely found nothing — so a run that never finished read
 * to the user as a clean result. Provenance is the sharp end of that: an empty
 * list there means "every key point traced back to the note".
 */
export function parseModelJson<T = unknown>(raw: string): ParsedJson<T> {
  const scan = scanJsonObject(raw);
  if (scan.kind === 'none') return { ok: false, reason: 'no-json' };
  if (scan.kind === 'unterminated') return { ok: false, reason: 'cut-off' };
  try {
    return { ok: true, value: JSON.parse(scan.json) as T };
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
}

// ---------------------------------------------------------------------------
// Whether the generation finished
// ---------------------------------------------------------------------------

// There is no finish reason to read. `Conversation.sendMessage` resolves to a
// Message and nothing on it, or on the session config, says why generation
// stopped — so "was this cut off?" has to be inferred from the text and from
// the budget we asked for. Every signal below is therefore a suspicion, and
// the strongest one by far lives elsewhere: a JSON object that opens and never
// closes, which scanJsonObject already reports as `unterminated`.

/** How close to its budget an output has to land before the budget is the likely reason it stopped. */
const AT_BUDGET = 0.95;

/** Terminal punctuation, Latin and CJK. A closing quote or bracket may follow it. */
const ENDS_A_SENTENCE = /[.!?。！？…][)\]"'”’」』]*\s*$/;

export interface CutOffReport {
  cutOff: boolean;
  /** The output landed on or near the token budget, so the budget is why it stopped. */
  atBudget: boolean;
  /** The text stops without finishing a sentence. */
  midSentence: boolean;
}

/**
 * Whether a generation looks like it ran out of budget rather than finishing.
 *
 * Deliberately requires both signals for prose. Either alone is far too eager:
 * plenty of good short answers end without a full stop (a bare list, a single
 * word, a fenced block), and plenty of complete answers happen to land near
 * the budget because the budget was set from the input size. Together they are
 * a much narrower claim — this output is as long as it was allowed to be, AND
 * it stops in the middle of a sentence.
 *
 * Callers holding structured output should trust scanJsonObject's
 * `unterminated` over this; it is a fact rather than an inference.
 */
export function looksCutOff(text: string, maxOutputTokens?: number): CutOffReport {
  const body = text.trim();
  const atBudget =
    maxOutputTokens !== undefined &&
    maxOutputTokens > 0 &&
    estimateImproveTokens(body) >= maxOutputTokens * AT_BUDGET;
  const midSentence = body.length > 0 && !ENDS_A_SENTENCE.test(body);
  return { cutOff: atBudget && midSentence, atBudget, midSentence };
}

// ---------------------------------------------------------------------------
// Whether the generation collapsed into a loop
// ---------------------------------------------------------------------------

// Greedy decoding on a small model can fall into a repetition loop, and a loop
// that lands inside a JSON string passes every guard we have: the shape checks
// ask whether `summary` is a string and whether `tags` has three entries, and
// one phrase repeated forty times satisfies both. It then becomes a card.
//
// Two measures, because loops arrive in two shapes. A loop with punctuation
// repeats whole sentences, which the run counter catches. A loop without any —
// the common CJK case, where the model emits one clause over and over with no
// terminator — has a single enormous "sentence", so it is caught instead by
// how few distinct character windows the text contains.
//
// THE THRESHOLDS BELOW ARE NOT YET CALIBRATED against this model's output.
// They are set where only an unambiguous loop trips them, because the cost of
// a false positive is discarding a good generation and asking the model again.
// Calibrating them means gathering real replies with `[Test] JSON reliability
// test` and looking at where the two populations actually separate; until that
// is done, prefer letting a mild loop through to rejecting good output.
const MAX_IDENTICAL_RUN = 5;
const NGRAM = 12;
const MIN_LENGTH_FOR_NGRAMS = 200;
const MIN_DISTINCT_RATIO = 0.2;

export interface RepetitionReport {
  repetitive: boolean;
  /** The most times one segment repeated back to back. */
  longestRun: number;
  /** Distinct character windows over total; 1 when the text is too short to judge. */
  distinctRatio: number;
}

function segments(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？\n])/)
    .map((s) => s.trim().toLowerCase().replace(/\s+/g, ' '))
    .filter(Boolean);
}

export function looksRepetitive(text: string): RepetitionReport {
  const body = text.trim();

  let longestRun = 0;
  let run = 0;
  let previous: string | null = null;
  for (const segment of segments(body)) {
    run = segment === previous ? run + 1 : 1;
    previous = segment;
    if (run > longestRun) longestRun = run;
  }

  let distinctRatio = 1;
  const compact = body.replace(/\s+/g, ' ');
  if (compact.length >= MIN_LENGTH_FOR_NGRAMS) {
    const seen = new Set<string>();
    const total = compact.length - NGRAM + 1;
    for (let i = 0; i < total; i++) seen.add(compact.slice(i, i + NGRAM));
    distinctRatio = seen.size / total;
  }

  return {
    repetitive: longestRun >= MAX_IDENTICAL_RUN || distinctRatio < MIN_DISTINCT_RATIO,
    longestRun,
    distinctRatio,
  };
}

// ---------------------------------------------------------------------------
// Getting at the text in the first place
// ---------------------------------------------------------------------------

/**
 * The text of a model reply, whatever shape the content arrived in.
 *
 * `Message.content` is a string or a list of parts, and the five lines that
 * flatten it were copy-pasted at seven call sites — with one of them subtly
 * different from the rest. Typed structurally rather than against the engine's
 * Message, so this file still imports nothing.
 */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const part of content) {
    if (part && typeof part === 'object' && 'text' in part) {
      const { type, text } = part as { type?: unknown; text?: unknown };
      if (type === 'text' && typeof text === 'string') out += text;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Whether trying again with more room is worth the time
// ---------------------------------------------------------------------------

/**
 * The cap a second attempt should get, or why it should not get a bigger one.
 *
 * The gate is the whole point of this function, and it is a conjunction of the
 * two checks above rather than any new machinery. A repetition loop that runs
 * into the cap and a genuine truncation are THE SAME OBSERVABLE: both stop at
 * budget, both end mid-sentence, both leave a brace unclosed. Widening on that
 * evidence alone buys a longer loop at roughly double the decode time, and
 * still fails — which on a local model is real seconds per attempt, and on a
 * multi-pass run compounds per pass.
 *
 * So: widen only when the output was cut off AND did not look like a loop.
 * Everything else retries at the same cap or gives up, and says which.
 *
 * `granted` must be the window the ENGINE reported back, not the number in
 * settings — LiteRT-LM does not always give us what we asked for, which is why
 * that value is read back and kept at all.
 */
export type WidenDecision =
  | { widen: true; cap: number }
  | { widen: false; why: 'not-cut-off' | 'looping' | 'no-headroom' };

/** Room left for the system prompt and the chat template, which the input estimate does not cover. */
const PROMPT_RESERVE = 512;

/** Below this much extra room, a second 20-30s generation is not worth starting. */
const WORTH_RETRYING = 128;

export function nextOutputCap(opts: {
  /** The cap the failed attempt ran under. */
  current: number;
  /** The context window the engine granted. */
  granted: number;
  /** Estimated tokens of input this call carries. */
  inputTokens: number;
  /** Why reading the output failed, or null if it failed some other way. */
  reason: ParseFailure | null;
  /** Whether that same output also looked like a repetition loop. */
  repetitive: boolean;
}): WidenDecision {
  const { current, granted, inputTokens, reason, repetitive } = opts;
  // A reply with no JSON in it, or one that is malformed but closed, did not
  // run out of room — it went wrong somewhere more room will not reach.
  if (reason !== 'cut-off') return { widen: false, why: 'not-cut-off' };
  if (repetitive) return { widen: false, why: 'looping' };

  const headroom = granted - inputTokens - PROMPT_RESERVE;
  const cap = Math.min(current * 2, headroom);
  if (cap < current + WORTH_RETRYING) return { widen: false, why: 'no-headroom' };
  return { widen: true, cap: Math.floor(cap) };
}
