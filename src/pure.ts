// The parts of the wiki that are decisions about text, not about Obsidian.
//
// Everything here is a pure function over strings and plain objects, and the
// file imports nothing — not `obsidian`, not node, not the rest of the plugin.
// That is the whole reason it exists as a file. `import ... from 'obsidian'`
// resolves only inside the app, so for as long as slugify() and parseSchema()
// lived beside a TFile the only way to run them was to click around a vault,
// and every regression they have had was found that way, late: two notes named
// README.md overwriting each other's card, Devanagari vowel signs falling out
// of a slug, a hand-edited tag list lost to a rebuild.
//
// The rule for what belongs here: if it needs an App, a Vault or a TFile, it
// does not. Where the decision is worth testing but the lookup around it is
// not — choosing a card's filename, walking the link graph — the decision moves
// here and the lookup arrives as a function argument, so wiki-store.ts stays
// the only place that knows what a metadata cache is.
//
// tests/ imports this file directly. `npm test` runs it under `node --test`
// using Node's own type stripping: no build step, no test runner to install.

// --------------------------------------------------------------------------
// Names: tags, slugs, filenames
// --------------------------------------------------------------------------

/**
 * A tag, and the stem of a generated filename.
 *
 * `[^a-z0-9]` erased every script that is not Latin. Twelve of twenty-one
 * language samples — Chinese, Japanese, Korean, Russian, Greek, Arabic,
 * Hebrew, Thai, Devanagari — collapsed to the same string, so a vault written
 * in any of them got one tag called `untitled` and one card called
 * `untitled.md` that every note overwrote in turn. Latin with diacritics
 * survived but was mangled: `resume` for `résumé`, `d` for `łódź`.
 *
 * `\p{L}` keeps a letter in any script, `\p{N}` any digit, and `\p{M}` the
 * combining marks that Devanagari, Thai, Arabic and Vietnamese build their
 * letters out of — without that last class `डिज़ाइन` comes back as `ड-ज-इन`,
 * because the vowel signs are marks rather than letters and dropping them
 * splits the word. The result is still only letters, digits and hyphens, so it
 * is safe as a filename on every platform without a second pass.
 */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'untitled'
  );
}

/**
 * Whether a slugified tag carries any meaning.
 *
 * This catches one class and one only: a slug that is nothing but digits and
 * hyphens. `4328` and `70-` name nothing, and Obsidian will not render either
 * as a tag.
 *
 * It deliberately does NOT try to catch the other class. Obsidian parses `#45`
 * in note text as a tag the moment one non-numeric character follows it, and
 * CJK punctuation counts — so a note mentioning issue `#45）` grows a tag out of
 * the sentence after it, and the model can echo it back. But `45-打开对应文件`
 * and `2026-回顾` are the same shape, and any rule sharp enough to drop the
 * first drops the second. Guessing there would cost real tags to catch junk
 * whose actual fix is upstream, in how the note was written.
 */
export function isUsableTag(tag: string): boolean {
  const s = slugify(tag);
  return s !== 'untitled' && !/^[\p{N}\p{M}-]+$/u.test(s);
}

/**
 * A filename from arbitrary text, for a file that lands in the user's vault.
 *
 * Not slugify(). That is the right shape for a tag and for a card the plugin
 * owns, but this file goes among someone's own notes, where `2026 roadmap.md`
 * is what a person would have typed and `2026-roadmap.md` is the plugin
 * imposing a house style on a folder that is not its own.
 *
 * Keep the words; remove only what a filesystem or Obsidian objects to. The
 * fallback covers a question that is entirely punctuation — rare, and still
 * has to produce a file.
 */
export function safeFileName(text: string, fallback: string): string {
  const cleaned = text
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    // eslint-disable-next-line no-control-regex -- the control characters are the point: they are being stripped out of a filename before they can enter the vault
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

// --------------------------------------------------------------------------
// Index entries, and where a card lands
// --------------------------------------------------------------------------

export interface IndexEntry {
  linkPath: string;
  title: string;
  summary: string;
}

/**
 * Which filename a note's card gets, given what is already taken.
 *
 * The lookup half of this lives in wiki-store's cardPathFor(); this is the
 * choice it makes. Identity comes from the note, so `existing` — the card
 * already recording this note as its `source:` — wins outright and no name is
 * minted at all.
 *
 * Only a note with no card yet gets a name, and the plain basename is still
 * tried first: `cards/readme.md` is what you want to see until the day a
 * second README.md wants it. Then the candidates widen — folder-qualified,
 * whole-path, then counted — and every step is derived from the note, so the
 * answer is the same on every call for the same note.
 *
 * `isTaken` reports whether a path already exists in the vault; `reserved`
 * holds paths minted earlier in the same batch, because a scan drafts before
 * it writes and two new same-named notes would otherwise both find the name
 * free and the second would silently replace the first.
 */
export interface CardPathQuery {
  /** The wiki's sources directory, e.g. `gemma-wiki/sources`. */
  dir: string;
  /** The card this note already has, by its recorded source. Null if none. */
  existing: string | null;
  /** The note's full vault path, `.md` and all. */
  path: string;
  /** The note's filename without `.md`. */
  basename: string;
  /** The note's containing folder name; `''` at the vault root. */
  parentName: string;
  isTaken: (path: string) => boolean;
  normalize: (path: string) => string;
  reserved?: Set<string>;
}

export function pickCardPath(q: CardPathQuery): string {
  if (q.existing) return q.existing;

  const stem = q.path.replace(/\.md$/, '');
  // Widening: the name alone, then qualified by its folder, then by the whole
  // path, then counted.
  const candidates = [
    slugify(q.basename),
    q.parentName ? `${slugify(q.parentName)}-${slugify(q.basename)}` : '',
    slugify(stem),
  ].filter(Boolean);
  for (let n = 2; n <= 99; n++) candidates.push(`${slugify(q.basename)}-${n}`);

  for (const c of candidates) {
    const path = q.normalize(`${q.dir}/${c}.md`);
    if (q.reserved?.has(path)) continue;
    if (!q.isTaken(path)) {
      q.reserved?.add(path);
      return path;
    }
  }
  // 99 notes sharing a basename and a folder is not a real vault, but returning
  // undefined here would be worse than one deterministic collision.
  return q.normalize(`${q.dir}/${slugify(q.path)}.md`);
}

// --------------------------------------------------------------------------
// Retrieval: lexical scoring, then the link graph
// --------------------------------------------------------------------------

// Lexical retrieval over the index, per the "read the index, then read the
// pages it points to" plan — deliberately no embeddings, no graph algorithm.
// Function words match every summary and drown out the real signal —
// "what's the common mistake between X and Y" was retrieving pages that
// merely contained "common" and "between".
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'your', 'with', 'can',
  'what', 'which', 'when', 'where', 'why', 'how', 'does', 'did', 'from',
  'have', 'has', 'had', 'this', 'that', 'these', 'those', 'will', 'would',
  'should', 'could', 'about', 'into', 'over', 'than', 'then', 'them',
  'they', 'there', 'their', 'make', 'made', 'between', 'common', 'more',
  'most', 'some', 'such', 'only', 'also', 'very', 'just', 'been', 'was',
  'were', 'its', 'out', 'use', 'using', 'used', 'note', 'notes', 'talk',
  'talking', 'say', 'says', 'tell', 'show',
]);

// Kanji/kana/fullwidth ranges — CJK has no spaces, so a whitespace/ASCII
// tokenizer drops it entirely and a Chinese or Japanese question matched
// zero pages (issue #23).
const CJK_RUN = /[぀-ヿ㐀-鿿豈-﫿ｦ-ﾟ]+/g;

export function scoreEntries(question: string, entries: IndexEntry[]): IndexEntry[] {
  const q = question.toLowerCase();
  const ascii = q.split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOPWORDS.has(t));
  // CJK: no word boundaries, so use sliding 2-char windows (bigrams) as
  // terms — specific enough to avoid single-char particle noise (的/は/て),
  // and they substring-match the equally-CJK haystack.
  const cjk: string[] = [];
  for (const run of q.match(CJK_RUN) ?? []) {
    if (run.length === 1) cjk.push(run);
    else for (let i = 0; i < run.length - 1; i++) cjk.push(run.slice(i, i + 2));
  }
  const terms = [...new Set([...ascii, ...cjk])];
  if (!terms.length) return [];
  const scored = entries
    .map((e) => {
      const haystack = `${e.title} ${e.summary}`.toLowerCase();
      const score = terms.reduce((acc, t) => acc + (haystack.includes(t) ? 1 : 0), 0);
      return { e, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map((s) => s.e);
}

/**
 * The one-hop link neighbourhood of the seed pages (issue #14).
 *
 * Pure half of wiki-store's expandByLinks(): it takes the resolved link graph
 * rather than the metadata cache that produces it. A wiki-link neighbour is
 * often the page that actually holds the answer even when its own summary
 * shares none of the question's words — lexical retrieval cannot see that, the
 * link graph can.
 *
 * Both directions count. Outbound is what a seed points at; inbound is every
 * wiki page pointing back at a seed, which is the half that finds the concept
 * page a card never links to.
 */
export function linkNeighbours(opts: {
  /** `metadataCache.resolvedLinks`: source path -> target path -> count. */
  resolvedLinks: Record<string, Record<string, number>>;
  seeds: IndexEntry[];
  allEntries: IndexEntry[];
  maxExtra: number;
  /** The wiki folder with its trailing slash, e.g. `gemma-wiki/`. */
  wikiPrefix: string;
}): IndexEntry[] {
  const { resolvedLinks, seeds, allEntries, maxExtra, wikiPrefix } = opts;
  if (!seeds.length || maxExtra <= 0) return [];
  const byPath = new Map(allEntries.map((e) => [`${e.linkPath}.md`, e]));
  const seedPaths = new Set(seeds.map((e) => `${e.linkPath}.md`));
  const neighbours = new Set<string>();

  // Outbound: seed -> targets.
  for (const seedPath of seedPaths) {
    for (const tgt of Object.keys(resolvedLinks[seedPath] ?? {})) {
      if (byPath.has(tgt) && !seedPaths.has(tgt)) neighbours.add(tgt);
    }
  }
  // Inbound: any wiki page -> a seed (backlinks).
  for (const [src, targets] of Object.entries(resolvedLinks)) {
    if (!src.startsWith(wikiPrefix) || !byPath.has(src) || seedPaths.has(src)) continue;
    if (Object.keys(targets).some((t) => seedPaths.has(t))) neighbours.add(src);
  }

  const extra: IndexEntry[] = [];
  for (const p of neighbours) {
    const e = byPath.get(p);
    if (e) extra.push(e);
    if (extra.length >= maxExtra) break;
  }
  return extra;
}

// --------------------------------------------------------------------------
// The schema note
// --------------------------------------------------------------------------
//
// Karpathy's third layer (issue #3) — kept as a NOTE, not a
// hidden setting ("config as a note"): plain markdown the plugin parses before
// every ingest. Living as a note means it versions with the wiki, is visible
// and hand-editable, and shares the same "everything is a file you can read"
// philosophy as the rest of the wiki. Three parsed sections: Tags (controlled
// vocabulary), Naming (page-name rules), Concept threshold.

export interface WikiSchema {
  tags: string[];
  naming: Record<string, string>;
  conceptThreshold: number;
  // New tags ingest has seen that aren't in the vocabulary yet, waiting for
  // you to promote them (issue #3). The vocabulary stays curated; nothing
  // enters it silently.
  pending: string[];
  // Tags the user has banned by hand. Highest authority: Organize never
  // re-proposes them, ingest never uses them, Pending never queues them —
  // a plain deletion from Tags only lasts until the next rebuild, because
  // rebuilds read the tags still in use on pages. This list is permanent.
  rejected: string[];
  // Old tag -> the vocabulary tag it means. Written by Retag, which already
  // computes exactly this mapping to rewrite pages with and then throws it
  // away. Keeping it is what lets a page still carrying `llm-eval` be
  // recognised as being about `evals` — which is the whole of duplicate
  // detection here. Never authoritative over Rejected: an alias pointing at
  // a banned tag is ignored.
  aliases: Record<string, string>;
}

export const DEFAULT_NAMING: Record<string, string> = {
  concept: 'kebab-case singular noun',
  source: "follows the source note's filename",
};
export const DEFAULT_CONCEPT_THRESHOLD = 4;

/**
 * The self-documenting schema file. The prose header explains what the file is
 * and how to use it, so opening it is enough to understand the config.
 *
 * Takes one argument, shaped exactly like what parseSchema returns, so that
 * `buildSchemaFile(parseSchema(content))` is the regeneration path and cannot
 * silently drop a slot. It used to take five positional parameters with
 * defaults, which meant every caller had to remember to thread all five
 * through — and the one that regenerates the file on every start had to
 * remember hardest, because forgetting there erases the user's own lists.
 */
export function buildSchemaFile(schema: Partial<WikiSchema> = {}): string {
  const {
    tags = [],
    naming = DEFAULT_NAMING,
    conceptThreshold = DEFAULT_CONCEPT_THRESHOLD,
    pending = [],
    rejected = [],
    aliases = {},
  } = schema;
  const tagLines = tags.length
    ? tags.map((t) => `- ${slugify(t)}`).join('\n')
    : '_No tags yet. Ingest a few notes, then run "Tidy the wiki" to build the vocabulary from them._';
  const namingLines = Object.entries(naming)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const pendingLines = pending.length
    ? pending.map((t) => `- ${slugify(t)}`).join('\n')
    : '(none)';
  const rejectedLines = rejected.length
    ? rejected.map((t) => `- ${slugify(t)}`).join('\n')
    : '(none)';
  // Same `key: value` shape as Naming, which the parser already reads.
  const aliasLines = Object.keys(aliases).length
    ? Object.entries(aliases)
        .map(([from, to]) => `${slugify(from)}: ${slugify(to)}`)
        .sort()
        .join('\n')
    : '(none)';
  // Docs as collapsed callouts, data in the open. In live preview — where
  // people actually edit — a "[!info]-" renders as a one-line pill until
  // clicked, so each section costs one line of chrome. (An earlier pass
  // removed the callouts on the argument that source view unfolds them; that
  // argument was wrong for live preview, which is the common case.)
  //
  // The split that matters is ownership, and it is enforced by regeneration,
  // not by a stamp: on every start the file is parsed and rebuilt from this
  // template, so the callouts always match the running version — delete one
  // and it is back next start — while the five data slots ride through the
  // parse untouched. The parser ignores every "> " line, which is exactly why
  // the docs may live in callouts (keep digits out of the threshold one).
  return (
    `# Wiki Schema\n\n` +
    `> [!info]- How this file works\n` +
    `> The wiki's tag rules — plain markdown, read before every ingest. **The lists are yours; the explanations are the plugin's.** Edit tags freely and they are never overwritten; the callouts (this one included) are rewritten on every start, so deleting or editing them does not stick. Anything else you write in this file will not survive a restart either — your own notes belong in your own notes.\n` +
    `>\n` +
    `> Three ways it changes, all yours: edit by hand (read before every ingest) · **Tidy the wiki** rebuilds the vocabulary from the tags in use, and brings existing pages in line afterwards. Nothing changes without an approval of yours.\n\n` +
    `## Tags\n\n` +
    `> [!info]- What goes here\n` +
    `> Your vocabulary — **one \`- tag\` per line, right below this box.** Ingest reuses these instead of coining near-synonyms (\`llm-eval\` vs \`evals\`), which is what lets pages cluster into concept pages. Build the list with **Tidy the wiki**; edit by hand when precision matters.\n\n` +
    `${tagLines}\n\n` +
    `## Naming\n\n` +
    `> [!info]- What this does\n` +
    `> \`concept:\` is fed into the tag-naming prompt — a nudge to a small model, not a guarantee. File names are lower-cased and hyphenated mechanically no matter what this says.\n\n` +
    `${namingLines}\n\n` +
    `## Concept threshold\n\n` +
    `> [!info]- What this does\n` +
    `> How many pages must share a tag before **Build a concept page** offers the cluster. Leave it blank and it falls back to the default.\n\n` +
    `${conceptThreshold}\n\n` +
    `## Pending\n\n` +
    `> [!info]- How to clear these\n` +
    `> New tags ingest coined, waiting on you. Move a line up into \`## Tags\` to keep it · delete it to reject it · move it down into \`## Rejected\` to ban it. **Tidy the wiki** clears the queue wholesale, behind a preview. A tag waiting here already helps later ingests reuse it.\n\n` +
    `${pendingLines}\n\n` +
    `## Rejected\n\n` +
    `> [!info]- What this is\n` +
    `> Your veto, and it outranks everything: never re-proposed, never applied, never queued. Deleting a tag from \`## Tags\` alone lasts only until the next Organize — a page still carrying it brings it back. A line here is permanent.\n\n` +
    `${rejectedLines}\n\n` +
    `## Aliases\n\n` +
    `> [!info]- What this is\n` +
    `> \`old-tag: vocabulary-tag\` — one per line. **Tidy the wiki** writes these when you approve a retag, because deciding that \`llm-eval\` means \`evals\` is the same decision. They are what lets a page still carrying the old tag be recognised as being about the same thing as one carrying the new one. Edit or delete them freely; an alias pointing at a tag in \`## Rejected\` is ignored.\n\n` +
    `${aliasLines}\n`
  );
}

function schemaSection(content: string, heading: string): string {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, 'im');
  const m = content.match(re);
  if (!m || m.index === undefined) return '';
  const after = content.slice(m.index + m[0].length);
  const next = after.search(/^##\s+/m);
  return next === -1 ? after : after.slice(0, next);
}

export function parseSchema(content: string): WikiSchema {
  const tags = schemaSection(content, 'Tags')
    .split('\n')
    .map((l) => l.trim())
    // A bullet whose content starts with "(" is a placeholder/comment, not a tag.
    .filter((l) => l.startsWith('- ') && !l.slice(2).trim().startsWith('('))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);
  const naming: Record<string, string> = {};
  for (const l of schemaSection(content, 'Naming').split('\n')) {
    const m = l.match(/^([a-z][a-z0-9-]*)\s*:\s*(.+)$/i);
    if (m) naming[m[1].toLowerCase()] = m[2].trim();
  }
  // Read the threshold from the section's own lines, ignoring callout lines:
  // this takes the FIRST number it finds, so any digit inside an explanatory
  // "> ..." block above the value would otherwise be parsed as the threshold.
  // Dropping "> " lines also makes a hand-written callout harmless.
  const tm = schemaSection(content, 'Concept threshold')
    .split('\n')
    .filter((l) => !l.trim().startsWith('>'))
    .join('\n')
    .match(/\d+/);
  const pending = schemaSection(content, 'Pending')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .filter((t) => t && t.toLowerCase() !== '(none)');
  const rejected = schemaSection(content, 'Rejected')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .filter((t) => t && t.toLowerCase() !== '(none)');
  const aliases: Record<string, string> = {};
  for (const l of schemaSection(content, 'Aliases').split('\n')) {
    if (l.trim().startsWith('>')) continue;
    const m = l.match(/^\s*([^:>\s][^:]*?)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    const from = slugify(m[1]);
    const to = slugify(m[2]);
    // A tag is never an alias of itself, and `(none)` is the placeholder.
    if (!from || !to || from === to || from === 'untitled' || to === 'untitled') continue;
    aliases[from] = to;
  }
  return {
    tags,
    naming: Object.keys(naming).length ? naming : DEFAULT_NAMING,
    conceptThreshold: tm ? parseInt(tm[0], 10) : DEFAULT_CONCEPT_THRESHOLD,
    pending,
    rejected,
    aliases,
  };
}

// --------------------------------------------------------------------------
// Improve: packing a note into chunks that fit the context
// --------------------------------------------------------------------------

// Rough token cost per script: CJK (Han/kana/Hangul/fullwidth) runs ~1.5
// tokens per character, everything else ~4 characters per token. Deliberately
// pessimistic — overshooting the context window truncates the rewrite
// silently, which is the worst failure mode we have.
const CJK_RE = /[\u3000-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/g;
export function estimateImproveTokens(text: string): number {
  const cjk = (text.match(CJK_RE) ?? []).length;
  return Math.ceil(cjk * 1.5 + (text.length - cjk) / 4);
}

// One unit of work for Improve. `raw` keeps its own trailing newlines so that
// concatenating every chunk's raw text reproduces the source byte for byte —
// that is what lets us stitch the rewritten pieces back together without
// inventing or eating blank lines. `verbatim` chunks are passed through
// untouched (an over-budget fenced code block: it must be preserved exactly
// anyway, so there is nothing for the copy editor to do).
export interface ImproveChunk {
  raw: string;
  verbatim: boolean;
}

// Split markdown into blocks that are safe to send separately: fenced code
// blocks stay whole, headings start a new block, and blank lines end one.
// Every block carries its trailing newlines, so blocks.join('') === src.
export function splitMarkdownBlocks(src: string): string[] {
  const lines = src.split('\n');
  const blocks: string[] = [];
  let buf: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    // Each entry already carries its own line break, so this is a plain
    // concatenation — joining on '\n' here would duplicate every newline.
    if (buf.length) blocks.push(buf.join(''));
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const last = i === lines.length - 1;
    const withNl = last ? line : line + '\n';
    if (fence) {
      buf.push(withNl);
      if (new RegExp(`^\\s{0,3}${fence}\\s*$`).test(line)) {
        fence = null;
        flush();
      }
      continue;
    }
    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (open) {
      flush();
      fence = open[1];
      buf.push(withNl);
      continue;
    }
    if (/^\s{0,3}#{1,6}\s/.test(line)) {
      flush();
      buf.push(withNl);
      continue;
    }
    if (line.trim() === '') {
      // Blank lines belong to the block they close, so the separator
      // survives the round trip.
      if (buf.length) {
        buf.push(withNl);
        // Keep consuming a run of blank lines, then end the block.
        while (i + 1 < lines.length && lines[i + 1].trim() === '') {
          i++;
          buf.push(i === lines.length - 1 ? lines[i] : lines[i] + '\n');
        }
        flush();
      } else {
        blocks.push(withNl);
      }
      continue;
    }
    buf.push(withNl);
  }
  flush();
  return blocks;
}

// Break one over-budget block into pieces that fit. Prefers line boundaries,
// then sentence-ending punctuation (CJK notes routinely hold a 1500-character
// paragraph on a single line), and only then a hard character cut.
function splitOversizedBlock(block: string, budget: number): string[] {
  const out: string[] = [];
  const flushable = (piece: string) => {
    if (piece) out.push(piece);
  };
  let rest = block;
  while (estimateImproveTokens(rest) > budget) {
    // Binary-search the longest prefix that fits, then walk back to the
    // nearest natural boundary inside it.
    let lo = 1;
    let hi = rest.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (estimateImproveTokens(rest.slice(0, mid)) <= budget) lo = mid;
      else hi = mid - 1;
    }
    const head = rest.slice(0, lo);
    const nl = head.lastIndexOf('\n');
    const sentence = Math.max(
      head.lastIndexOf('。'),
      head.lastIndexOf('！'),
      head.lastIndexOf('？'),
      head.lastIndexOf('. '),
      head.lastIndexOf('! '),
      head.lastIndexOf('? ')
    );
    let cut = lo;
    if (nl > lo * 0.4) cut = nl + 1;
    else if (sentence > lo * 0.4) cut = sentence + 1;
    flushable(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  flushable(rest);
  return out;
}

// Pack a note into chunks that each fit the per-pass input budget. Chunk
// boundaries land on headings or blank lines wherever possible, so rejoining
// the rewritten pieces is a plain concatenation.
export function chunkForImprove(content: string, budget: number): ImproveChunk[] {
  if (estimateImproveTokens(content) <= budget) return [{ raw: content, verbatim: false }];
  const chunks: ImproveChunk[] = [];
  let buf = '';
  const flush = () => {
    if (buf) chunks.push({ raw: buf, verbatim: false });
    buf = '';
  };
  for (const block of splitMarkdownBlocks(content)) {
    if (estimateImproveTokens(block) > budget) {
      flush();
      // A single fenced block over budget has to be preserved verbatim
      // anyway; cutting it would corrupt the code.
      if (/^\s{0,3}(`{3,}|~{3,})/.test(block)) {
        chunks.push({ raw: block, verbatim: true });
      } else {
        for (const piece of splitOversizedBlock(block, budget)) {
          chunks.push({ raw: piece, verbatim: false });
        }
      }
      continue;
    }
    // Prefer to break in front of a heading once the current chunk is
    // half full: a pass that starts at a section head reads as a section,
    // not as a fragment cut mid-argument.
    if (buf && /^\s{0,3}#{1,6}\s/.test(block) && estimateImproveTokens(buf) >= budget * 0.5) flush();
    if (buf && estimateImproveTokens(buf + block) > budget) flush();
    buf += block;
  }
  flush();
  return chunks;
}

// ---------------------------------------------------------------------------
// Pages that are about the same thing
// ---------------------------------------------------------------------------

// Two notes about one subject produce two cards, and until now nothing ever
// noticed. That is not by itself a bug — a card summarises ITS note, and two
// notes about the same subject are two different pieces of writing, both worth
// keeping. What was missing is the observation: nothing said "these two are
// about the same thing", so the pair never got linked and never grew a concept
// page above it.
//
// So this finds pairs and says why. It does not merge them, and there is no
// mode in which it does — the same rule the contradiction sweep follows.
//
// Everything here is model-free. The three inputs already exist: `mentions:`
// on every card (the salient entities ingest already extracts), the tag
// vocabulary, and the alias table Retag now leaves behind. A name that used to
// read as unrelated — `llm-eval` beside `evals` — resolves through the aliases
// to the same canonical form, which is the entire mechanism.

/**
 * A name in its canonical form: slugified, then followed through the alias
 * table.
 *
 * The walk is depth-limited rather than cycle-detected because the table is
 * hand-editable, and `a: b` beside `b: a` is a thing a person will write. A
 * cycle resolves to whichever end the walk stops on — stable for a given
 * table, which is all this needs to be.
 */
export function canonicalTag(name: string, aliases: Record<string, string> = {}): string {
  let out = slugify(name);
  for (let hops = 0; hops < 8; hops++) {
    const next = aliases[out];
    if (!next || next === out) break;
    out = slugify(next);
  }
  return out;
}

export interface DuplicateCandidate {
  linkPath: string;
  title: string;
  /** Salient entities from the card's `mentions:` frontmatter. */
  mentions: string[];
  /** Page file mtime, so the newest pairs are reported first. */
  mtime: number;
}

export interface DuplicatePair {
  a: DuplicateCandidate;
  b: DuplicateCandidate;
  /** What made them look like one subject, in words the report can print. */
  because: string;
}

/**
 * A mention carried by this share of the wiki is a topic, not an identity.
 *
 * Without this every page mentioning "AI" pairs with every other one, and the
 * finding becomes noise that gets ignored — which is worse than not having it,
 * because a checkbox nobody trusts still gets ticked.
 */
const TOPIC_SHARE = 0.25;
const TOPIC_FLOOR = 3;

export function findDuplicatePairs(opts: {
  pages: DuplicateCandidate[];
  aliases?: Record<string, string>;
  /** Whether these two already link to each other, in either direction. */
  linked?: (a: string, b: string) => boolean;
  cap: number;
}): { pairs: DuplicatePair[]; total: number } {
  const { pages, aliases = {}, linked = () => false, cap } = opts;
  if (pages.length < 2 || cap <= 0) return { pairs: [], total: 0 };

  const canon = (s: string) => canonicalTag(s, aliases);

  // How many pages carry each mention, so the common ones can be set aside.
  const carriers = new Map<string, number>();
  for (const p of pages) {
    for (const m of new Set(p.mentions.map(canon))) {
      if (m && m !== 'untitled') carriers.set(m, (carriers.get(m) ?? 0) + 1);
    }
  }
  const topicAt = Math.max(TOPIC_FLOOR, Math.ceil(pages.length * TOPIC_SHARE));
  const identifying = (m: string) => !!m && m !== 'untitled' && (carriers.get(m) ?? 0) < topicAt;

  const titleOf = new Map(pages.map((p) => [p.linkPath, canon(p.title)]));
  const mentionsOf = new Map(
    pages.map((p) => [p.linkPath, new Set([...new Set(p.mentions.map(canon))].filter(identifying))])
  );

  const found: DuplicatePair[] = [];
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      const a = pages[i];
      const b = pages[j];
      if (a.linkPath === b.linkPath) continue;
      if (linked(a.linkPath, b.linkPath)) continue;

      // A title that slugifies to `untitled` names nothing, so two of them
      // are not two pages with the same name.
      const ta = titleOf.get(a.linkPath)!;
      const tb = titleOf.get(b.linkPath)!;
      const namedA = ta && ta !== 'untitled' ? ta : '';
      const namedB = tb && tb !== 'untitled' ? tb : '';
      const ma = mentionsOf.get(a.linkPath)!;
      const mb = mentionsOf.get(b.linkPath)!;

      // Strongest first, and the first match is the one reported: a reason
      // that names the weakest evidence would read as a worse finding than it
      // is.
      let because = '';
      if (namedA && namedA === namedB) {
        because = `both pages are called “${a.title}”`;
      } else if (namedA && mb.has(namedA)) {
        because = `“${a.title}” is named on the other page`;
      } else if (namedB && ma.has(namedB)) {
        because = `“${b.title}” is named on the other page`;
      } else {
        const shared = [...ma].filter((m) => mb.has(m));
        if (shared.length >= 2) {
          because = `both name ${shared.slice(0, 3).map((m) => `“${m}”`).join(' and ')}`;
        }
      }
      if (because) found.push({ a, b, because });
    }
  }

  // Newest pair first, for the same reason the contradiction sweep does it:
  // a fixed order re-reports the same oldest pairs on every run, and the pair
  // you just created never reaches the top.
  found.sort((x, y) => Math.max(y.a.mtime, y.b.mtime) - Math.max(x.a.mtime, x.b.mtime));
  return { pairs: found.slice(0, cap), total: found.length };
}
