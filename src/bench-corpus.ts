// The five notes every benchmark run measures.
//
// They live here as strings rather than as files in the vault for one reason:
// a number is only comparable if everyone measured the same thing. A fixture
// the user has to copy in is a fixture that gets edited, truncated, or
// substituted, and then two runs of "15.2 s per card" mean nothing to each
// other. Embedded in the bundle, the corpus is identical on every machine that
// installs the plugin.
//
// Written for this purpose rather than collected, so the whole set is ours to
// publish under the same licence as the rest of the plugin.
//
// SIZING RULE: every fixture stays comfortably under the smallest ingest
// budget the plugin will ever use (2,600 tokens — `budget('ingest')` clamps up
// to that floor even at the 4,096 minimum context setting). A fixture that got
// clamped would measure the clamp instead of the note, and the number would
// then depend on a setting rather than on the machine. Keep new fixtures under
// ~2,000 estimated tokens.

export interface BenchFixture {
  id: string;
  /** Shown in the results table. */
  label: string;
  /** Why this shape is in the set — the thing it is here to stress. */
  why: string;
  text: string;
}

// ---------------------------------------------------------------------------

const SHORT_EN = `# Switching the build to esbuild

We moved the web client off webpack this week. The trigger was not bundle size
— it was that a cold \`npm start\` took 41 seconds and everyone had started
leaving the dev server running overnight, which meant nobody noticed when the
config broke until CI failed the next morning.

esbuild does the same job in about 300 ms. The migration cost two days, most of
it spent on the three loaders we had written ourselves: an SVG-to-component
loader, a YAML loader for the copy files, and one that inlined licence headers.
The SVG one turned out to be unnecessary once we switched to plain imports and
a small runtime wrapper. The YAML loader became a build step that writes JSON,
which is faster and easier to debug. The licence header is now a banner option,
four lines of config.

What we gave up: the webpack plugin ecosystem, and the ability to have the
bundler itself do type checking. We run \`tsc --noEmit\` separately now, in
parallel with the build rather than inside it, which is actually faster but
means a type error no longer stops the bundle from being written. Worth
watching whether that bites us.`;

// ---------------------------------------------------------------------------

const LONG_EN = `# Reading notes: how index funds actually track an index

Started this after realising I could not explain what a tracking error is,
despite having held index funds for six years.

## The naive picture is wrong

The obvious mental model is that the fund holds every constituent of the index
in exactly the index weights, and that tracking is therefore trivially perfect.
This is not how most large funds operate, and the reasons are interesting.

First, indices change. The constituent list is rebalanced on a schedule, and
when a company is added or removed, every fund tracking that index needs to
trade in the same direction on roughly the same day. This is a well-documented
source of cost: front-running of index rebalances is a real strategy, and the
funds are on the losing side of it by construction, because their mandate is to
match the index rather than to get a good price.

Second, holding every constituent is sometimes impractical. A broad index may
have several thousand names, some of which are thinly traded. Buying the long
tail in exact proportion would generate transaction costs that exceed the
tracking benefit. So many funds use optimised sampling: hold the large names at
their index weight, and represent the tail with a statistically chosen subset
selected to match the index's sector and factor exposures. The fund then tracks
the index closely without holding all of it.

## Where tracking error comes from

Four sources, roughly in order of size for a typical large-cap fund.

Cash drag. A fund receiving dividends and inflows holds some cash at any given
moment, and cash does not participate in a rising market. Funds mitigate this
with futures overlays, holding index futures against the cash balance so the
uninvested portion still has market exposure.

Transaction costs. Every rebalance, every inflow, every redemption generates
trades. In a fund with heavy flows this is continuous.

Sampling error. Where the fund does not hold the full index, the sample can
drift from the whole, particularly when the tail behaves differently from the
head, which is exactly what happens in a broad selloff.

Fees. Mechanical and predictable: the expense ratio comes out of returns, so a
fund with a 0.03 percent fee underperforms its index by at least that much
before anything else happens.

## The counterintuitive part

Securities lending can make tracking error negative — the fund beats its index.
Funds lend out holdings to short sellers for a fee, and that revenue can exceed
the drag from costs and fees. Whether the revenue goes to the fund or is split
with the manager varies, and it is worth reading the annual report to find out
which. A fund that returns all lending revenue to shareholders can genuinely
outperform its benchmark on a consistent basis, which looks like alpha and is
not.

## What I actually changed

Nothing about my holdings. But I now read two numbers I had been ignoring: the
tracking difference over three years rather than the expense ratio alone, and
the securities lending policy. The first is what I actually experience; the
second explains a chunk of it.

Open question I did not resolve: whether the sampling approach makes a fund
more fragile in a crisis, when correlations converge and the tail stops
behaving like the sample assumed. Nothing I read addressed this directly.`;

// ---------------------------------------------------------------------------

const JAPANESE = `# 喫茶店のカウンター席について

先週から仕事場を家からカウンター席のある喫茶店に移してみた。三日間試した記録。

集中の質が明らかに違う。家だと二時間で一度は立ち上がって別のことを始めて
しまうのに、カウンターだと三時間くらいは同じ作業を続けられる。理由は物理的
なもので、席が狭くて持ち込めるものが限られるから、目の前に作業対象しか無い
という状態が自然に作られる。家の机は広すぎた。

一方で向いていない作業もはっきりした。声を出して考える作業、たとえば発表の
練習や、電話をしながらメモを取るような作業は当然できない。図を大きく描いて
全体を眺める作業も、物理的に紙が広げられないので難しい。

音については意外だった。話し声があるほうが無音より集中できる。ただし内容が
聞き取れてしまう距離だと駄目で、二つ隣のテーブルくらいの距離が一番良い。

三日間の結論としては、書く作業と読む作業には向いていて、考えを広げる作業に
は向いていない。使い分けることにする。`;

// ---------------------------------------------------------------------------

const CODE_HEAVY = `# Finding what is eating the disk

Every few months the laptop fills up and I go through the same three commands,
so writing them down this time.

Start at the top level and work down. \`-x\` keeps it on one filesystem, which
matters or you spend a minute walking network mounts:

\`\`\`sh
sudo du -xh -d 1 / 2>/dev/null | sort -rh | head -20
\`\`\`

Once a directory is identified, the same command one level deeper, repeatedly,
until something surprising appears. It is almost always one of: a package
manager cache, a container image store, or a log that lost its rotation config.

For files specifically, rather than directories:

\`\`\`sh
find ~ -type f -size +500M -exec ls -lh {} \\; 2>/dev/null | awk '{print $5, $9}'
\`\`\`

The one that catches me every time is deleted-but-still-open files. The space
does not come back until the holding process exits, and \`du\` cannot see them
at all, so the disk is full and nothing accounts for it:

\`\`\`sh
sudo lsof +L1 | awk '$5 == "REG" {print $7, $9, $1}' | sort -rn | head
\`\`\`

The fix there is restarting whatever holds the handle, not deleting anything.

One caveat on the first command: on macOS it will report a large figure for
\`/System/Volumes/Data\` that overlaps with what it reports elsewhere, because
of how the firmlinks are arranged. Do not try to make the numbers add up.`;

// ---------------------------------------------------------------------------

const SPARSE = `# to read

- https://example.org/a-post-about-caching
- https://example.org/another-one
- https://example.com/talk-video
- https://example.net/paper.pdf
- https://example.org/thread
- https://example.com/docs/section-4
- https://example.net/blog/2026/03/whatever
- https://example.org/repo
- https://example.com/interview
- https://example.net/slides

maybe relevant to the retrieval thing`;

// ---------------------------------------------------------------------------

/**
 * The set, in the order it is run.
 *
 * Order matters for one reason: the FIRST model call of a session pays a
 * one-time shader-compilation cost that has nothing to do with the note. The
 * runner does a discarded warm-up before this list rather than sacrificing a
 * fixture to it, so every row here is a warm number.
 */
export const BENCH_CORPUS: BenchFixture[] = [
  {
    id: 'short-en',
    label: 'Short note (EN)',
    why: 'The common case — a few hundred words with clear points to extract. Fastest row in the table; the one most users experience most often.',
    text: SHORT_EN,
  },
  {
    id: 'long-en',
    label: 'Long note (EN)',
    why: 'Prefill-dominated. Prefill throughput is where GPUs differ most, so this is the row that separates machines.',
    text: LONG_EN,
  },
  {
    id: 'ja',
    label: 'Japanese note',
    why: 'CJK costs roughly 1.4 tokens per character against 1 per 3.4 for English — about four times the tokens for the same character count. A benchmark without it misleads every CJK user.',
    text: JAPANESE,
  },
  {
    id: 'code',
    label: 'Code-heavy note',
    why: 'Dense punctuation tokenizes differently from prose, and fenced blocks are the content the model is most likely to mangle. Measures speed and checks the output survives.',
    text: CODE_HEAVY,
  },
  {
    id: 'sparse',
    label: 'Link dump',
    why: 'Almost no prose to work with. The low-information shape most likely to send a small model into a repetition loop, so this row doubles as calibration input for the loop detector.',
    text: SPARSE,
  },
];
