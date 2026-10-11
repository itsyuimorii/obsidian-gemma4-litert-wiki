// The model-free checks, run for real against a vault that lives in memory.
//
// tests/*.test.ts mostly reach src/pure.ts, the half of the plugin that does
// not touch Obsidian. That proves the rules and says nothing about whether
// the commands apply them: whether Tidy reads the threshold out of
// schema.md, whether the review board looks at the card's own mentions,
// whether the spot-check skips a page whose note is gone. These call the
// functions the commands call — runLint, buildReviewBoard, sampleWikiPages
// — with frontmatter and files they have to find for themselves.
//
// What this still cannot say is what the model answers, or what a dialog
// looks like. Both need Obsidian.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeVault } from './helpers/fake-vault.ts';
import { contentHash, DEFAULT_CONCEPT_THRESHOLD, pickHistory, type HistoryTurn } from '../src/pure.ts';

// After the helper: it is what lets these three resolve 'obsidian'.
const { runLint } = await import('../src/lint.ts');
const { buildReviewBoard } = await import('../src/review-board.ts');
const { sampleWikiPages } = await import('../src/provenance.ts');
const { estimateTokens } = await import('../src/wiki-store.ts');

type App = Parameters<typeof runLint>[0];
const asApp = (v: { app: unknown }) => v.app as App;

const TODAY = new Date().toISOString().slice(0, 10);
const NOTE = 'The perfect espresso shot uses 18 grams of coffee and extracts for 28 seconds with a burr grinder.';

/** A card as ingest writes one, about notes/<name>.md. */
function card(name: string, opts: { tags?: string[]; mentions?: string[]; source?: string; hash?: string } = {}): string {
  const tags = opts.tags ?? ['coffee'];
  const mentions = opts.mentions ?? [];
  const source = opts.source ?? `notes/${name}.md`;
  return (
    '---\n' +
    `tags:\n${tags.map((t) => `  - ${t}`).join('\n')}\n` +
    (mentions.length ? `mentions:\n${mentions.map((m) => `  - "${m}"`).join('\n')}\n` : '') +
    `source: ${source}\n` +
    `source_hash: ${opts.hash ?? contentHash(NOTE)}\n` +
    'confidence: high\n' +
    `created: ${TODAY}\n` +
    '---\n\n' +
    `# ${name}\n\nA card.\n\n## Key points\n\n- Espresso extraction takes 28 seconds.\n- A burr grinder is used.\n`
  );
}

const indexLine = (name: string) => `- [[gemma-wiki/cards/${name}|${name}]] — a card about ${name}`;

/** `count` cards, each with its note and its line in the index. */
function wikiOf(count: number, each: (i: number) => Parameters<typeof card>[1] = () => ({})) {
  const files: Record<string, string> = {};
  const names = Array.from({ length: count }, (_, i) => `page-${String(i + 1).padStart(2, '0')}`);
  for (const [i, name] of names.entries()) {
    files[`notes/${name}.md`] = NOTE;
    files[`gemma-wiki/cards/${name}.md`] = card(name, each(i));
  }
  files['gemma-wiki/index.md'] = `# Index\n\n${names.map(indexLine).join('\n')}\n`;
  return { vault: fakeVault(files), names };
}

// ---------------------------------------------------------------------------
// #160 — Tidy reports subjects ready for a concept page
// ---------------------------------------------------------------------------

test('Tidy lists a tag enough cards share, with its page count', async () => {
  const { vault } = wikiOf(DEFAULT_CONCEPT_THRESHOLD);
  const report = await runLint(asApp(vault));
  assert.deepEqual(report.conceptGaps, [{ label: 'coffee', pages: DEFAULT_CONCEPT_THRESHOLD }]);
});

test('one card short of the threshold is not a gap', async () => {
  const { vault } = wikiOf(DEFAULT_CONCEPT_THRESHOLD - 1);
  assert.deepEqual((await runLint(asApp(vault))).conceptGaps, []);
});

test('the gap closes once the concept page exists', async () => {
  const { vault } = wikiOf(DEFAULT_CONCEPT_THRESHOLD);
  vault.set('gemma-wiki/concepts/coffee.md', '---\ntags:\n  - concept\n  - coffee\nkind: concept\n---\n\n# coffee (concept)\n');
  assert.deepEqual((await runLint(asApp(vault))).conceptGaps, []);
});

test('a card that is not in the index does not count towards a subject', async () => {
  const { vault } = wikiOf(DEFAULT_CONCEPT_THRESHOLD - 1);
  // On disk, tagged, and absent from index.md.
  vault.set('gemma-wiki/cards/stray.md', card('stray'));
  vault.set('notes/stray.md', NOTE);
  const report = await runLint(asApp(vault));
  assert.deepEqual(report.conceptGaps, []);
  assert.deepEqual(report.unindexed, ['gemma-wiki/cards/stray.md']);
});

test('a mention shared across cards is a subject too', async () => {
  const { vault } = wikiOf(DEFAULT_CONCEPT_THRESHOLD, (i) => ({ tags: [`tag-${i}`], mentions: ['Burr Grinder'] }));
  assert.deepEqual((await runLint(asApp(vault))).conceptGaps, [{ label: 'Burr Grinder', pages: DEFAULT_CONCEPT_THRESHOLD }]);
});

// ---------------------------------------------------------------------------
// #159 — the review board reports a mention its note never uses
// ---------------------------------------------------------------------------

const reasonsFor = async (vault: ReturnType<typeof fakeVault>, name: string) =>
  (await buildReviewBoard(asApp(vault), 9999)).items.find((i) => i.title === name)?.reasons ?? [];

test('a mention missing from the source note is a reason on the review board', async () => {
  const { vault } = wikiOf(2, (i) => (i === 0 ? { mentions: ['espresso', 'Zzyzx Corporation'] } : { mentions: ['espresso'] }));
  assert.deepEqual(await reasonsFor(vault, 'page-01'), ['1 mention not in the source note']);
  // The card whose mentions are all in its note is not on the board at all.
  assert.deepEqual(await reasonsFor(vault, 'page-02'), []);
});

test('once the note has changed, the board says that and not the mention', async () => {
  const { vault } = wikiOf(1, () => ({ mentions: ['Zzyzx Corporation'], hash: contentHash('an older version of the note') }));
  assert.deepEqual(await reasonsFor(vault, 'page-01'), ['source changed since ingest']);
});

// ---------------------------------------------------------------------------
// #159 — the spot-check chooses its pages
// ---------------------------------------------------------------------------

test('the page with an invented mention is checked first', async () => {
  const { vault } = wikiOf(12, (i) => (i === 10 ? { mentions: ['Zzyzx Corporation'] } : {}));
  const samples = await sampleWikiPages(asApp(vault), 8);
  assert.equal(samples.length, 8);
  assert.equal(samples[0].title, 'page-11');
  assert.deepEqual(samples[0].missingMentions, ['Zzyzx Corporation']);
  assert.ok(samples.slice(1).every((s) => s.missingMentions.length === 0));
});

test('a page whose note is gone does not take a place', async () => {
  const { vault } = wikiOf(9);
  vault.remove('notes/page-03.md');
  const titles = (await sampleWikiPages(asApp(vault), 8)).map((s) => s.title);
  assert.equal(titles.length, 8);
  assert.ok(!titles.includes('page-03'));
});

// The bug: the first eight in file order, on every run.
test('clean pages are not the same eight on every run', async (t) => {
  const { vault } = wikiOf(12);
  const run = async (rolls: number[]) => {
    let i = 0;
    const mock = t.mock.method(Math, 'random', () => rolls[i++ % rolls.length]);
    const titles = (await sampleWikiPages(asApp(vault), 8)).map((s) => s.title).sort();
    mock.mock.restore();
    return titles;
  };
  const rising = Array.from({ length: 12 }, (_, i) => i / 12);
  const first = await run(rising);
  const second = await run([...rising].reverse());
  assert.deepEqual(first, ['page-01', 'page-02', 'page-03', 'page-04', 'page-05', 'page-06', 'page-07', 'page-08']);
  assert.deepEqual(second, ['page-05', 'page-06', 'page-07', 'page-08', 'page-09', 'page-10', 'page-11', 'page-12']);
});

// ---------------------------------------------------------------------------
// #162 — a long answer at the smallest context window
// ---------------------------------------------------------------------------

test('at a 4096 context, a full-length answer still reaches the follow-up', () => {
  // The numbers the panel uses there: a 600-token ceiling, counted by the
  // plugin's own estimator, against an answer at the 1024-token output cap.
  const CEILING = 600;
  let answer = '';
  while (estimateTokens(answer) < 1024) answer += 'A closure is a function that keeps access to the variables around it. ';
  const turns: HistoryTurn[] = [
    { role: 'user', content: 'Explain in detail how JavaScript closures work', grounding: 'direct' },
    { role: 'assistant', content: answer, grounding: 'direct' },
  ];
  const picked = pickHistory(turns, 'direct', CEILING, estimateTokens);
  assert.deepEqual(picked.map((p) => p.role), ['user', 'assistant']);
  assert.ok(picked[1].content.startsWith('A closure is a function'));
  assert.ok(picked[1].content.endsWith('…'));
  const spent = picked.reduce((n, p) => n + estimateTokens(p.content), 0);
  assert.ok(spent <= CEILING, `${spent} tokens against a ceiling of ${CEILING}`);
  // Shortened, not gutted: most of the allowance is used.
  assert.ok(spent > CEILING * 0.9, `only ${spent} of ${CEILING} tokens used`);
});

// ---------------------------------------------------------------------------
// #161 — the setting describes the commands it adds
// ---------------------------------------------------------------------------

test('the Developer commands setting does not count the [Test] commands', () => {
  const root = path.join(import.meta.dirname, '..');
  const settings = fs.readFileSync(path.join(root, 'src/settings.ts'), 'utf8');
  assert.ok(!/\b(two|three|four|five|six|seven|eight|\d+) \[Test\]/i.test(settings), 'a count is back in the description');
  // Said in both places it is written: the declarative page and display().
  assert.equal(settings.split('Adds the [Test] commands to the palette').length - 1, 2);
});
