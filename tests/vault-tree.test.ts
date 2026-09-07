import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatVaultTree } from '../src/pure.ts';

test('folders nest, counts are recursive, siblings sort by name', () => {
  const out = formatVaultTree([
    'research/b.md', 'research/a.md', 'research/sub/c.md', 'daily/2026-01-01.md',
  ]);
  assert.equal(out, 'daily/ (1)\nresearch/ (3)\n  sub/ (1)');
});

test('root-level notes collapse to one line', () => {
  assert.equal(formatVaultTree(['a.md', 'b.md', 'x/c.md']), 'x/ (1)\n(root) 2 loose notes');
  assert.equal(formatVaultTree(['a.md']), '(root) 1 loose note');
});

test('the wiki folder is excluded and non-markdown is ignored', () => {
  const out = formatVaultTree(['gemma-wiki/cards/a.md', 'notes/a.md', 'notes/img.png'], { exclude: 'gemma-wiki' });
  assert.equal(out, 'notes/ (1)');
});

test('output is capped', () => {
  const paths = Array.from({ length: 50 }, (_, i) => `f${String(i).padStart(2, '0')}/n.md`);
  const out = formatVaultTree(paths, { maxLines: 5 });
  assert.equal(out.split('\n').length, 6); // 5 lines + ellipsis
  assert.ok(out.endsWith('…'));
});

test('empty vault renders empty', () => {
  assert.equal(formatVaultTree([]), '');
});
