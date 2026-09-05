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

function roundTrip(s: Partial<WikiSchema>): WikiSchema {
  return parseSchema(buildSchemaFile({ naming: NAMING, conceptThreshold: 4, ...s }));
}

test('all five data slots survive a rebuild', () => {
  const before: WikiSchema = {
    tags: ['llm-eval', 'retrieval', 'obsidian-plugin'],
    naming: NAMING,
    conceptThreshold: 7,
    pending: ['prompt-injection', 'quantisation'],
    rejected: ['misc', 'todo'],
    aliases: { evals: 'llm-eval', rag: 'retrieval' },
  };
  assert.deepEqual(roundTrip(before), before);
});

test('a hand-edited list survives every subsequent rebuild', () => {
  // The user's actual workflow: edit schema.md by hand, restart, edit again.
  let schema = roundTrip({
    tags: ['alpha'],
    pending: ['beta'],
    rejected: ['gamma'],
    aliases: { delta: 'alpha' },
  });
  for (let i = 0; i < 5; i++) schema = parseSchema(buildSchemaFile(schema));
  assert.deepEqual(schema.tags, ['alpha']);
  assert.deepEqual(schema.pending, ['beta']);
  assert.deepEqual(schema.rejected, ['gamma']);
  assert.deepEqual(schema.aliases, { delta: 'alpha' });
});

test('the rebuilt file is byte-identical when the data has not changed', () => {
  const first = buildSchemaFile({
    tags: ['a', 'b'],
    naming: NAMING,
    pending: ['c'],
    rejected: ['d'],
    aliases: { e: 'a' },
  });
  assert.equal(buildSchemaFile(parseSchema(first)), first);
});

test('deleting a callout does not take the data with it', () => {
  const built = buildSchemaFile({
    tags: ['kept-tag'],
    naming: NAMING,
    conceptThreshold: 9,
    pending: ['waiting'],
    rejected: ['banned'],
    aliases: { old: 'kept-tag' },
  });
  const vandalised = built
    .split('\n')
    .filter((l) => !l.startsWith('> '))
    .join('\n');
  const parsed = parseSchema(vandalised);
  assert.deepEqual(parsed.tags, ['kept-tag']);
  assert.equal(parsed.conceptThreshold, 9);
  assert.deepEqual(parsed.pending, ['waiting']);
  assert.deepEqual(parsed.rejected, ['banned']);
  assert.deepEqual(parsed.aliases, { old: 'kept-tag' });
});

test('a digit inside a callout is not mistaken for the threshold', () => {
  // The parser drops every "> " line for exactly this reason: it takes the
  // FIRST number in the section, and the explanation above the value has
  // digits in it the moment anyone edits the prose.
  const built = buildSchemaFile({ tags: ['a'], naming: NAMING, conceptThreshold: 6 });
  const withDigits = built.replace(
    '## Concept threshold\n',
    '## Concept threshold\n\n> A note to self: I tried 2 and then 3, both too low.\n'
  );
  assert.equal(parseSchema(withDigits).conceptThreshold, 6);
});

test('empty sections read as empty, not as their placeholder text', () => {
  const parsed = parseSchema(buildSchemaFile({ naming: NAMING }));
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
  assert.deepEqual(parsed.aliases, {});
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

// --- Aliases, the sixth slot -----------------------------------------------

test('aliases survive a rebuild like every other slot', () => {
  const parsed = roundTrip({ tags: ['evals'], aliases: { 'llm-eval': 'evals' } });
  assert.deepEqual(parsed.aliases, { 'llm-eval': 'evals' });
});

test('an alias is written and read as a slug', () => {
  assert.deepEqual(roundTrip({ aliases: { 'LLM  Eval': 'Evals' } }).aliases, { 'llm-eval': 'evals' });
});

test('a tag is never recorded as an alias of itself', () => {
  assert.deepEqual(roundTrip({ aliases: { evals: 'evals' } }).aliases, {});
});

test('the "(none)" placeholder is not an alias', () => {
  assert.deepEqual(parseSchema(buildSchemaFile({})).aliases, {});
});

test('the callout above the aliases is not parsed as one', () => {
  // The section's own explanation contains a colon, which is the separator.
  const built = buildSchemaFile({ aliases: { old: 'new' } });
  assert.deepEqual(parseSchema(built).aliases, { old: 'new' });
});

test('hand-written aliases are read', () => {
  const parsed = parseSchema('## Aliases\n\nllm-eval: evals\nrag: retrieval\n');
  assert.deepEqual(parsed.aliases, { 'llm-eval': 'evals', rag: 'retrieval' });
});

test('buildSchemaFile(parseSchema(x)) is the regeneration path and drops nothing', () => {
  // The signature takes one argument shaped like a parsed schema precisely so
  // that this cannot be written wrong at a call site.
  const full = buildSchemaFile({
    tags: ['a'],
    naming: NAMING,
    conceptThreshold: 5,
    pending: ['b'],
    rejected: ['c'],
    aliases: { d: 'a' },
  });
  assert.equal(buildSchemaFile(parseSchema(full)), full);
});
