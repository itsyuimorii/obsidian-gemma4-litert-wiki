// Standing instructions: the one setting that reaches into every chat
// system prompt. It has to be invisible when empty, honest when cut, and
// always subordinate to the grounding rules — an instruction changes how an
// answer is written, never what it may stand on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_INSTRUCTIONS_MAX, standingInstructions } from '../src/pure.ts';

test('empty and whitespace-only text leave the prompt untouched', () => {
  assert.equal(standingInstructions(''), '');
  assert.equal(standingInstructions('   \n\t '), '');
});

test('text is carried verbatim after a header that subordinates it to the grounding rules', () => {
  const out = standingInstructions('Answer in Japanese.\nKeep it under 150 words.');
  assert.ok(out.startsWith('\n\n'), 'separated from the prompt above by a blank line');
  assert.ok(out.includes('the rules above win'), 'grounding rules take precedence');
  assert.ok(out.endsWith('Answer in Japanese.\nKeep it under 150 words.'), 'line breaks preserved');
});

test('surrounding whitespace is trimmed, inner whitespace is not', () => {
  const out = standingInstructions('  Be brief.  Use British spelling.  ');
  assert.ok(out.endsWith('\nBe brief.  Use British spelling.'));
});

test('text over the cap is cut and the cut is marked', () => {
  const long = 'x'.repeat(CHAT_INSTRUCTIONS_MAX + 500);
  const out = standingInstructions(long);
  assert.ok(out.endsWith(`[…cut at ${CHAT_INSTRUCTIONS_MAX} characters]`));
  const body = out.slice(out.lastIndexOf('\n') + 1);
  assert.equal(body.indexOf(' […cut'), CHAT_INSTRUCTIONS_MAX);
});

test('text exactly at the cap is not cut', () => {
  const exact = 'y'.repeat(CHAT_INSTRUCTIONS_MAX);
  assert.ok(standingInstructions(exact).endsWith(exact));
  assert.ok(!standingInstructions(exact).includes('cut at'));
});

test('a custom cap is honoured', () => {
  const out = standingInstructions('abcdefghij', 4);
  assert.ok(out.endsWith('abcd […cut at 4 characters]'));
});

test('a cut never ends on trailing whitespace before the marker', () => {
  const out = standingInstructions('abc   def', 5);
  assert.ok(out.endsWith('abc […cut at 5 characters]'));
});
