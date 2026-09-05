// Which file a note's card lands in.
//
// Both collisions below were live bugs with the same signature: the second
// ingest overwrote the first, the first then had no card, so the next scan
// offered it again, which overwrote the second. Two notes bouncing off each
// other forever, and nothing said so.

import test from 'node:test';
import assert from 'node:assert/strict';
import { pickCardPath, type CardPathQuery } from '../src/pure.ts';

const DIR = 'gemma-wiki/sources';

/** A vault whose taken paths are whatever you say they are. */
function ask(
  path: string,
  opts: { taken?: string[]; existing?: string | null; reserved?: Set<string> } = {}
): string {
  const taken = new Set(opts.taken ?? []);
  const segments = path.split('/');
  const q: CardPathQuery = {
    dir: DIR,
    existing: opts.existing ?? null,
    path,
    basename: segments[segments.length - 1].replace(/\.md$/, ''),
    parentName: segments.length > 1 ? segments[segments.length - 2] : '',
    isTaken: (p) => taken.has(p),
    normalize: (p) => p,
    reserved: opts.reserved,
  };
  return pickCardPath(q);
}

test('the plain basename is used while it is free', () => {
  assert.equal(ask('projects/README.md'), `${DIR}/readme.md`);
});

test('two README.md in different folders do not collide', () => {
  const first = ask('projects/alpha/README.md');
  const second = ask('projects/beta/README.md', { taken: [first] });
  assert.equal(first, `${DIR}/readme.md`);
  assert.equal(second, `${DIR}/beta-readme.md`);
  assert.notEqual(first, second);
});

test('a third README.md still gets its own card', () => {
  const paths: string[] = [];
  for (const p of ['a/README.md', 'b/README.md', 'c/README.md', 'd/README.md']) {
    paths.push(ask(p, { taken: [...paths] }));
  }
  assert.equal(new Set(paths).size, paths.length, `collided: ${paths.join(', ')}`);
});

test('two CJK-titled notes do not both collapse to untitled.md', () => {
  const first = ask('notes/设计模式.md');
  const second = ask('notes/観察日記.md', { taken: [first] });
  assert.notEqual(first, second);
  for (const p of [first, second]) {
    assert.ok(!p.endsWith('/untitled.md'), `${p} lost its name`);
  }
});

test('a note that already has a card keeps it, whatever its name', () => {
  const existing = `${DIR}/something-else-entirely.md`;
  assert.equal(ask('projects/README.md', { existing, taken: [existing] }), existing);
});

test('reserved names stop two drafts in one batch from picking the same card', () => {
  // A scan drafts before it writes, so the vault says "free" for both.
  const reserved = new Set<string>();
  const first = ask('a/README.md', { reserved });
  const second = ask('b/README.md', { reserved });
  assert.notEqual(first, second);
  assert.equal(reserved.size, 2);
});

test('the answer is the same on every call for the same note', () => {
  const args = { taken: [`${DIR}/readme.md`, `${DIR}/beta-readme.md`] };
  const runs = new Set(Array.from({ length: 20 }, () => ask('projects/beta/README.md', args)));
  assert.equal(runs.size, 1, [...runs].join(', '));
});

test('a name is always produced, even past the counted candidates', () => {
  // 99 notes sharing a basename and a folder is not a real vault, but a
  // deterministic collision beats returning undefined.
  const taken = [`${DIR}/readme.md`, `${DIR}/x-readme.md`, `${DIR}/x-readme.md`];
  for (let n = 2; n <= 99; n++) taken.push(`${DIR}/readme-${n}.md`);
  const out = ask('x/README.md', { taken });
  assert.ok(out.startsWith(`${DIR}/`) && out.endsWith('.md'), out);
});

test('every card lands inside the sources directory', () => {
  for (const p of ['README.md', 'a/b/c/日記.md', 'weird ~ name!.md', '.../x.md']) {
    assert.ok(ask(p).startsWith(`${DIR}/`), `${p} -> ${ask(p)}`);
  }
});
