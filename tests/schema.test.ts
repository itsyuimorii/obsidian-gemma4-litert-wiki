// schema.md: the promise that the lists are yours and the prose is the
// plugin's.
//
// That promise is enforced by regeneration, not by a stamp — on every start
// the file is parsed and rebuilt from the template, so the callouts always
// match the running version while the five data slots ride through untouched.
// Nothing proved the second half of that sentence until this file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSchemaFile, parseSchema, type WikiSchema } from '../src/pure.ts';

const NAMING = { concept: 'kebab-case singular noun', source: "follows the source note's filename" };

function roundTrip(s: {
  tags: string[];
  naming?: Record<string, string>;
  conceptThreshold?: number;
  pending?: string[];
  rejected?: string[];
}): WikiSchema {
  return parseSchema(
    buildSchemaFile(s.tags, s.naming ?? NAMING, s.conceptThreshold ?? 4, s.pending ?? [], s.rejected ?? [])
  );
}

test('all five data slots survive a rebuild', () => {
  const before = {
    tags: ['llm-eval', 'retrieval', 'obsidian-plugin'],
    naming: NAMING,
    conceptThreshold: 7,
    pending: ['prompt-injection', 'quantisation'],
    rejected: ['misc', 'todo'],
  };
  assert.deepEqual(roundTrip(before), before);
});

test('a hand-edited list survives every subsequent rebuild', () => {
  // The user's actual workflow: edit schema.md by hand, restart, edit again.
  let schema = roundTrip({ tags: ['alpha'], pending: ['beta'], rejected: ['gamma'] });
  for (let i = 0; i < 5; i++) {
    schema = parseSchema(
      buildSchemaFile(schema.tags, schema.naming, schema.conceptThreshold, schema.pending, schema.rejected)
    );
  }
  assert.deepEqual(schema.tags, ['alpha']);
  assert.deepEqual(schema.pending, ['beta']);
  assert.deepEqual(schema.rejected, ['gamma']);
});

test('the rebuilt file is byte-identical when the data has not changed', () => {
  const first = buildSchemaFile(['a', 'b'], NAMING, 4, ['c'], ['d']);
  const second = buildSchemaFile(
    parseSchema(first).tags,
    parseSchema(first).naming,
    parseSchema(first).conceptThreshold,
    parseSchema(first).pending,
    parseSchema(first).rejected
  );
  assert.equal(second, first);
});

test('deleting a callout does not take the data with it', () => {
  const built = buildSchemaFile(['kept-tag'], NAMING, 9, ['waiting'], ['banned']);
  const vandalised = built
    .split('\n')
    .filter((l) => !l.startsWith('> '))
    .join('\n');
  const parsed = parseSchema(vandalised);
  assert.deepEqual(parsed.tags, ['kept-tag']);
  assert.equal(parsed.conceptThreshold, 9);
  assert.deepEqual(parsed.pending, ['waiting']);
  assert.deepEqual(parsed.rejected, ['banned']);
});

test('a digit inside a callout is not mistaken for the threshold', () => {
  // The parser drops every "> " line for exactly this reason: it takes the
  // FIRST number in the section, and the explanation above the value has
  // digits in it the moment anyone edits the prose.
  const built = buildSchemaFile(['a'], NAMING, 6);
  const withDigits = built.replace(
    '## Concept threshold\n',
    '## Concept threshold\n\n> A note to self: I tried 2 and then 3, both too low.\n'
  );
  assert.equal(parseSchema(withDigits).conceptThreshold, 6);
});

test('empty sections read as empty, not as their placeholder text', () => {
  const parsed = parseSchema(buildSchemaFile([], NAMING, 4, [], []));
  assert.deepEqual(parsed.tags, []);
  assert.deepEqual(parsed.pending, []);
  assert.deepEqual(parsed.rejected, []);
});

test('tags are written as slugs, so a rebuild is stable', () => {
  const parsed = roundTrip({ tags: ['LLM Eval', 'Retrieval  Augmented'] });
  assert.deepEqual(parsed.tags, ['llm-eval', 'retrieval-augmented']);
  // And the second pass changes nothing further.
  assert.deepEqual(roundTrip({ tags: parsed.tags }).tags, parsed.tags);
});

test('a missing section falls back instead of throwing', () => {
  const parsed = parseSchema('# Wiki Schema\n\nnothing here at all\n');
  assert.deepEqual(parsed.tags, []);
  assert.deepEqual(parsed.pending, []);
  assert.deepEqual(parsed.rejected, []);
  assert.equal(typeof parsed.conceptThreshold, 'number');
  assert.ok(Object.keys(parsed.naming).length > 0, 'naming falls back to the default');
});

test('a section stops at the next heading', () => {
  const parsed = parseSchema(
    '## Tags\n\n- alpha\n- beta\n\n## Rejected\n\n- gamma\n'
  );
  assert.deepEqual(parsed.tags, ['alpha', 'beta']);
  assert.deepEqual(parsed.rejected, ['gamma']);
});

test('non-Latin tags survive the round trip', () => {
  const parsed = roundTrip({ tags: ['設計', 'डिज़ाइन', 'дизайн'] });
  assert.deepEqual(parsed.tags, ['設計', 'डिज़ाइन', 'дизайн']);
});
