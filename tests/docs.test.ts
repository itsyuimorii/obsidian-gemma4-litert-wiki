// Docs freshness: a command name printed anywhere in this repo has to be a
// command that exists.
//
// The Tidy merge turned five commands into one and left the old five names in
// README.md and in the vault docs the plugin generates. They sat there for
// days — nothing builds the docs, nothing type-checks a string — until someone
// opened schema.md and read it. A reviewer comparing the README against the
// palette is the other person who finds this, and by then it is a rejection.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const MAIN = read('src/main.ts');
const README = read('README.md');
const README_JA = read('README.ja.md');

/** Every command the plugin registers, exactly as the palette shows it. */
const COMMANDS = [...MAIN.matchAll(/name: '([^']+)',/g)].map((m) => m[1]);

/**
 * Command names that were removed and must not be named as commands again.
 *
 * Five became one when Tidy landed. This list is the only hand-maintained
 * thing in this file, and the price of that is one line when a command is
 * retired — which is the same moment the docs need editing anyway. The test
 * below asserts nothing on it has quietly come back, so a stale entry fails
 * loudly rather than silently checking nothing.
 */
const RETIRED = [
  'Lint wiki (orphans and index health)',
  'Organize tags (schema.md, local Gemma)',
  'Reconcile wiki (drop links to deleted pages)',
  'Relink wiki pages (fill or re-sync Related sections)',
  'Retag wiki pages to vocabulary (local Gemma)',
  // The short forms the docs actually used. `Organize` and `Retag` on their
  // own are deliberately absent: both still name a live Tidy repair and a
  // Settings button, so banning the bare words would fail on correct prose.
  'Lint wiki',
  'Reconcile wiki',
  'Relink wiki pages',
  'Retag wiki pages',
];

/** Rows of every `| Command | What it does |` table in a README. */
function commandTableRows(markdown: string): string[] {
  const rows: string[] = [];
  let inTable = false;
  for (const line of markdown.split('\n')) {
    if (/^\|\s*(Command|コマンド)\s*\|/.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.startsWith('|')) {
      inTable = false;
      continue;
    }
    if (/^\|[\s-|]+\|$/.test(line)) continue; // the --- separator
    const name = line.match(/^\|\s*\*\*([^*]+)\*\*/);
    if (name) rows.push(name[1].trim());
  }
  return rows;
}

test('command names are unique', () => {
  assert.equal(new Set(COMMANDS).size, COMMANDS.length, COMMANDS.join(' | '));
});

test('the command tables found something at all', () => {
  // A parser that silently matches nothing is a test that silently passes.
  assert.ok(COMMANDS.length >= 10, `only found ${COMMANDS.length} commands`);
  assert.ok(commandTableRows(README).length >= 10, 'no command table rows in README.md');
  assert.ok(commandTableRows(README_JA).length >= 10, 'no command table rows in README.ja.md');
});

for (const [name, md] of [['README.md', README], ['README.ja.md', README_JA]] as const) {
  test(`every command table row in ${name} names a command that exists`, () => {
    const live = new Set(COMMANDS);
    const dead = commandTableRows(md).filter((r) => !live.has(r));
    assert.deepEqual(dead, [], `documented but not registered: ${dead.join(' | ')}`);
  });

  test(`every command is in a command table in ${name}`, () => {
    const documented = new Set(commandTableRows(md));
    const missing = COMMANDS.filter((c) => !documented.has(c));
    assert.deepEqual(missing, [], `registered but undocumented: ${missing.join(' | ')}`);
  });
}

test('the "when to run what" table points at commands that exist', () => {
  // This table names commands in short form — `**Tidy the wiki**` for
  // `Tidy the wiki (check, then fix what you approve)` — so each one has to
  // be the start of a real command name.
  const rows = README.split('\n').filter((l) => /^\| .+ \| \*\*/.test(l) && l.split('|').length === 5);
  const named = rows.flatMap((r) => [...r.split('|')[2].matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]));
  assert.ok(named.length >= 4, `parsed ${named.length} references; the table moved`);
  for (const ref of named) {
    assert.ok(
      COMMANDS.some((c) => c === ref || c.startsWith(`${ref} `)),
      `"${ref}" is not the name of any command`
    );
  }
});

test('no retired command name has come back', () => {
  const live = new Set(COMMANDS);
  const resurrected = RETIRED.filter((r) => live.has(r));
  assert.deepEqual(resurrected, [], `remove these from RETIRED: ${resurrected.join(' | ')}`);
});

test('no retired command is still named in the docs, generated or written', () => {
  // src/ is included because the vault docs the plugin writes — schema.md,
  // every folder README — are string literals in there, and that is where
  // the five dead names actually survived.
  const surfaces: [string, string][] = [
    ['README.md', README],
    ['README.ja.md', README_JA],
    ...fs
      .readdirSync(path.join(ROOT, 'src'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => [`src/${f}`, read(`src/${f}`)] as [string, string]),
  ];
  const found: string[] = [];
  for (const [where, text] of surfaces) {
    for (const dead of RETIRED) {
      if (text.includes(dead)) found.push(`${where}: "${dead}"`);
    }
  }
  assert.deepEqual(found, [], found.join('\n'));
});
