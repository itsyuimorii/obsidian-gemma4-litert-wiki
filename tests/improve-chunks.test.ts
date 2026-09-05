// Improve packs a note into chunks that each fit the context window, rewrites
// them one at a time, and concatenates the results.
//
// That last step is only safe because of one property: joining the chunks'
// raw text reproduces the source byte for byte. If a chunk boundary eats or
// invents a newline, Improve silently reformats a note it was told not to
// touch — and the user's note is the thing being overwritten.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkForImprove, estimateImproveTokens, splitMarkdownBlocks } from '../src/pure.ts';

const SAMPLES: Record<string, string> = {
  empty: '',
  'one line': 'just a sentence',
  'no trailing newline': '# Title\n\nA paragraph.\n\n## Next\n\nMore.',
  'trailing newline': '# Title\n\nA paragraph.\n',
  'many trailing newlines': 'text\n\n\n\n',
  'leading blank lines': '\n\n\n# Title\n\nbody\n',
  'windows line endings': '# Title\r\n\r\nA paragraph.\r\n',
  'fenced code': '# Title\n\n```js\nconst x = 1;\n\n\nconst y = 2;\n```\n\nAfter.\n',
  'tilde fence': '~~~python\nprint(1)\n~~~\n\ntext\n',
  'nested fence markers': '````\n```\nnot a close\n```\n````\n\nafter\n',
  'unclosed fence': '# T\n\n```js\nconst x = 1;\n',
  'cjk paragraph': '# 設計\n\n' + 'これは長い段落です。'.repeat(200) + '\n',
  'one enormous line': 'x'.repeat(20000),
  'headings only': '# a\n## b\n### c\n#### d\n',
  'indented fence': '  ```\n  code\n  ```\n\ntext\n',
  'blank lines only': '\n\n\n\n\n',
  'frontmatter': '---\ntags:\n  - a\n---\n\n# Title\n\nbody\n',
};

for (const [name, src] of Object.entries(SAMPLES)) {
  test(`chunks stitch back byte-exactly: ${name}`, () => {
    for (const budget of [8, 40, 200, 5000]) {
      const rejoined = chunkForImprove(src, budget)
        .map((c) => c.raw)
        .join('');
      assert.equal(rejoined, src, `budget ${budget}`);
    }
  });

  test(`blocks stitch back byte-exactly: ${name}`, () => {
    assert.equal(splitMarkdownBlocks(src).join(''), src);
  });
}

test('a note that already fits is one chunk, untouched', () => {
  const src = '# Title\n\nShort enough.\n';
  const chunks = chunkForImprove(src, 10_000);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].raw, src);
  assert.equal(chunks[0].verbatim, false);
});

test('an over-budget fenced block is passed through verbatim', () => {
  // Cutting it would corrupt the code, and it has to be preserved exactly
  // anyway — so there is nothing for the copy editor to do.
  const code = '```js\n' + 'const x = 1;\n'.repeat(400) + '```\n';
  const chunks = chunkForImprove(`# T\n\nintro\n\n${code}\n\ntail\n`, 60);
  const verbatim = chunks.filter((c) => c.verbatim);
  assert.equal(verbatim.length, 1);
  assert.ok(verbatim[0].raw.startsWith('```js'), verbatim[0].raw.slice(0, 20));
  assert.ok(verbatim[0].raw.trimEnd().endsWith('```'));
});

test('prose chunks stay inside the budget', () => {
  const src = ('A sentence about something.\n\n'.repeat(300));
  for (const chunk of chunkForImprove(src, 100)) {
    if (chunk.verbatim) continue;
    assert.ok(
      estimateImproveTokens(chunk.raw) <= 100,
      `chunk of ${estimateImproveTokens(chunk.raw)} tokens exceeds 100`
    );
  }
});

test('an oversized CJK paragraph on one line is still split', () => {
  // CJK notes routinely hold a 1500-character paragraph with no line breaks,
  // so a line-boundary-only splitter never fits the budget.
  const src = '今日は良い天気です。'.repeat(500) + '\n';
  const chunks = chunkForImprove(src, 120);
  assert.ok(chunks.length > 1, 'never split');
  assert.equal(chunks.map((c) => c.raw).join(''), src);
});

test('chunking is deterministic', () => {
  const src = SAMPLES['cjk paragraph'];
  const shape = () => chunkForImprove(src, 150).map((c) => `${c.verbatim}:${c.raw.length}`).join('|');
  const first = shape();
  for (let i = 0; i < 10; i++) assert.equal(shape(), first);
});

test('no chunk is empty', () => {
  for (const [name, src] of Object.entries(SAMPLES)) {
    if (!src) continue;
    for (const chunk of chunkForImprove(src, 30)) {
      assert.ok(chunk.raw.length > 0, `empty chunk from ${name}`);
    }
  }
});

test('the token estimate is pessimistic for CJK', () => {
  // Overshooting the context window truncates the rewrite silently, which is
  // the worst failure mode here — so the estimate leans high on purpose.
  assert.ok(estimateImproveTokens('あ'.repeat(100)) > estimateImproveTokens('a'.repeat(100)));
  assert.equal(estimateImproveTokens(''), 0);
});
