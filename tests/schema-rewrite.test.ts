// The startup rewrite of schema.md, and when it must not happen.
//
// Three of the six data slots — Tags, Rejected, hand-written Aliases — have no
// source to rebuild from, and a parse that loses everything returns the same
// shape as a schema that legitimately holds nothing. So the plan below is the
// difference between "regenerated the callouts" and "wrote a correct-looking
// empty file over the user's veto list".

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSchemaFile,
  parseSchema,
  planSchemaRewrite,
  schemaBackupName,
  schemaBackupsToPrune,
  SCHEMA_BACKUP_KEEP,
  slugify,
} from '../src/pure.ts';

const FULL = {
  tags: ['llm-eval', 'retrieval'],
  naming: { concept: 'kebab-case singular noun', source: "follows the source note's filename" },
  conceptThreshold: 4,
  pending: ['quantisation'],
  rejected: ['misc'],
  aliases: { evals: 'llm-eval' },
};

// --- when nothing should happen --------------------------------------------

test('a freshly built schema is left alone', () => {
  assert.deepEqual(planSchemaRewrite(buildSchemaFile(FULL)), { kind: 'unchanged' });
  assert.deepEqual(planSchemaRewrite(buildSchemaFile({})), { kind: 'unchanged' });
});

test('a legitimately empty schema is NOT mistaken for a lossy parse', () => {
  // The fresh template parses to empty lists AND is several KB long — a guard
  // keyed on "empty parse + non-trivial file" would refuse to maintain every
  // new user's schema forever. The guard is keyed on visible bullets instead,
  // and the fresh template has none outside its callouts.
  const fresh = buildSchemaFile({});
  const plan = planSchemaRewrite(fresh);
  assert.equal(plan.kind, 'unchanged');
});

// --- when a rewrite is right ------------------------------------------------

test('a hand-edit that adds prose is rewritten, and the data survives', () => {
  const edited = buildSchemaFile(FULL) + '\nSome stray thought I typed here.\n';
  const plan = planSchemaRewrite(edited);
  assert.equal(plan.kind, 'rewrite');
  if (plan.kind === 'rewrite') {
    assert.deepEqual(parseSchema(plan.content), parseSchema(edited));
  }
});

test('deleted callouts come back, and the data survives', () => {
  const vandalised = buildSchemaFile(FULL)
    .split('\n')
    .filter((l) => !l.startsWith('> '))
    .join('\n');
  const plan = planSchemaRewrite(vandalised);
  assert.equal(plan.kind, 'rewrite');
  if (plan.kind === 'rewrite') {
    assert.ok(plan.content.includes('> [!info]-'), 'callouts restored');
    assert.deepEqual(parseSchema(plan.content), parseSchema(vandalised));
  }
});

test('an empty file is regenerated into a fresh template', () => {
  const plan = planSchemaRewrite('');
  assert.equal(plan.kind, 'rewrite');
  if (plan.kind === 'rewrite') assert.equal(plan.content, buildSchemaFile(parseSchema('')));
});

// --- when a rewrite must be refused -----------------------------------------

test('a reworded section header does not cost the user their lists', () => {
  // The exact failure from the issue: the user renames "## Tags" and the
  // parser stops seeing the list, so a rewrite would hand back an
  // empty-but-valid file. The dumb line scan still sees the bullets.
  const reworded = buildSchemaFile({ tags: ['llm-eval', 'retrieval'] }).replace('## Tags', '## My Tags');
  assert.deepEqual(parseSchema(reworded).tags, [], 'the parser really does lose them');
  assert.deepEqual(planSchemaRewrite(reworded), { kind: 'refuse', why: 'unreadable-lists' });
});

test('a partial file with visible bullets and an empty parse is refused', () => {
  const partial = '# Wiki Schema\n\nTags\n\n- llm-eval\n- retrieval\n';
  assert.deepEqual(planSchemaRewrite(partial), { kind: 'refuse', why: 'unreadable-lists' });
});

test('bullets inside callouts do not trigger the refusal', () => {
  const fresh = buildSchemaFile({}) + '\n> [!info]- A note\n> - just an example bullet in prose\n';
  const plan = planSchemaRewrite(fresh);
  assert.notEqual(plan.kind, 'refuse', JSON.stringify(plan));
});

test('placeholder lines are not counted as data', () => {
  // "(none)" renders as a bullet in no section, but a user might write it as
  // one; either way it names nothing.
  const withPlaceholder = buildSchemaFile({}) + '\n- (none)\n';
  assert.notEqual(planSchemaRewrite(withPlaceholder).kind, 'refuse');
});

// --- the property that holds over everything --------------------------------

test('no permitted rewrite ever changes the parsed data', () => {
  const nasty = [
    buildSchemaFile(FULL),
    buildSchemaFile(FULL).replace(/> .*\n/g, ''),
    buildSchemaFile({ tags: ['設計', 'डिज़ाइन'] }),
    buildSchemaFile(FULL) + '\n## Extra\n\nsome prose\n',
    '## Tags\n\n- LLM Eval\n- Retrieval  Augmented\n\n## Rejected\n\n- Misc\n',
    '## Aliases\n\nllm-eval: evals\n',
    '# Wiki Schema\n\nnothing at all\n',
    '',
  ];
  for (const current of nasty) {
    const plan = planSchemaRewrite(current);
    if (plan.kind !== 'rewrite') continue;
    const before = parseSchema(current);
    const after = parseSchema(plan.content);
    // The rewrite may normalize (slugify) but may not lose or invent.
    assert.deepEqual(after.tags, before.tags.map((t) => slugify(t)), current.slice(0, 40));
    assert.deepEqual(after.pending, before.pending.map((t) => slugify(t)));
    assert.deepEqual(after.rejected, before.rejected.map((t) => slugify(t)));
    assert.equal(after.conceptThreshold, before.conceptThreshold);
    assert.deepEqual(Object.keys(after.aliases).sort(), Object.keys(before.aliases).map((k) => slugify(k)).sort());
  }
});

test('a permitted rewrite is a fixed point: rewriting it again changes nothing', () => {
  const plan = planSchemaRewrite(buildSchemaFile(FULL) + '\nstray\n');
  assert.equal(plan.kind, 'rewrite');
  if (plan.kind === 'rewrite') {
    assert.deepEqual(planSchemaRewrite(plan.content), { kind: 'unchanged' });
  }
});

// --- the backup names --------------------------------------------------------

test('backup names are Windows-safe and sort by age', () => {
  const a = schemaBackupName(new Date(2026, 8, 6, 9, 5, 3));
  const b = schemaBackupName(new Date(2026, 8, 6, 14, 22, 33));
  const c = schemaBackupName(new Date(2026, 11, 1, 0, 0, 0));
  assert.equal(a, 'schema.md.bak.20260906-090503');
  for (const n of [a, b, c]) assert.ok(!/[\\/:*?"<>|]/.test(n), n);
  assert.deepEqual([c, a, b].sort(), [a, b, c], 'lexicographic order is age order');
});

test('pruning keeps the newest and only touches backups', () => {
  const names = [
    'schema.md',
    'index.md',
    'schema.md.bak.20260901-120000',
    'schema.md.bak.20260903-120000',
    'schema.md.bak.20260902-120000',
    'unrelated.md.bak.20260904-120000',
  ];
  assert.deepEqual(schemaBackupsToPrune(names, 2), ['schema.md.bak.20260901-120000']);
  assert.deepEqual(schemaBackupsToPrune(names, 5), []);
  assert.deepEqual(schemaBackupsToPrune(['schema.md'], 5), []);
});

test('the keep limit is a real number and pruning honours zero', () => {
  assert.ok(SCHEMA_BACKUP_KEEP >= 1);
  const names = ['schema.md.bak.20260901-120000', 'schema.md.bak.20260902-120000'];
  assert.deepEqual(schemaBackupsToPrune(names, 0), names);
});
