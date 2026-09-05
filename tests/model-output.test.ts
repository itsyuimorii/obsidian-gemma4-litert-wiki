// Reading a small model's reply: where the JSON is, whether the run finished,
// and whether it collapsed into a loop.
//
// The false-positive cases matter as much as the true ones here. A wrong
// "this looks like a loop" throws away a good generation and spends another
// twenty seconds asking again, so the ordinary-prose samples below are load
// bearing, not padding.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  looksCutOff,
  looksRepetitive,
  nextOutputCap,
  parseModelJson,
  scanJsonObject,
  textOf,
} from '../src/model-output.ts';

// --- where the JSON is -----------------------------------------------------

test('a bare object is found', () => {
  assert.deepEqual(scanJsonObject('{"a":1}'), { kind: 'ok', json: '{"a":1}' });
});

test('fences are just uninteresting text around the braces', () => {
  for (const wrapper of [
    '```json\n{"a":1}\n```',
    '```JSON\n{"a":1}\n```',
    '```\n{"a":1}\n```',
    'Here is the JSON you asked for:\n```json\n{"a":1}\n```\nHope that helps!',
  ]) {
    assert.deepEqual(scanJsonObject(wrapper), { kind: 'ok', json: '{"a":1}' }, wrapper);
  }
});

test('a preamble before the fence no longer breaks it', () => {
  // The fence-stripping strategy stripped only from the ends, so a sentence
  // in front of the fence left the fence in the string it tried to parse.
  const raw = 'Sure! Here you go.\n\n```json\n{"summary":"x"}\n```';
  assert.equal(parseModelJson<{ summary: string }>(raw).ok, true);
});

test('prose after the object no longer swallows it', () => {
  // The greedy /\{[\s\S]*\}/ ran to the LAST brace anywhere in the reply.
  const raw = '{"a":1}\n\nNote: I used {} for the empty case.';
  assert.deepEqual(scanJsonObject(raw), { kind: 'ok', json: '{"a":1}' });
  assert.deepEqual(parseModelJson(raw), { ok: true, value: { a: 1 } });
});

test('a second object does not get merged into the first', () => {
  const raw = '{"a":1}\n{"b":2}';
  assert.deepEqual(parseModelJson(raw), { ok: true, value: { a: 1 } });
});

test('nested objects close at the right brace', () => {
  const raw = 'x {"a":{"b":{"c":1}},"d":2} y';
  assert.deepEqual(parseModelJson(raw), { ok: true, value: { a: { b: { c: 1 } }, d: 2 } });
});

test('a brace inside a string does not close the object', () => {
  const raw = '{"summary":"use } to close a block","tags":["a"]}';
  const out = parseModelJson<{ summary: string }>(raw);
  assert.equal(out.ok && out.value.summary, 'use } to close a block');
});

test('an escaped quote does not end the string', () => {
  const raw = '{"summary":"he said \\"} hi\\" and left"}';
  const out = parseModelJson<{ summary: string }>(raw);
  assert.equal(out.ok && out.value.summary, 'he said "} hi" and left');
});

test('a reply with no object at all says so', () => {
  for (const raw of ['', 'I am not able to help with that.', '[1,2,3]', '   ']) {
    assert.deepEqual(scanJsonObject(raw), { kind: 'none' }, JSON.stringify(raw));
    assert.deepEqual(parseModelJson(raw), { ok: false, reason: 'no-json' });
  }
});

test('an object that never closes is reported as cut off, not as empty', () => {
  // This is the whole point: a run that ended mid-object used to be
  // indistinguishable from a model that found nothing.
  const raw = '{"unsupported":["the first claim","the second cla';
  const scan = scanJsonObject(raw);
  assert.equal(scan.kind, 'unterminated');
  assert.deepEqual(parseModelJson(raw), { ok: false, reason: 'cut-off' });
});

test('malformed but closed JSON is its own failure', () => {
  assert.deepEqual(parseModelJson('{"a": }'), { ok: false, reason: 'invalid-json' });
  assert.deepEqual(parseModelJson("{'a': 1}"), { ok: false, reason: 'invalid-json' });
});

test('the three failures are distinguishable from each other and from success', () => {
  const reasons = ['no-json', 'cut-off', 'invalid-json'];
  const got = ['no json here', '{"a":', '{"a": }'].map((r) => {
    const out = parseModelJson(r);
    return out.ok ? 'ok' : out.reason;
  });
  assert.deepEqual(got, reasons);
});

// --- whether the run finished ----------------------------------------------

test('an answer that ends a sentence is not cut off, however long', () => {
  const text = 'The cache is invalidated whenever the prompt prefix changes.';
  assert.equal(looksCutOff(text, 20).cutOff, false);
  assert.equal(looksCutOff(text, 4096).cutOff, false);
});

test('a short answer with no full stop is not cut off either', () => {
  // Plenty of good answers end without terminal punctuation; on its own that
  // signal is far too eager.
  assert.equal(looksCutOff('- alpha\n- beta\n- gamma', 4096).cutOff, false);
  assert.equal(looksCutOff('yes', 4096).cutOff, false);
});

test('at the budget and mid-sentence is the case worth flagging', () => {
  const text = 'The cache is invalidated whenever the prompt prefix changes, which means that';
  const report = looksCutOff(text, 20);
  assert.equal(report.atBudget, true);
  assert.equal(report.midSentence, true);
  assert.equal(report.cutOff, true);
});

test('with no budget stated, nothing is claimed', () => {
  assert.equal(looksCutOff('trailing off mid sen').cutOff, false);
  assert.equal(looksCutOff('trailing off mid sen', 0).cutOff, false);
});

test('CJK terminal punctuation counts as finished', () => {
  assert.equal(looksCutOff('プロンプトの接頭辞が変わるたびに無効になります。', 5).midSentence, false);
  assert.equal(looksCutOff('缓存会在提示前缀改变时失效。', 5).midSentence, false);
});

test('a closing quote or bracket after the full stop still counts as finished', () => {
  assert.equal(looksCutOff('He said "the cache is invalidated."', 5).midSentence, false);
  assert.equal(looksCutOff('(the cache is invalidated.)', 5).midSentence, false);
});

test('empty output is not called mid-sentence', () => {
  assert.equal(looksCutOff('', 100).midSentence, false);
  assert.equal(looksCutOff('   ', 100).cutOff, false);
});

// --- whether it collapsed into a loop --------------------------------------

test('one phrase repeated forty times is a loop', () => {
  // The exact shape that passes every shape check: a valid string, in a valid
  // object, that is forty copies of one sentence.
  const looped = 'The note discusses caching. '.repeat(40);
  assert.equal(looksRepetitive(looped).repetitive, true);
  const raw = JSON.stringify({ summary: looped, tags: ['a', 'b', 'c'] });
  const parsed = parseModelJson<{ summary: string }>(raw);
  assert.equal(parsed.ok, true, 'the shape checks pass — that is the problem');
  assert.equal(parsed.ok && looksRepetitive(parsed.value.summary).repetitive, true);
});

test('a loop with no punctuation at all is caught too', () => {
  // The common CJK shape: one clause emitted over and over, no terminator, so
  // the whole thing is a single enormous "sentence".
  const looped = 'このノートはキャッシュについて説明しています'.repeat(30);
  assert.equal(looksRepetitive(looped).repetitive, true);
  assert.ok(looksRepetitive(looped).distinctRatio < 0.2);
});

test('ordinary prose is not a loop', () => {
  const real =
    'The plugin keeps a separate wiki layer and never edits the note itself. ' +
    'Each ingest writes one card, carrying a summary, three tags and a handful of key points. ' +
    'Retrieval reads the index first and then opens only the pages it points at, ' +
    'which keeps the prompt inside a context window that is genuinely small. ' +
    'Concept pages sit above the cards and link down into each of them.';
  const report = looksRepetitive(real);
  assert.equal(report.repetitive, false, JSON.stringify(report));
});

test('ordinary CJK prose is not a loop', () => {
  const real =
    '这个插件把生成的内容放在单独的 wiki 目录里，从不改动原始笔记。' +
    '每次录入会写一张卡片，包含摘要、三个标签和几条要点。' +
    '检索先读索引，再打开索引指向的页面，这样提示词才装得下很小的上下文窗口。' +
    '概念页在卡片之上，向下链接到每一张卡片。';
  assert.equal(looksRepetitive(real).repetitive, false);
});

test('a structurally repetitive but real answer is not a loop', () => {
  // Lists and tables repeat their scaffolding on purpose. Flagging these
  // would discard good generations.
  const list = [
    '- **Caching**: the prompt prefix decides when it is invalidated.',
    '- **Retrieval**: the index is read before any page is opened.',
    '- **Concepts**: a page above every card that shares a tag.',
    '- **Provenance**: each key point is traced back to a sentence.',
    '- **Contradictions**: pages sharing a tag are checked against each other.',
  ].join('\n');
  assert.equal(looksRepetitive(list).repetitive, false, JSON.stringify(looksRepetitive(list)));

  const table = [
    '| Command | What it does |',
    '|---|---|',
    '| Ingest | Writes one card for the open note. |',
    '| Scan | Writes a card for every changed note in a folder. |',
    '| Tidy | Checks the wiki, then fixes what you approve. |',
  ].join('\n');
  assert.equal(looksRepetitive(table).repetitive, false, JSON.stringify(looksRepetitive(table)));
});

test('a sentence repeated twice or three times is not yet a loop', () => {
  // Deliberate: the threshold sits where only an unambiguous loop trips it,
  // because the cost of a false positive is throwing away good output.
  const twice = 'This matters. This matters. And here is a different thought entirely to follow it.';
  assert.equal(looksRepetitive(twice).repetitive, false);
});

test('short text is never judged by the n-gram measure', () => {
  assert.equal(looksRepetitive('ok').distinctRatio, 1);
  assert.equal(looksRepetitive('').repetitive, false);
});

test('the report carries the numbers, so the thresholds can be calibrated', () => {
  const report = looksRepetitive('a b c. '.repeat(50));
  assert.equal(typeof report.longestRun, 'number');
  assert.equal(typeof report.distinctRatio, 'number');
  assert.ok(report.longestRun >= 5);
});

// --- getting at the text ---------------------------------------------------

test('textOf handles both shapes a reply arrives in', () => {
  assert.equal(textOf('plain string'), 'plain string');
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab');
});

test('textOf skips parts that are not text', () => {
  assert.equal(
    textOf([
      { type: 'image', data: 'xxx' },
      { type: 'text', text: 'kept' },
      { type: 'text' },
      { type: 'text', text: 42 },
    ]),
    'kept'
  );
});

test('textOf never throws on a shape it did not expect', () => {
  for (const junk of [undefined, null, 0, {}, [null], [undefined], [{ text: 'no type' }]]) {
    assert.equal(typeof textOf(junk), 'string', JSON.stringify(junk ?? null));
  }
});

// --- whether a second attempt should get more room -------------------------

const widen = (over: Partial<Parameters<typeof nextOutputCap>[0]> = {}) =>
  nextOutputCap({
    current: 768,
    granted: 4096,
    inputTokens: 1200,
    reason: 'cut-off',
    repetitive: false,
    ...over,
  });

test('a cut-off run that was not looping gets more room', () => {
  assert.deepEqual(widen(), { widen: true, cap: 1536 });
});

test('a cut-off run that WAS looping gets no more room', () => {
  // The gate. A repetition loop that runs into the cap and a genuine
  // truncation are the same observable — both stop at budget, both end
  // mid-sentence, both leave a brace open. Widening on that evidence buys a
  // longer loop at double the decode time and still fails.
  assert.deepEqual(widen({ repetitive: true }), { widen: false, why: 'looping' });
});

test('a failure that is not truncation is not a room problem', () => {
  for (const reason of ['no-json', 'invalid-json', null] as const) {
    assert.deepEqual(widen({ reason }), { widen: false, why: 'not-cut-off' }, String(reason));
  }
});

test('the widened cap never eats the context the input needs', () => {
  // A long note leaves little room; doubling would overrun the window.
  const out = widen({ current: 768, granted: 4096, inputTokens: 3000 });
  assert.equal(out.widen, false);
  assert.equal(out.widen === false && out.why, 'no-headroom');
});

test('a cap is only widened by an amount worth another generation', () => {
  // 100 extra tokens does not justify another 20-30 seconds.
  const out = nextOutputCap({
    current: 768,
    granted: 768 + 100 + 512 + 1,
    inputTokens: 1,
    reason: 'cut-off',
    repetitive: false,
  });
  assert.deepEqual(out, { widen: false, why: 'no-headroom' });
});

test('headroom caps the widening below a plain doubling', () => {
  // Doubling would be 1536; the window only affords 1300.
  const out = nextOutputCap({
    current: 768,
    granted: 1300 + 200 + 512,
    inputTokens: 200,
    reason: 'cut-off',
    repetitive: false,
  });
  assert.deepEqual(out, { widen: true, cap: 1300 });
});

test('the granted window is what bounds it, so a smaller grant widens less', () => {
  const generous = widen({ granted: 8192 });
  const tight = widen({ granted: 3000 });
  assert.deepEqual(generous, { widen: true, cap: 1536 }, 'room to double');
  assert.deepEqual(tight, { widen: true, cap: 1288 }, 'bounded by the grant');

  // Tighter still, and it stops being worth a second generation at all.
  assert.deepEqual(widen({ granted: 2600 }), { widen: false, why: 'no-headroom' });
});

test('the decision is a pure function of its inputs', () => {
  const args = { current: 512, granted: 4096, inputTokens: 900, reason: 'cut-off' as const, repetitive: false };
  const first = JSON.stringify(nextOutputCap(args));
  for (let i = 0; i < 10; i++) assert.equal(JSON.stringify(nextOutputCap(args)), first);
});
