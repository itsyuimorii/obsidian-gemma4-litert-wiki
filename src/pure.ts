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
 * the sentence after it, and the model can echo it back. But `45-該当ファイルを開く`
 * and `2026-振り返り` are the same shape, and any rule sharp enough to drop the
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
  // English
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'your', 'with', 'can',
  'what', 'which', 'when', 'where', 'why', 'how', 'does', 'did', 'from',
  'have', 'has', 'had', 'this', 'that', 'these', 'those', 'will', 'would',
  'should', 'could', 'about', 'into', 'over', 'than', 'then', 'them',
  'they', 'there', 'their', 'make', 'made', 'between', 'common', 'more',
  'most', 'some', 'such', 'only', 'also', 'very', 'just', 'been', 'was',
  'were', 'its', 'out', 'use', 'using', 'used', 'note', 'notes', 'talk',
  'talking', 'say', 'says', 'tell', 'show', 'any', 'all', 'own', 'mine',
  // French
  'les', 'des', 'une', 'est', 'que', 'qui', 'pour', 'dans', 'sur', 'avec',
  'ces', 'cette', 'aux', 'pas', 'plus', 'mes', 'mon', 'quelles', 'quels',
  'quelle', 'quel', 'parlent', 'parle', 'sont', 'vous', 'nous', 'leur',
  // German
  'der', 'die', 'das', 'und', 'ist', 'ein', 'eine', 'nicht', 'mit', 'von',
  'auf', 'für', 'den', 'dem', 'des', 'welche', 'welcher', 'welches', 'meine',
  'meinen', 'meiner', 'notiz', 'notizen', 'erwähnen', 'erwähnt', 'über',
  'sind', 'ich', 'sie', 'wir', 'ihre',
  // Spanish
  'los', 'las', 'del', 'una', 'por', 'para', 'con', 'mis', 'qué', 'cuáles',
  'cuál', 'nota', 'notas', 'hablan', 'habla', 'sobre', 'son', 'está', 'están',
  'como', 'cómo', 'donde', 'dónde', 'este', 'esta', 'estos', 'estas', 'ese',
  'esa', 'esos', 'esas', 'muy', 'también', 'pero', 'porque',
]);

// Words that carry an instruction rather than a subject — the scaffolding
// of "draft a short outline for X" around X. Left in, they drove retrieval:
// "outline" at weight 0.81 outranked the subject the outline was for, and
// the notes that came back were the ones that used the word outline.
const INSTRUCTION_STOP = new Set([
  // English
  'draft', 'outline', 'short', 'brief', 'list', 'write', 'explain', 'explains',
  'summarise', 'summarize', 'summary', 'describe', 'find', 'give', 'create',
  'plain', 'terms', 'please', 'help', 'need', 'want', 'rewrite', 'clearer',
  'keeping', 'meaning', 'mention', 'mentions', 'mentioned', 'cover', 'covers',
  'written', 'wrote', 'edit', 'edited', 'recently', 'recent', 'cite', 'answer',
  'question', 'questions', 'ask', 'asked', 'know', 'think', 'read', 'look',
  // French
  'rédige', 'rédiger', 'explique', 'expliquer', 'résume', 'résumer', 'liste',
  'lister', 'montre', 'montrer', 'écris', 'écrire', 'décris', 'décrire',
  'trouve', 'trouver', 'donne', 'donner', 'plan', 'court', 'courte', 'brève',
  // German
  'schreibe', 'schreiben', 'erkläre', 'erklären', 'fasse', 'zusammen',
  'zusammenfassen', 'zeige', 'zeigen', 'liste', 'finde', 'finden', 'gib',
  'geben', 'erstelle', 'erstellen', 'kurz', 'kurze', 'kurzen', 'gliederung',
  'entwurf', 'beschreibe', 'beschreiben',
  // Spanish
  'escribe', 'escribir', 'explica', 'explicar', 'resume', 'resumir', 'lista',
  'listar', 'muestra', 'mostrar', 'encuentra', 'encontrar', 'describe',
  'describir', 'crea', 'crear', 'esquema', 'borrador', 'corto', 'corta',
  'breve', 'dame', 'haz', 'hacer',
]);

// Chinese and Japanese function words and question scaffolding. The
// segmenter returns these as tokens of their own, which is what makes a
// stoplist possible at all: the sliding bigrams they replaced produced
// "记提" out of "笔记|提到", a non-word that occurred in one note and so
// outweighed the subject of the question sevenfold.
const CJK_STOP = new Set([
  // Chinese particles, pronouns, determiners, classifiers
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '我们', '你们',
  '他们', '我的', '你的', '吗', '呢', '吧', '啊', '和', '与', '或', '或者', '把',
  '被', '让', '给', '对', '从', '到', '有', '没', '没有', '不', '也', '都',
  '就', '这', '那', '这个', '那个', '这些', '那些', '很', '会', '要', '能',
  '可以', '以', '等', '及', '以及', '上', '下', '中', '里', '内', '外', '为',
  '什么', '怎么', '怎样', '如何', '为什么', '哪', '哪些', '哪个', '哪几',
  '几', '篇', '个', '些', '一', '一下', '一个', '一些', '关于', '提到',
  '提及', '笔记', '文章', '文件', '内容', '写', '写过', '写了', '写的',
  '写下', '写一个', '写一篇', '记录', '记', '记过', '帮我', '请', '解释',
  '总结', '列出', '列一下', '找', '找出', '找一下', '找找', '说明', '大纲',
  '草稿', '简短', '简单', '介绍', '告诉', '看看', '想', '知道', '有哪些', '帮',
  '都有', '所有', '全部', '关联', '之间', '最近', '最新', '新',
  // Japanese particles, copulas, auxiliaries, question scaffolding
  'は', 'の', 'が', 'を', 'に', 'で', 'と', 'も', 'へ', 'や', 'か', 'ね',
  'よ', 'な', 'て', 'た', 'だ', 'し', 'ます', 'です', 'でし', 'ある', 'いる',
  'する', 'なる', 'なり', 'こと', 'もの', 'ため', 'たび', 'とは', 'には',
  'では', 'から', 'まで', 'より', 'など', 'これ', 'それ', 'あれ', 'この',
  'その', 'あの', 'どの', 'どれ', 'どんな', '何', 'なに', 'なん', '私',
  '僕', '俺', '自分', 'ノート', 'メモ', '記事', 'ファイル', '書い', '書いた',
  '書く', '教え', '教えて', 'まとめ', 'まとめて', '説明', '作っ', '作って',
  '作成', '一覧', '見せ', '見せて', '探し', '探して', 'について', 'に関する',
  '関する', 'ください', 'くださ', 'お願い', '最近', '今週', '先週',
]);

const CJK_CHAR = /[぀-ヿ㐀-鿿豈-﫿ｦ-ﾟ]/;
const CJK_RUN = /[぀-ヿ㐀-鿿豈-﫿ｦ-ﾟ]+/g;

// Word segmentation from ICU, which Chromium (so Obsidian) and Node both
// carry: dictionary-based for Chinese, Japanese and Thai, rule-based
// elsewhere, no dependency and no locale to guess. Built once.
const SEGMENTER: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'word' })
    : null;

/**
 * The terms a piece of text contributes to a lexical match.
 *
 * Words, as ICU segments them, lower-cased. Latin-script tokens shorter than
 * three letters are dropped (two-letter tokens are handled by shortTerms,
 * as whole words), and so are stopwords in six languages and the words that
 * carry an instruction rather than a subject. Chinese and Japanese tokens
 * are real words, not sliding bigrams: a bigram straddling a word boundary
 * is a non-word, occurs in one note by accident, and under rarity
 * weighting becomes the heaviest term in the question. A French elision
 * (l'extraction) is split so the noun survives. Without a segmenter the old
 * bigram tokenizer stands in.
 *
 * One definition, used by retrieval, by the relink pre-pass and by Vault
 * search, so "related" means the same thing everywhere.
 */
export function queryTerms(text: string): string[] {
  const q = text.toLowerCase();
  const out: string[] = [];
  const keepLatin = (t: string) => t.length > 2 && !STOPWORDS.has(t) && !INSTRUCTION_STOP.has(t);
  if (!SEGMENTER) {
    for (const t of q.split(/[^\p{L}\p{N}]+/u)) if (t && !CJK_CHAR.test(t) && keepLatin(t)) out.push(t);
    for (const run of q.match(CJK_RUN) ?? []) {
      if (run.length === 1) out.push(run);
      else for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
    }
    return [...new Set(out)];
  }
  // ICU's dictionary does not know every word — 闭包 (closure) comes back
  // as 闭 + 包. Consecutive single-character Chinese tokens that survived
  // the stoplist are re-joined into one term, since two lone characters in
  // a row are far more often one unknown word than two known ones. A lone
  // single character stays as it is (猫 is a word).
  let run: string[] = [];
  const flush = () => {
    if (run.length) out.push(run.join(''));
    run = [];
  };
  for (const seg of SEGMENTER.segment(q)) {
    if (!seg.isWordLike) {
      flush();
      continue;
    }
    for (const piece of seg.segment.split(/['’]/)) {
      const t = piece.trim();
      if (!t) continue;
      if (CJK_CHAR.test(t)) {
        if (CJK_STOP.has(t)) {
          flush();
        } else if (t.length === 1 && /[㐀-鿿]/.test(t)) {
          run.push(t);
        } else {
          flush();
          out.push(t);
        }
      } else {
        flush();
        if (keepLatin(t)) out.push(t);
      }
    }
  }
  flush();
  return [...new Set(out)];
}

/**
 * The part of a question that names its subject. A chip fills the box with
 * "Draft a short outline for: " and the user completes it; everything
 * before the colon is the instruction and must not drive retrieval. A
 * question without such a prefix is its own subject — the instruction
 * stoplist does the rest there.
 */
export function subjectOf(question: string): string {
  const m = /^([^:：\n]{1,80})[:：]\s*(\S[\s\S]*)$/.exec(question.trim());
  if (!m) return question.trim();
  const prefixWords = m[1].trim().split(/\s+/).length;
  return prefixWords <= 8 ? m[2].trim() : question.trim();
}

export function scoreEntries(question: string, entries: IndexEntry[]): IndexEntry[] {
  const terms = queryTerms(question);
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
    `> The wiki's tag rules — plain markdown, read before every ingest. **The lists are yours; the explanations are the plugin's.** Edit tags freely and they are never overwritten; the callouts (this one included) are rewritten on every start, so deleting or editing them does not stick. Anything else you write in this file will not survive a restart either — your own notes belong in your own notes. Before each such rewrite the previous version is saved next to this file as \`schema.md.bak.<date>\` (the newest 5 are kept, hidden from the file explorer) — if a list ever goes missing, look there.\n` +
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
/**
 * How many output tokens one Improve pass is allowed.
 *
 * Improve rewrites a chunk into a piece of roughly its own size, so the output
 * cap has to follow the input rather than sit at a constant. This used to read
 * `Math.min(2048, estimate + 300)` — a flat ceiling under a comment saying it
 * was not one. With the default 64,000-token context `maxInputTokens` is
 * 24,000, so a chunk could be twelve times longer than the room its rewrite
 * was given, and every note past ~2,048 tokens came back truncated.
 *
 * The invariant that matters, and the one the test asserts: **the budget is
 * never below what the input itself estimates at.** A cap under that number
 * asks the model for a same-sized rewrite and then stops it partway through.
 */
export function improveOutputBudget(text: string, maxInputTokens: number): number {
  const HEADROOM = 300;
  return Math.min(maxInputTokens + HEADROOM, estimateImproveTokens(text) + HEADROOM);
}

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

// ---------------------------------------------------------------------------
// A way back for schema.md
// ---------------------------------------------------------------------------

// schema.md is regenerated on every start: parse, rebuild, overwrite. The
// design is right — it is what keeps the callouts current while the six data
// slots ride through — but three of those slots (Tags, Rejected, and any
// hand-written alias) have no source to rebuild from. Every other generated
// file in the wiki can be reconstructed; schema.md is the one that is also
// irreplaceable. And the failure is silent by construction: a parse that
// loses everything returns the same shape as a schema that legitimately holds
// nothing, so the rewrite writes a correct-looking empty file and nothing
// throws.
//
// Two answers, layered. planSchemaRewrite refuses the rewrites it can tell
// are wrong — a file whose lists are visible to a dumb line scan but invisible
// to the parser, or a rebuild that does not reach a fixed point. And for
// everything no check can see coming, the caller keeps a copy: the previous
// content goes beside the file as `schema.md.bak.<stamp>` before any rewrite
// that changes it, newest few kept. The round-trip test proves the parser and
// the builder agree with each other; only the copy on disk helps with an
// input neither anticipated.

export type SchemaRewritePlan =
  | { kind: 'unchanged' }
  | { kind: 'rewrite'; content: string }
  | { kind: 'refuse'; why: 'unreadable-lists' | 'unstable-rebuild' };

/**
 * List items a dumb scan can see: `- thing` lines outside callouts, minus the
 * `(none)` placeholders. Deliberately a SECOND, stupider reader — its whole
 * value is that it does not share parseSchema's idea of where a section
 * starts, so a section header the user reworded hides the list from the
 * parser but not from this.
 */
function visibleListItems(content: string): number {
  let count = 0;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('>')) continue;
    if (!line.startsWith('- ')) continue;
    if (line.slice(2).trim().startsWith('(')) continue;
    count++;
  }
  return count;
}

export function planSchemaRewrite(current: string): SchemaRewritePlan {
  const parsed = parseSchema(current);

  // Lists on the page, none in the parse: far more likely a parse failure
  // than a user who deleted every list and left the bullets. Refusing keeps
  // the file exactly as it is — stale callouts cost nothing, a lost veto list
  // is permanent. (A user with no tags at all but a bulleted section of
  // their own also lands here; that is over-protection, chosen on purpose.)
  const items = parsed.tags.length + parsed.pending.length + parsed.rejected.length;
  if (items === 0 && visibleListItems(current) > 0) {
    return { kind: 'refuse', why: 'unreadable-lists' };
  }

  const rebuilt = buildSchemaFile(parsed);
  if (rebuilt === current) return { kind: 'unchanged' };

  // The rebuild must be a fixed point: parsing what we are about to write and
  // building again has to reproduce it byte for byte. If it does not, the
  // parser and the builder disagree about this very file, and writing it
  // would begin walking the data somewhere — likely nowhere good. Believed
  // unreachable today; this is insurance against the regression the
  // round-trip test cannot see, on the input it was never shown.
  if (buildSchemaFile(parseSchema(rebuilt)) !== rebuilt) {
    return { kind: 'refuse', why: 'unstable-rebuild' };
  }
  return { kind: 'rewrite', content: rebuilt };
}

/** How many previous versions of schema.md are kept beside it. */
export const SCHEMA_BACKUP_KEEP = 5;

const SCHEMA_BACKUP_PREFIX = 'schema.md.bak.';

/**
 * `schema.md.bak.20260906-142233` — local time, second precision. No colons,
 * because vaults sync to Windows; lexicographic order is age order, which is
 * what lets pruning sort names instead of stat-ing files.
 */
export function schemaBackupName(now: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    SCHEMA_BACKUP_PREFIX +
    `${p(now.getFullYear(), 4)}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

/** Which of these file names are schema backups past the keep limit — oldest first. */
export function schemaBackupsToPrune(names: string[], keep: number): string[] {
  const backups = names.filter((n) => n.startsWith(SCHEMA_BACKUP_PREFIX)).sort();
  return keep > 0 ? backups.slice(0, Math.max(0, backups.length - keep)) : backups;
}


// ---------------------------------------------------------------------------
// Settings migration (#121)
//
// data.json is read on every start and spread over the defaults. That spread
// cannot tell a key the user never set from a key saved under an old name, and
// it passes a value of the wrong type straight through the type assertion. So
// saved data goes through this table first.
//
// The table is keyed on an explicit version stamp, not on which keys are
// present: `lastThread` is the one setting whose absence is normal, and any
// future optional setting inherits the same ambiguity. A version number also
// covers the case a presence check cannot see at all — a key that exists with
// the wrong type.
//
// Append-only. Never delete an entry, however old: data on disk may still be
// from that version, and an install that sat unopened for a year is the exact
// case a migration exists for.
// ---------------------------------------------------------------------------

/** The shape version this build writes. Bump when adding a migration. */
export const SETTINGS_VERSION = 2;

type SavedSettings = Record<string, unknown>;

/**
 * Each entry migrates from version N (its index) to N+1. `known` is the set of
 * keys this build understands — passed in so this file stays free of the
 * obsidian import that settings.ts carries.
 */
const MIGRATIONS: Array<(data: SavedSettings, known: ReadonlySet<string>) => SavedSettings> = [
  // 0 -> 1: the first stamped shape. Every data.json written before the stamp
  // existed is version 0. Nothing was renamed on the way here, so this only
  // drops keys the plugin no longer reads — they would otherwise sit in the
  // file forever, looking like settings the user chose.
  (data, known) => {
    const out: SavedSettings = {};
    for (const [k, v] of Object.entries(data)) {
      if (known.has(k) || k === 'lastThread') out[k] = v;
    }
    return out;
  },
  // 1 -> 2: Direct became Vault. The mode that answered from the model alone
  // now searches your notes first and answers from the model after, so a
  // saved default of 'direct' means 'vault' — the same button, one row down
  // in what it does. Ungrounded turns in a saved thread keep their 'direct'
  // grounding: that describes the answer, which has not changed.
  (data) => {
    const out: SavedSettings = { ...data };
    if (out.defaultMode === 'direct') out.defaultMode = 'vault';
    return out;
  },
];

export interface MigratedSettings {
  data: SavedSettings;
  /** True when the caller should write the result back. */
  changed: boolean;
}

/**
 * Bring saved settings up to SETTINGS_VERSION. Pure: takes whatever loadData
 * returned (including null) and gives back the shape this build expects, plus
 * whether anything moved so the caller can persist it once.
 */
export function migrateSettings(saved: unknown, knownKeys: readonly string[]): MigratedSettings {
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) {
    // Nothing on disk, or nothing usable. Defaults will fill in; stamping the
    // version makes the first save a versioned one.
    return { data: { settingsVersion: SETTINGS_VERSION }, changed: saved !== null && saved !== undefined };
  }
  const known = new Set(knownKeys);
  let data: SavedSettings = { ...(saved as SavedSettings) };
  const from = typeof data.settingsVersion === 'number' && Number.isInteger(data.settingsVersion)
    ? Math.max(0, data.settingsVersion)
    : 0;
  if (from >= SETTINGS_VERSION) return { data, changed: false };
  for (let v = from; v < SETTINGS_VERSION; v++) {
    data = MIGRATIONS[v](data, known);
  }
  data.settingsVersion = SETTINGS_VERSION;
  return { data, changed: true };
}

// Cheap 32-bit content hash (FNV-1a) — only needs to detect "changed vs
// not", so no crypto. Hex string, stored in page frontmatter as
// source_hash so re-ingest and (later) auto-scan can skip unchanged notes.
export function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}


// ---------------------------------------------------------------------------
// Vault shape, for the "Folder structure" skill
//
// Paths and counts only. "How should I organise this?" is a question about
// the shape of a vault, not its contents, and shape is the one thing none of
// the three chat modes could see: This note sees one file, Wiki sees ingested
// pages, Direct sees nothing. A folder name is not material in the sense the
// trust model protects — it is already visible in the file explorer — so
// handing the model the tree crosses no line the plugin draws.
// ---------------------------------------------------------------------------

export interface VaultTreeOptions {
  /** Folder to leave out entirely — the wiki, which the plugin wrote. */
  exclude?: string;
  /** Hard cap on emitted lines, so a huge vault stays inside a prompt. */
  maxLines?: number;
}

/**
 * Render markdown paths as an indented folder tree with a note count per
 * folder. Counts are recursive (a folder's number includes its subfolders),
 * folders sort by name at each level, and root-level notes appear as a
 * single line rather than one per file.
 */
export function formatVaultTree(paths: readonly string[], opts: VaultTreeOptions = {}): string {
  const exclude = opts.exclude ? opts.exclude.replace(/\/+$/, '') + '/' : null;
  const maxLines = opts.maxLines ?? 120;

  interface Node { children: Map<string, Node>; notes: number }
  const root: Node = { children: new Map(), notes: 0 };
  let rootNotes = 0;

  for (const raw of paths) {
    if (!raw.endsWith('.md')) continue;
    if (exclude && raw.startsWith(exclude)) continue;
    const parts = raw.split('/');
    if (parts.length === 1) { rootNotes++; continue; }
    let node = root;
    for (const dir of parts.slice(0, -1)) {
      let next = node.children.get(dir);
      if (!next) { next = { children: new Map(), notes: 0 }; node.children.set(dir, next); }
      node = next;
      node.notes++;
    }
  }

  const lines: string[] = [];
  const walk = (node: Node, depth: number) => {
    const names = [...node.children.keys()].sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      if (lines.length >= maxLines) return;
      const child = node.children.get(name)!;
      lines.push(`${'  '.repeat(depth)}${name}/ (${child.notes})`);
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  if (rootNotes > 0 && lines.length < maxLines) lines.push(`(root) ${rootNotes} loose note${rootNotes === 1 ? '' : 's'}`);
  if (lines.length >= maxLines) lines.push('…');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Where the time goes (#132)
//
// Every model call on this plugin costs seconds, not milliseconds — the model
// is in the renderer and there is no server absorbing the latency. So "that
// ingest felt slow" is a claim nobody can act on: an ingest is a draft call, a
// tag pass, a link pass and a provenance check, and knowing which of the four
// to look at is the whole of the optimisation.
//
// Totals are cumulative and deliberately never reset. A reset would be wrong
// the moment two runs overlap, and a background scan running while you file
// one note by hand is exactly the case this is for. Callers take a snapshot
// before their work and diff it afterwards.
// ---------------------------------------------------------------------------

export interface TaskUsage {
  calls: number;
  /** Wall time spent inside the model. Overlaps when calls run concurrently. */
  millis: number;
}

export type UsageSnapshot = Readonly<Record<string, TaskUsage>>;

export interface UsageRow extends TaskUsage {
  task: string;
  /** Share of the window's total time, 0–1. Zero when nothing was measured. */
  share: number;
  /** Mean wall time per call, for spotting one slow call among many fast ones. */
  millisPerCall: number;
}

/**
 * What happened between two snapshots, slowest first.
 *
 * Tasks absent from `after`, or whose numbers went backwards, are dropped
 * rather than reported as negative: the only ways that happens are a reload
 * between the two snapshots or a caller passing them the wrong way round, and
 * a row saying a step took minus four seconds helps with neither.
 */
export function diffUsage(before: UsageSnapshot, after: UsageSnapshot): UsageRow[] {
  const rows: UsageRow[] = [];
  let total = 0;
  for (const [task, now] of Object.entries(after)) {
    const was = before[task] ?? { calls: 0, millis: 0 };
    const calls = now.calls - was.calls;
    const millis = now.millis - was.millis;
    if (calls <= 0 || millis < 0) continue;
    rows.push({ task, calls, millis, share: 0, millisPerCall: millis / calls });
    total += millis;
  }
  for (const r of rows) r.share = total > 0 ? r.millis / total : 0;
  // Slowest first: the row you act on is the one at the top, and ties break by
  // name so the same work produces the same report twice.
  rows.sort((a, b) => b.millis - a.millis || a.task.localeCompare(b.task));
  return rows;
}

/** `1.4s`, `320ms`, `2m 05s` — whichever reads as a duration at that size. */
export function formatMillis(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/**
 * A Markdown table of the rows, plus a total line.
 *
 * Returns an empty string when nothing was measured, so a caller can append it
 * unconditionally and a run that made no model calls adds no noise.
 */
export function formatUsageReport(rows: readonly UsageRow[]): string {
  if (!rows.length) return '';
  const total = rows.reduce((n, r) => n + r.millis, 0);
  const calls = rows.reduce((n, r) => n + r.calls, 0);
  const lines = [
    '| Step | Calls | Time | Per call | Share |',
    '|---|---:|---:|---:|---:|',
    ...rows.map(
      (r) =>
        `| ${r.task} | ${r.calls} | ${formatMillis(r.millis)} | ` +
        `${formatMillis(r.millisPerCall)} | ${Math.round(r.share * 100)}% |`
    ),
    `| **Total** | **${calls}** | **${formatMillis(total)}** | | |`,
  ];
  return lines.join('\n');
}


// ---------------------------------------------------------------------------
// Related pages without a model call
//
// Relink fills an empty Related section by asking the model which pages
// relate. That is one call per empty page, twenty seconds each, and on a wiki
// of eighty pages most of the answers were already visible in the metadata:
// two pages that share a tag, or whose summaries use the same terms. This
// finds those first. Only a page it cannot place goes to the model.
//
// Two signals, deliberately unequal. A shared tag is a curated statement —
// someone (or the vocabulary pass) decided both pages are about that — so one
// shared tag qualifies on its own. Term overlap is incidental: two summaries
// can share "notes" and "week" and have nothing to do with each other, so it
// takes three overlapping terms before overlap alone counts as a relation.
// ---------------------------------------------------------------------------

export interface RelatedSuggestion {
  entry: IndexEntry;
  sharedTags: string[];
  termHits: number;
}

export function suggestRelated(
  page: IndexEntry,
  candidates: readonly IndexEntry[],
  tagsOf: ReadonlyMap<string, readonly string[]>,
  max = 3
): RelatedSuggestion[] {
  const mine = new Set(tagsOf.get(page.linkPath) ?? []);
  const terms = queryTerms(`${page.title} ${page.summary}`);
  const out: RelatedSuggestion[] = [];
  for (const c of candidates) {
    if (c.linkPath === page.linkPath) continue;
    const sharedTags = (tagsOf.get(c.linkPath) ?? []).filter((t) => mine.has(t)).sort();
    const hay = `${c.title} ${c.summary}`.toLowerCase();
    const termHits = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
    if (sharedTags.length >= 1 || termHits >= 3) out.push({ entry: c, sharedTags, termHits });
  }
  // Strictly tags first, then overlap, then path. Not a weighted sum: a
  // weighted sum lets six incidental word hits outrank one curated tag, and
  // the whole reason a tag counts is that it is a decision rather than a
  // coincidence. Path last, so the same wiki gives the same answer twice —
  // which is what lets a user trust a preview they have seen before.
  out.sort(
    (a, b) =>
      b.sharedTags.length - a.sharedTags.length ||
      b.termHits - a.termHits ||
      a.entry.linkPath.localeCompare(b.entry.linkPath)
  );
  return out.slice(0, max);
}

// ---------------------------------------------------------------------------
// Standing instructions for chat
// ---------------------------------------------------------------------------

/** Longest standing-instruction text the prompt will carry, in characters. */
export const CHAT_INSTRUCTIONS_MAX = 2000;

/**
 * The block appended to every chat system prompt when the user has written
 * standing instructions in settings — "answer in Japanese", "keep it under
 * 150 words", "use British spelling".
 *
 * It goes after the mode's own rules and says so, so a grounding rule and an
 * instruction that pull in opposite directions resolve in favour of the
 * grounding: an instruction can change how an answer is written, not what it
 * is allowed to stand on. Empty or whitespace-only text yields an empty string
 * so the prompt is untouched. Text over the cap is cut and the cut is marked,
 * so a pasted essay does not silently lose its ending.
 */
export function standingInstructions(raw: string, max = CHAT_INSTRUCTIONS_MAX): string {
  const text = raw.trim();
  if (!text) return '';
  const body = text.length > max ? `${text.slice(0, max).trimEnd()} […cut at ${max} characters]` : text;
  return (
    '\n\nThe user has set standing instructions for every answer. Follow them for tone, ' +
    'language, length and format; where they conflict with the rules above about what ' +
    'material an answer may draw on, the rules above win.\n' +
    body
  );
}

// ---------------------------------------------------------------------------
// Mode routing for chat
// ---------------------------------------------------------------------------

/**
 * Whether a question is about the user's own notes — "what's in my vault",
 * "which pages did I add", 「私のノートには何がある」 — as opposed to about the
 * world. Lexical and deliberately narrow: it looks for a possessive next to a
 * word for the vault, or a first-person "what did I write", in English and
 * Japanese. A question that merely contains the word "vault" ("explain what
 * an Obsidian vault is") is not caught, and should not be.
 *
 * Used in two places. Before sending in Direct mode, where a hit means the
 * model is about to say "I do not have access to your files" twenty seconds
 * from now, so the panel says it first and offers the mode that can answer.
 * And when a routed question lands in Wiki mode, where a hit means the
 * question is about the collection and should ground in every page.
 */
export function asksAboutOwnNotes(question: string): boolean {
  const q = question.trim();
  if (!q) return false;
  const NOTES = String.raw`(?:vault|valut|vaults|notes?|wiki|files?|knowledge\s*base|second\s*brain|obsidian)`;
  const patterns: RegExp[] = [
    new RegExp(String.raw`\b(?:my|our|your)\s+(?:own\s+)?${NOTES}\b`, 'i'),
    new RegExp(String.raw`\b(?:in|from|across|inside|within|throughout)\s+(?:the|this)\s+(?:whole\s+|entire\s+)?${NOTES}\b`, 'i'),
    /(?:私|僕|俺|自分|わたし|ぼく)\s*の\s*(?:vault|valut|wiki|ノート|メモ|ボールト|保管庫|ファイル)/,
    /(?:vault|valut|wiki|ノート|メモ)\s*(?:には|の中|内に|の中に)/,
    /(?:我|俺|咱|我们|我們)\s*的?\s*(?:vault|valut|笔记|筆記|笔记库|库|庫|wiki|文件|文章)/,
    /(?:vault|valut|wiki|笔记|筆記)\s*(?:里|裡|中|内|里面|裡面)/,
    /我(?:写|寫|加|存|记|記|收藏|剪藏|保存)(?:过|了|的)/,
    /\bwo\s*de\b/i,
    /\b(?:what|which|how many)\b[^.?!]{0,40}\bI\s+(?:wrote|write|added|add|saved|save|clipped|clip|filed|file|noted|note|ingested|ingest|have)\b/i,
    /(?:私|僕|俺|自分)(?:が|は)[^。？?]{0,24}(?:書い|保存し|追加し|クリップし|メモし)/,
  ];
  return patterns.some((p) => p.test(q));
}

/**
 * Whether an answer is the model declining rather than answering — "I do
 * not have access to your files", "the note does not mention", "is unclear",
 * and the Japanese equivalents. Only the opening of the answer is read,
 * because a refusal is the whole answer and short, while a good answer may
 * still carry a caveat somewhere in its third paragraph.
 *
 * Every mode can produce one: This note when the question was about the
 * vault, Wiki when it was about one note, Direct when it was about either.
 * A hit means the question was asked in the wrong place, and the panel can
 * say which place is right.
 */
export function looksLikeRefusal(answer: string): boolean {
  // The first paragraph only. A refusal is one paragraph; an answer that
  // says "the note does not mention which GPU" in its third is an answer.
  const trimmed = answer.trim();
  const para = trimmed.split(/\n\s*\n/, 1)[0] ?? '';
  const head = para.slice(0, 240);
  if (!head) return false;
  const patterns: RegExp[] = [
    /\bI\s+(?:do\s+not|don't|did\s+not|didn't|cannot|can't|could\s+not|couldn't|am\s+unable\s+to|was\s+unable\s+to)\s+(?:have\s+)?(?:access|follow|find|see|tell|determine|locate|answer|identify)\b/i,
    /\b(?:is|are|seems|remains)\s+unclear\b/i,
    /\b(?:the|this|your|these)\s+(?:note|notes|wiki|material|page|pages|text|document|documents|content)\s+(?:does|do|did)\s+not\s+(?:mention|say|contain|cover|include|address|discuss|provide|specify|explain)\b/i,
    /\bnot\s+(?:mentioned|covered|present|included|found|addressed|discussed|described)\s+(?:in|anywhere\s+in)\s+(?:the|this|your|these)\b/i,
    /\bno\s+(?:information|mention|details?|reference|content)\s+(?:about|on|regarding|of)\b/i,
    /\bnothing\s+in\s+(?:the|this|your|these)\s+(?:note|notes|wiki|material|page|pages)\b/i,
    /\bnot\s+in\s+(?:your|the|this)\s+(?:wiki|note|notes|material)\b/i,
    /\b(?:personal|private)\s+(?:files|notes|vault|data|documents)\b/i,
    /\bplease\s+(?:ask|rephrase|clarify|provide)\b/i,
    /(?:アクセス|参照|確認)(?:でき|出来)ません/,
    /(?:記載|言及|情報)(?:が|は)(?:ありません|されていません|見当たりません)/,
    /(?:分かりません|わかりません|不明です|見つかりません|判断できません)/,
    /无法(?:访问|訪問|获取|獲取|查看|找到|回答|确定|確定)/,
    /没有(?:提到|提及|包含|相关|相關|找到|涉及|明确)/,
    /(?:不清楚|不明确|不明確|无法理解|無法理解)/,
  ];
  return patterns.some((p) => p.test(head));
}

// ---------------------------------------------------------------------------
// Vault search — the retrieval behind Vault mode
// ---------------------------------------------------------------------------

/** What the metadata cache knows about a note without reading it. */
export interface VaultDoc {
  path: string;
  title: string;
  tags: string[];
  headings: string[];
}

export interface VaultHit {
  path: string;
  score: number;
  /**
   * `about`: the subject is in the title, a tag or a heading, or the body
   * names it three times or more. `mentions`: the body names it once or
   * twice. The difference between a note on coffee and a note that says
   * "coffee's on me" in an example sentence — which lexical search alone
   * cannot tell, and the panel must.
   */
  tier: 'about' | 'mentions';
  /** Typed terms found in the title, tags or headings. */
  metaTyped?: string[];
  /** Expansion terms found there. They promote a note to "about" only when rare in this vault. */
  metaExpanded?: string[];
}

/**
 * The score a note needs before Vault mode treats it as a match. Body terms
 * are weighted by rarity (see rescoreWithBodies): a term in one note of four
 * hundred scores two on a single mention, a term in a tenth of them scores
 * about one, and a term in more than half of them scores nothing. One is
 * therefore "a word this vault does not use everywhere, found here" — the
 * point at which "your notes say something about this" stops being a
 * stretch. A title or tag hit is three and always clears it.
 */
export const VAULT_MATCH_MIN = 1;

/** Ranking is by score alone; the tier is what the panel says about each hit, not where it sorts. */
function byScore(a: VaultHit, b: VaultHit): number {
  return b.score - a.score || a.path.localeCompare(b.path);
}

/**
 * Rank every note in the vault against a question from metadata alone —
 * title, tags, headings — which the metadata cache holds for the whole vault
 * without a single file read. A term in the title or a tag is worth more than
 * one in a heading, because a note called "coffee" is about coffee and a note
 * with a heading mentioning it might be about anything.
 *
 * Returns only notes that scored, best first, at most `max`. The body pass
 * (`rescoreWithBodies`) refines the top of this list.
 */
export function rankVaultDocs(
  question: string,
  docs: readonly VaultDoc[],
  max = 60,
  extra: readonly string[] = []
): VaultHit[] {
  const subject = subjectOf(question);
  const own = queryTerms(subject);
  const ownShort = shortTerms(subject);
  const more = expansionTerms(extra, new Set([...own, ...ownShort]));
  const typed: { t: string; whole: boolean }[] = [
    ...own.map((t) => ({ t, whole: false })),
    ...ownShort.map((t) => ({ t, whole: true })),
  ];
  if (!typed.length && !more.length) return [];
  const has = (hay: string, t: string, whole: boolean) => countIn(hay, t, whole, 1) > 0;
  const hits: VaultHit[] = [];
  for (const d of docs) {
    const title = d.title.toLowerCase();
    const tags = d.tags.map((t) => t.toLowerCase().replace(/^#/, ''));
    const tagText = tags.join(' ');
    const headings = d.headings.join(' ').toLowerCase();
    let score = 0;
    const metaTyped: string[] = [];
    const metaExpanded: string[] = [];
    for (const { t, whole } of typed) {
      let s = 0;
      if (has(title, t, whole)) s = 3;
      else if (whole ? tags.includes(t) : has(tagText, t, false)) s = 3;
      else if (has(headings, t, whole)) s = 1;
      if (s) { score += s; metaTyped.push(t); }
    }
    for (const { t, whole } of more) {
      let s = 0;
      if (has(title, t, whole)) s = 3;
      else if (whole ? tags.includes(t) : has(tagText, t, false)) s = 3;
      else if (has(headings, t, whole)) s = 1;
      if (s) { score += s * EXPANSION_WEIGHT; metaExpanded.push(t); }
    }
    if (score > 0) hits.push({ path: d.path, score, tier: 'about', metaTyped, metaExpanded });
  }
  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return hits.slice(0, max);
}

/**
 * Two-letter function words. STOPWORDS never needed them, because queryTerms
 * drops everything under three letters; shortTerms keeps two-letter tokens
 * for "js" and "ai", so it has to drop "is" and "my" itself.
 */
const SHORT_STOP = new Set([
  // English
  'am', 'an', 'as', 'at', 'be', 'by', 'do', 'go', 'he', 'if', 'in', 'is', 'it', 'me', 'my',
  'no', 'of', 'ok', 'on', 'or', 'so', 'to', 'up', 'us', 'vs', 'we', 're', 'im', 'id',
  // French, Spanish, German
  'de', 'la', 'le', 'du', 'un', 'en', 'et', 'ou', 'où', 'ne', 'se', 'si', 'ce', 'ça', 'au',
  'es', 'el', 'al', 'lo', 'os', 'ni', 'su', 'tu', 'te', 'ya', 'da', 'zu', 'ob', 'ja', 'wo',
  'er', 'um', 'ab', 'im',
]);

/** Two-letter ASCII tokens, matched as whole words: "js", "ai", "c#". */
export function shortTerms(question: string): string[] {
  return [...new Set(
    question
      .toLowerCase()
      .split(/[^a-z0-9#+]+/)
      .filter((t) => t.length === 2 && /^[a-z0-9+#]+$/.test(t) && !SHORT_STOP.has(t))
  )];
}

function countIn(hay: string, term: string, whole: boolean, cap = 3): number {
  if (whole) {
    const re = new RegExp(`(?<![a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'g');
    let n = 0;
    while (n < cap && re.exec(hay)) n++;
    return n;
  }
  let n = 0;
  let i = hay.indexOf(term);
  while (i !== -1 && n < cap) {
    n++;
    i = hay.indexOf(term, i + term.length);
  }
  return n;
}

/**
 * Add what the bodies say, weighted by how rare each term is in this vault.
 *
 * Plain counts failed on the first real vault: a question in a language
 * without word spaces splits into two-character pieces, most of which are
 * the language's connective tissue and occur in nearly every note. The
 * longest notes then won every query, whatever it asked. A term found in
 * most of the vault's notes says nothing about which of them is meant; a
 * term found in two of them says a great deal. So each term's contribution
 * is scaled by log((N+1)/df) / log(N+1): one for a term unique to one note,
 * falling to zero for a term in more than half of them. Language-agnostic,
 * and computed from the bodies at hand — no stoplist to maintain.
 *
 * Per term: (1 + occurrences, capped at three) × weight, so a rare term
 * once is worth two, and a note repeating a common word forty times gains
 * nothing on one that uses three rare words once each. Metadata scores in
 * `prior` (title, tag, heading) are added unweighted. Notes whose bodies
 * are identical — the same file kept in two folders — count once, the
 * first path kept.
 */
/** A query term with the weight this vault gives it. See weightedTerms. */
export interface WeightedTerm {
  t: string;
  /** Match as a whole word (two-letter tokens) rather than as a substring. */
  whole: boolean;
  /** 1 for a term unique to one note, decaying towards 0 for one in all of them. */
  weight: number;
  /** From the model's expansion of the subject, not from the question itself. */
  expanded?: boolean;
}

/** How much an expansion term counts relative to a word the user typed. */
const EXPANSION_WEIGHT = 0.7;

/**
 * Turn the expansion terms into the same shape as the question's own:
 * long ones as substrings, two-letter Latin ones as whole words, the
 * stoplists applied, anything already in the question dropped.
 */
function expansionTerms(extra: readonly string[], own: ReadonlySet<string>): { t: string; whole: boolean }[] {
  const out: { t: string; whole: boolean }[] = [];
  const seen = new Set<string>();
  for (const raw of extra) {
    // A Latin expansion term matches as a whole word: the model offered
    // "web" for javascript, and as a substring it found every WebView note
    // in the vault. Chinese and Japanese terms have no word boundaries and
    // stay substrings.
    for (const t of queryTerms(raw)) if (!own.has(t) && !seen.has(t)) { seen.add(t); out.push({ t, whole: !CJK_CHAR.test(t) }); }
    for (const t of shortTerms(raw)) if (!own.has(t) && !seen.has(t)) { seen.add(t); out.push({ t, whole: true }); }
  }
  return out;
}

/** One entry per distinct body, lower-cased; a duplicate keeps only the first path. */
function distinctDocs(bodies: ReadonlyMap<string, string>): [string, string][] {
  const seen = new Set<string>();
  const docs: [string, string][] = [];
  for (const [path, body] of bodies) {
    const key = body.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    docs.push([path, key.toLowerCase()]);
  }
  return docs;
}

/**
 * The question's terms, each weighted by how rare it is across `bodies`:
 * log((N+1)/df) / log(N+1), so one for a term unique to one note, decaying
 * towards zero for a term in nearly all of them — a word the vault is about
 * as a whole. Language-agnostic, computed from the bodies at hand. Only the
 * subject of the question contributes (see subjectOf). Used by
 * the ranking and by the excerpting, which must agree on which words
 * matter: ranking a note up for "coffee" and then sending the model the
 * paragraphs around "about" and "what" was how a matched note came back
 * as "does not mention coffee".
 */
export function weightedTerms(
  question: string,
  bodies: ReadonlyMap<string, string>,
  extra: readonly string[] = []
): WeightedTerm[] {
  const subject = subjectOf(question);
  const long = queryTerms(subject);
  const short = shortTerms(subject);
  const more = expansionTerms(extra, new Set([...long, ...short]));
  const terms: WeightedTerm[] = [
    ...long.map((t) => ({ t, whole: false, weight: 0 })),
    ...short.map((t) => ({ t, whole: true, weight: 0 })),
    ...more.map(({ t, whole }) => ({ t, whole, weight: 0, expanded: true })),
  ];
  const docs = distinctDocs(bodies);
  const n = docs.length;
  if (!n) return terms.map((w) => ({ ...w, weight: 1 }));
  for (const w of terms) {
    let df = 0;
    for (const [, hay] of docs) if (countIn(hay, w.t, w.whole, 1) > 0) df++;
    // A smooth decay, not a cliff at half the vault: this vault had two of
    // its own core subjects sitting at 50.5% and 50.8% and unsearchable,
    // while near-identical neighbours at 45% survived. At half the notes a
    // term is now worth about 0.12; at all of them, next to nothing.
    w.weight = df === 0 ? 0 : Math.log((n + 1) / df) / Math.log(n + 1);
    if (w.expanded) w.weight *= EXPANSION_WEIGHT;
  }
  return terms;
}

export function rescoreWithBodies(
  question: string,
  prior: readonly VaultHit[],
  bodies: ReadonlyMap<string, string>,
  max = 5,
  min = VAULT_MATCH_MIN,
  extra: readonly string[] = []
): VaultHit[] {
  const terms = weightedTerms(question, bodies, extra);
  if (!terms.length) return [];
  const priorScore = new Map<string, number>(prior.map((h) => [h.path, h.score]));
  const priorHit = new Map<string, VaultHit>(prior.map((h) => [h.path, h]));
  const weightOf = new Map<string, number>(terms.map((w) => [w.t, w.weight]));
  const docs = distinctDocs(bodies);
  if (!docs.length) {
    return [...priorScore.entries()]
      .map(([path, score]) => ({ path, score, tier: 'about' as const }))
      .filter((h) => h.score >= min)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, max);
  }

  const scored: VaultHit[] = [];
  const bodyPaths = new Set(docs.map(([p]) => p));
  for (const [path, hay] of docs) {
    const fromMetadata = priorScore.get(path) ?? 0;
    const meta = priorHit.get(path);
    let score = fromMetadata;
    let dense = false;
    for (const w of terms) {
      if (w.weight === 0) continue;
      const c = countIn(hay, w.t, w.whole);
      if (c > 0) score += (1 + c) * w.weight;
      // "About" by body alone means the subject keeps coming up, relative to
      // the note's length: three mentions in a two-page note, not three in
      // a twenty-page one that used it as an example. At least three, and
      // at least one per thousand characters, of a term that carries real
      // weight in this vault — a typed term, or an expansion term that is
      // rare enough here to mean the subject and not "web".
      if (c >= 3 && w.weight >= (w.expanded ? 0.3 : 0.2)) {
        const all = countIn(hay, w.t, w.whole, 50);
        if (all / Math.max(1, hay.length / 1000) >= 1) dense = true;
      }
    }
    // A typed term in the title, tags or headings makes a note about the
    // subject. An expansion term there does too, unless it is one the vault
    // uses nearly everywhere (weight under 0.15): whole-word matching has
    // already kept "web" out of WebView, so what reaches here is 闭包 in a
    // title called 闭包 — the subject, in a vault that is largely about it.
    const metaAbout =
      (meta?.metaTyped?.length ?? 0) > 0 ||
      (meta?.metaExpanded ?? []).some((t) => (weightOf.get(t) ?? 0) >= 0.15);
    if (score >= min) {
      scored.push({ path, score, tier: metaAbout || dense ? 'about' : 'mentions' });
    }
  }
  // Metadata-only hits whose bodies were not read (large vaults) still count.
  for (const [path, score] of priorScore) {
    if (!bodyPaths.has(path) && !bodies.has(path) && score >= min) scored.push({ path, score, tier: 'about' });
  }
  return scored.sort(byScore).slice(0, max);
}

/**
 * Whether a question asks for what was written recently — "what did I
 * write this week", 「最近書いたノートは」. The answer is the plugin's own
 * list of the most recently edited notes; the model is not asked to know
 * dates it was never told. A time word alone is not enough ("latest version
 * of Node"): a word for notes or writing has to be there too.
 */
export function looksLikeRecentQuery(question: string): boolean {
  const q = question.trim();
  if (!q) return false;
  const time = /\b(?:recent|recently|lately|latest|newest|last\s+(?:few\s+)?(?:days?|weeks?|months?)|this\s+(?:week|month)|today|yesterday)\b/i;
  const notes = /\b(?:notes?|files?|pages?|entries|wrote|write|written|writing|edit|edited|editing|add|added|adding|work|worked|working|touch|touched)\b/i;
  const timeJa = /(?:最近|今週|先週|今月|今日|昨日|この頃|ここ数日|直近)/;
  const notesJa = /(?:ノート|メモ|書い|編集|追加|作業|触っ)/;
  const timeZh = /(?:最近|这周|这星期|本周|上周|这个月|今天|昨天|这几天|近期)/;
  const notesZh = /(?:笔记|文章|文件|写|编辑|改|加|新增|做)/;
  return (time.test(q) && notes.test(q)) || (timeJa.test(q) && notesJa.test(q)) || (timeZh.test(q) && notesZh.test(q));
}

/**
 * Whether a question asks for a list of notes rather than an answer — "which
 * of my notes mention X", 「JS に関するノートはどれ」. The answer to one of these
 * is the plugin's search result drawn as links, with the model adding a line
 * per note; the model is not asked to find anything, because it cannot.
 */
export function looksLikeListQuery(question: string): boolean {
  const q = question.trim();
  if (!q) return false;
  const patterns: RegExp[] = [
    /\b(?:which|what)\s+(?:of\s+my\s+)?(?:notes?|files?|pages?|articles?|documents?|entries)\b/i,
    /\b(?:list|show|find|search|locate)\b[^.?!]{0,30}\b(?:notes?|files?|pages?|articles?|documents?)\b/i,
    /\b(?:notes?|files?|articles?)\s+(?:do\s+i\s+have|have\s+i\s+got|are\s+there|exist)\b/i,
    /\bhow\s+many\s+(?:notes?|files?|pages?|articles?)\b/i,
    /(?:どの|どんな|どれ)\s*(?:ノート|記事|ファイル|メモ)/,
    /(?:ノート|記事|ファイル|メモ)(?:の一覧|を一覧|をリスト|を探して|を検索|はどれ|を見つけて)/,
    /(?:何件|いくつ)の?(?:ノート|記事|ファイル|メモ)/,
    /(?:哪些|哪几篇|哪几个|哪一篇|有几篇|有多少篇|列出|列一下|找一下|找找|找出|搜一下|搜索)/,
    /(?:笔记|筆記|文章|文件|页面|頁面)(?:有哪些|都有什么|都有啥|有什么|提到)/,
  ];
  return patterns.some((p) => p.test(q));
}

/**
 * The part of a note worth sending: windows around where the question's
 * terms occur, merged and joined with ellipses, capped in characters.
 *
 * Terms are taken in the order given, which the caller makes heaviest
 * first, and each term's windows are added only while the cap allows —
 * so the paragraphs around the rare word that got this note ranked are
 * what arrive, and the paragraphs around a word found in every note are
 * what get left out. Taking windows in document order instead let a
 * connective piece that appears on line one spend the whole budget before
 * the one mention of the subject on line ninety. A plain string is a
 * substring term; `{ t, whole: true }` matches as a whole word.
 *
 * Falls back to the opening when no term is found (an attached note, or a
 * title-only match).
 */
export function excerptAround(
  body: string,
  terms: readonly (string | { t: string; whole: boolean })[],
  maxChars: number,
  radius = 350
): string {
  const text = body.trim();
  if (text.length <= maxChars) return text;
  const hay = text.toLowerCase();
  const spans: [number, number][] = [];
  let budget = maxChars;
  for (const term of terms) {
    const t = typeof term === 'string' ? term : term.t;
    const whole = typeof term === 'string' ? false : term.whole;
    if (!t) continue;
    let n = 0;
    let i = -1;
    const re = whole ? new RegExp(`(?<![a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'g') : null;
    for (;;) {
      if (re) {
        const m = re.exec(hay);
        i = m ? m.index : -1;
      } else {
        i = hay.indexOf(t, i + 1);
      }
      if (i === -1 || n >= 4) break;
      const a = Math.max(0, i - radius);
      const b = Math.min(text.length, i + t.length + radius);
      // Only what this window adds beyond windows already taken counts.
      const covered = spans.reduce((acc, [x, y]) => acc + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0);
      const cost = b - a - covered;
      if (cost > budget) break;
      budget -= cost;
      spans.push([a, b]);
      n++;
    }
  }
  if (!spans.length) return `${text.slice(0, maxChars).trimEnd()}…`;
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]);
    else merged.push([sp[0], sp[1]]);
  }
  let out = '';
  for (const [a, b] of merged) {
    const piece = text.slice(a, b).trim();
    const sep = out ? '\n…\n' : a > 0 ? '…' : '';
    out += sep + piece;
  }
  if (out.length > maxChars) out = `${out.slice(0, maxChars).trimEnd()}…`;
  return out || `${text.slice(0, maxChars).trimEnd()}…`;
}


/**
 * Whether a question is about the collection rather than about a subject in
 * it — "what connects my notes", "what am I missing", "what did I add this
 * week", 「ノート同士のつながりは」. Vault mode can only answer such a question
 * from the four raw notes it can hold, which is shallow; the cards can hold
 * fifty. A hit means the answer should say so and point at Wiki.
 */
export function looksLikeCollectionQuery(question: string): boolean {
  const q = question.trim();
  if (!q) return false;
  const en = /\b(?:connect|connects|connections|connected|in\s+common|common\s+threads?|themes?|patterns?|across\s+(?:my|all|the)\s+(?:notes|vault|pages|cards)|overall|big\s+picture|overview\s+of\s+(?:my|all)|missing|gaps?|still\s+open|unanswered|contradict|contradictions?|disagree|inconsistent|what\s+did\s+i\s+add|added\s+this\s+week|what\s+have\s+i\s+been\s+(?:writing|working))\b/i;
  const ja = /(?:つながり|関連|共通|全体|傾向|テーマ|パターン|足りない|抜け|欠け|矛盾|食い違|今週追加|追加したもの)/;
  const zh = /(?:联系|關聯|关联|共同|主题|主題|整体|整體|全局|规律|模式|缺|少了|没写完|未完成|矛盾|冲突|衝突|不一致|这周加|本周加|新增了)/;
  return en.test(q) || ja.test(q) || zh.test(q);
}

/**
 * Drop a leading "I do not have access to your notes" from an answer that
 * then goes on to answer anyway. The second half of a Vault answer is asked
 * for general knowledge about the subject, and a 4B model asked "what did I
 * write about coffee" will still open with the disclaimer before writing
 * about coffee. Under a label that says the notes were handled above, that
 * sentence is not caution, it is a contradiction. Only the opening is
 * removed, and only when something substantive follows; a bare refusal is
 * returned untouched so it can be seen for what it is.
 */
export function stripLeadingRefusal(answer: string): string {
  const text = answer.trim();
  // First paragraph, or first sentence if the paragraph runs on.
  const paraEnd = text.search(/\n\s*\n/);
  const firstPara = paraEnd === -1 ? text : text.slice(0, paraEnd);
  const sentenceEnd = firstPara.search(/(?<=[.!?。！？])\s/);
  const head = sentenceEnd === -1 ? firstPara : firstPara.slice(0, sentenceEnd);
  if (!looksLikeRefusal(head)) return text;
  const rest = text.slice(head.length).replace(/^[\s.]*(?:However|That said|But|Still|Nevertheless|ただし|しかし)?[,，、]?\s*/i, '');
  if (rest.trim().length < 40) return text;
  // Recase the first letter, since "however, I can" is now the opening.
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/**
 * One hit per note name. A vault that keeps the same notes in two folders
 * — a working copy and an archive — produces pairs whose bodies differ by a
 * line, which the body-level dedupe cannot see; the Sources row then shows
 * the same title twice. Two genuinely different notes with the same name
 * are rarer than that, and the higher-scoring one is kept either way.
 */
export function dedupeByName(hits: readonly VaultHit[]): VaultHit[] {
  const seen = new Set<string>();
  const out: VaultHit[] = [];
  for (const h of hits) {
    const name = h.path.replace(/^.*\//, '').replace(/\.md$/, '').toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(h);
  }
  return out;
}

/**
 * What a Vault answer feeds back into the conversation history. See
 * ChatTurnRecord.historyText. `kind` is the answer's shape; `grounded` is
 * the first part, before the model's own addition.
 */
export function vaultHistoryText(kind: 'none' | 'overview' | 'list' | 'both', grounded: string): string | undefined {
  switch (kind) {
    case 'both':
      return grounded;
    case 'list':
      return '(A list of matching notes was shown here, with one line each.)';
    default:
      return undefined;
  }
}

/**
 * The model's expansion of a search subject, parsed: one keyword per line,
 * bullets and numbering stripped, at most eight, none longer than thirty
 * characters, nothing that is only a stopword, nothing already in the
 * subject. The model is asked for the full name of an abbreviation, the
 * synonyms, the main sub-topics and the Chinese and Japanese names — so
 * "js" reaches the note about closures that never spells out JavaScript.
 * Anything else it says is dropped: a sentence is not a keyword.
 */
export function parseExpansion(raw: string, subject: string): string[] {
  const own = new Set([...queryTerms(subject), ...shortTerms(subject)]);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\n|[,，;；、]/)) {
    const k = line.replace(/^[\s\-*•·\d.)\]]+/, '').replace(/[.。:：]+$/, '').trim().toLowerCase();
    if (!k || k.length > 30 || k.length < 2) continue;
    if (/\s.*\s.*\s.*\s/.test(k)) continue; // five words or more is a sentence
    const terms = [...queryTerms(k), ...shortTerms(k)];
    if (!terms.length) continue;
    if (terms.every((t) => own.has(t))) continue;
    const key = terms.join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
    if (out.length >= 8) break;
  }
  return out;
}
