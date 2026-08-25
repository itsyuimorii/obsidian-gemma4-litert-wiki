import { normalizePath, TFile, Vault, type App } from 'obsidian';

// The wiki layer, per Karpathy's pattern: raw notes are never touched;
// the plugin owns a separate wiki/ folder holding generated pages, a
// content-oriented index.md the query path reads first, and an
// append-only log.md with grep-friendly prefixed entries.

// Wiki layer folder name is user-configurable (Settings). Held in one
// mutable module var; every path derives from it through a getter so a
// changed setting takes effect everywhere without re-import. The plugin
// calls setWikiDir() on load before any wiki operation runs.
export const DEFAULT_WIKI_DIR = 'gemma-wiki';
let _wikiDir = DEFAULT_WIKI_DIR;

export function setWikiDir(name: string): void {
  const clean = name.trim().replace(/^\/+|\/+$/g, '');
  _wikiDir = clean || DEFAULT_WIKI_DIR;
}

export function wikiDir(): string {
  return _wikiDir;
}
export function wikiSourcesDir(): string {
  return `${_wikiDir}/sources`;
}
export function wikiAnswersDir(): string {
  return `${_wikiDir}/answers`;
}
export function wikiChatsDir(): string {
  return `${_wikiDir}/chats`;
}
export function wikiConceptsDir(): string {
  return `${_wikiDir}/concepts`;
}
export function indexPath(): string {
  return `${_wikiDir}/index.md`;
}
export function logPath(): string {
  return `${_wikiDir}/log.md`;
}
export function schemaPath(): string {
  return `${_wikiDir}/schema.md`;
}

export interface NoteExtraction {
  summary: string;
  tags: string[];
  key_points: string[];
  // Model's own confidence that the extraction faithfully represents the
  // note — surfaces low-trust pages for review (Dataview-queryable).
  confidence: 'high' | 'med' | 'low';
}

export interface IndexEntry {
  linkPath: string;
  title: string;
  summary: string;
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'untitled'
  );
}

export function wikiPagePath(sourceBasename: string): string {
  return normalizePath(`${wikiSourcesDir()}/${slugify(sourceBasename)}.md`);
}

export function conceptPagePath(tag: string): string {
  return normalizePath(`${wikiConceptsDir()}/${slugify(tag)}.md`);
}

// A concept page (issue #19): a model-written overview of a tag cluster that
// links to its member pages. Frontmatter marks it as a concept so it never
// gets mistaken for an ingested source page.
export function buildConceptPage(
  tag: string,
  overview: string,
  members: { title: string; linkPath: string }[]
): string {
  const date = new Date().toISOString().slice(0, 10);
  const memberLines = members.map((m) => `- [[${m.linkPath}|${m.title}]]`).join('\n');
  return (
    `---\n` +
    `tags:\n  - concept\n  - ${slugify(tag)}\n` +
    `kind: concept\n` +
    `created: ${date}\n` +
    `---\n\n` +
    `# ${tag} (concept)\n\n` +
    `${overview.trim()}\n\n` +
    `## Pages\n\n` +
    `${memberLines}\n`
  );
}

export function buildWikiPage(
  sourceBasename: string,
  sourcePath: string,
  extraction: NoteExtraction,
  related: { title: string; linkPath: string }[] = [],
  sourceHash?: string
): string {
  const date = new Date().toISOString().slice(0, 10);
  const tagsYaml = extraction.tags.map((t) => `  - ${slugify(t)}`).join('\n');
  const points = extraction.key_points.map((p) => `- ${p}`).join('\n');
  const relatedSection = related.length
    ? `\n## Related\n\n${related.map((r) => `- [[${r.linkPath}|${r.title}]]`).join('\n')}\n`
    : '';
  return (
    `---\n` +
    `tags:\n${tagsYaml}\n` +
    `source: "${sourcePath}"\n` +
    (sourceHash ? `source_hash: ${sourceHash}\n` : '') +
    `created: ${date}\n` +
    `confidence: ${extraction.confidence}\n` +
    `---\n\n` +
    `# ${sourceBasename}\n\n` +
    `**Summary**: ${extraction.summary}\n\n` +
    `**Source**: [[${sourceBasename}]]\n\n` +
    `## Key points\n\n` +
    `${points}\n` +
    relatedSection
  );
}

async function readIfExists(vault: Vault, path: string): Promise<string | null> {
  const file = vault.getAbstractFileByPath(path);
  if (file instanceof TFile) return vault.read(file);
  return null;
}

async function writeFile(vault: Vault, path: string, content: string): Promise<void> {
  const existing = vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await vault.modify(existing, content);
  } else {
    await vault.create(path, content);
  }
}

export async function ensureWikiScaffold(vault: Vault): Promise<void> {
  for (const dir of [wikiDir(), wikiSourcesDir(), wikiAnswersDir(), wikiChatsDir(), wikiConceptsDir()]) {
    if (!vault.getAbstractFileByPath(normalizePath(dir))) {
      await vault.createFolder(normalizePath(dir)).catch(() => {});
    }
  }
  if (!vault.getAbstractFileByPath(indexPath())) {
    await vault.create(indexPath(), '# Wiki Index\n\nOne line per page: link, then a one-sentence summary.\n\n');
  }
  if (!vault.getAbstractFileByPath(logPath())) {
    await vault.create(logPath(), '# Wiki Log\n\nAppend-only timeline. One `- [date] action | title` line per operation.\n\n');
  }
}

export async function writeWikiPage(vault: Vault, pagePath: string, content: string): Promise<void> {
  await writeFile(vault, pagePath, content);
}

const INDEX_LINE = /^- \[\[([^\]|]+)\|([^\]]+)\]\] — (.+)$/;

export async function upsertIndexEntry(
  vault: Vault,
  pagePath: string,
  title: string,
  summary: string
): Promise<void> {
  const linkTarget = pagePath.replace(/\.md$/, '');
  const line = `- [[${linkTarget}|${title}]] — ${summary}`;
  const current = (await readIfExists(vault, indexPath())) ?? '# Wiki Index\n\n';
  const lines = current.split('\n');
  const existingIdx = lines.findIndex((l) => {
    const m = l.match(INDEX_LINE);
    return m?.[1] === linkTarget;
  });
  if (existingIdx >= 0) {
    lines[existingIdx] = line;
  } else {
    lines.push(line);
  }
  await writeFile(vault, indexPath(), lines.join('\n').replace(/\n{3,}/g, '\n\n'));
}

export async function appendLog(vault: Vault, action: string, title: string): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const current = (await readIfExists(vault, logPath())) ?? '# Wiki Log\n\n';
  await writeFile(vault, logPath(), `${current.trimEnd()}\n- [${date}] ${action} | ${title}\n`);
}

export async function readIndexEntries(vault: Vault): Promise<IndexEntry[]> {
  const content = await readIfExists(vault, indexPath());
  if (!content) return [];
  const entries: IndexEntry[] = [];
  for (const l of content.split('\n')) {
    const m = l.match(INDEX_LINE);
    if (m) entries.push({ linkPath: m[1], title: m[2], summary: m[3] });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Schema layer (issue #3), Karpathy's third layer — kept as a NOTE, not a
// hidden setting ("config as a note"): plain markdown the plugin parses before
// every ingest. Living as a note means it versions with the wiki, is visible
// and hand-editable, and shares the same "everything is a file you can read"
// philosophy as the rest of the wiki. Three parsed sections: Tags (controlled
// vocabulary), Naming (page-name rules), Concept threshold.
// ---------------------------------------------------------------------------

export interface WikiSchema {
  tags: string[];
  naming: Record<string, string>;
  conceptThreshold: number;
}

const DEFAULT_NAMING: Record<string, string> = {
  concept: 'kebab-case singular noun',
  source: "follows the source note's filename",
};
const DEFAULT_CONCEPT_THRESHOLD = 4;

// The self-documenting schema file. The prose header explains what this file
// is and how to use it, so opening it is enough to understand the config.
export function buildSchemaFile(
  tags: string[],
  naming: Record<string, string> = DEFAULT_NAMING,
  conceptThreshold = DEFAULT_CONCEPT_THRESHOLD
): string {
  const tagLines = tags.length ? tags.map((t) => `- ${slugify(t)}`).join('\n') : '- (run "Suggest tag vocabulary" to fill this)';
  const namingLines = Object.entries(naming)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return (
    `# Wiki Schema\n\n` +
    `This file is the wiki's own configuration — what Andrej Karpathy calls "config as a note".\n` +
    `It is plain markdown you can read and edit by hand, and the plugin parses it before every\n` +
    `ingest. Keeping the rules as a note (not a hidden setting) means they version with your wiki,\n` +
    `stay visible, and follow the same "everything is a file you can open" idea as the rest of the\n` +
    `wiki. Three sections:\n\n` +
    `- **Tags** — the controlled vocabulary. On ingest the model reuses these exact tags instead of\n` +
    `  inventing synonyms (\`llm-eval\` vs \`llm-evaluation\` vs \`evals\`), so pages that belong together\n` +
    `  share one tag and can later cluster into a concept page. You do NOT hand-write this — run the\n` +
    `  command **"Suggest tag vocabulary"** and the model proposes it from the tags already on your\n` +
    `  wiki; you review before it is written. One tag per line.\n` +
    `- **Naming** — how pages are named, so names stay consistent.\n` +
    `- **Concept threshold** — when this many pages share a tag, "Build a concept page" suggests it.\n\n` +
    `## Tags\n\n${tagLines}\n\n` +
    `## Naming\n\n${namingLines}\n\n` +
    `## Concept threshold\n\n${conceptThreshold}\n`
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
    .filter((l) => l.startsWith('- ') && !l.includes('(run "Suggest'))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);
  const naming: Record<string, string> = {};
  for (const l of schemaSection(content, 'Naming').split('\n')) {
    const m = l.match(/^([a-z][a-z0-9-]*)\s*:\s*(.+)$/i);
    if (m) naming[m[1].toLowerCase()] = m[2].trim();
  }
  const tm = schemaSection(content, 'Concept threshold').match(/\d+/);
  return {
    tags,
    naming: Object.keys(naming).length ? naming : DEFAULT_NAMING,
    conceptThreshold: tm ? parseInt(tm[0], 10) : DEFAULT_CONCEPT_THRESHOLD,
  };
}

export async function readSchema(vault: Vault): Promise<WikiSchema> {
  const content = await readIfExists(vault, schemaPath());
  if (!content) return { tags: [], naming: DEFAULT_NAMING, conceptThreshold: DEFAULT_CONCEPT_THRESHOLD };
  return parseSchema(content);
}

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

export async function loadPages(vault: Vault, entries: IndexEntry[], maxTotalChars: number): Promise<string> {
  let out = '';
  for (const e of entries) {
    const content = await readIfExists(vault, `${e.linkPath}.md`);
    if (!content) continue;
    const block = `### Page: ${e.title}\n${content}\n\n`;
    if (out.length + block.length > maxTotalChars) break;
    out += block;
  }
  return out;
}

export function answerPagePath(question: string): string {
  return normalizePath(`${wikiAnswersDir()}/${slugify(question).slice(0, 60)}.md`);
}

export function buildAnswerPage(
  question: string,
  answer: string,
  sources: { title: string; linkPath: string }[]
): string {
  const date = new Date().toISOString().slice(0, 10);
  const sourceLines = sources.map((s) => `- [[${s.linkPath}|${s.title}]]`).join('\n');
  return (
    `---\n` +
    `tags:\n  - answer\n` +
    `created: ${date}\n` +
    `---\n\n` +
    `# ${question}\n\n` +
    `${answer.trim()}\n\n` +
    `## Sources\n\n` +
    `${sourceLines}\n`
  );
}

// Which raw notes already have a wiki page: read the source frontmatter of
// every page under wiki/. Used for the file-explorer badge and the chat
// chip checkmark — the raw note itself is never marked or modified.
export function getIngestedSourcePaths(app: App): Set<string> {
  const ingested = new Set<string>();
  for (const f of app.vault.getMarkdownFiles()) {
    if (!f.path.startsWith(`${wikiDir()}/`)) continue;
    const src = app.metadataCache.getFileCache(f)?.frontmatter?.source;
    if (typeof src === 'string' && src.length) ingested.add(src);
  }
  return ingested;
}

// Last N log entries — lets Wiki chat answer meta-questions like "what
// did I add today?" from the append-only log instead of failing lexical
// retrieval against page content.
export async function readLogTail(vault: Vault, count: number): Promise<string> {
  const file = vault.getAbstractFileByPath(logPath());
  if (!(file instanceof TFile)) return '';
  const content = await vault.read(file);
  // Match the current '- [' list format and legacy '## [' headings so
  // logs written before the format change still parse.
  const entries = content.split('\n').filter((l) => l.startsWith('- [') || l.startsWith('## ['));
  return entries.slice(-count).join('\n');
}

// The engine context is a hard 4096 tokens. Char caps lied for CJK text
// (Chinese runs ~1+ token per character vs ~1 per 4 for English), which
// produced "Input token ids are too long" crashes. Estimate conservatively:
// CJK-range code points count as 1.4 tokens, everything else as 1 per 3.4
// chars.
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x2e80) cjk++;
  }
  return Math.ceil(cjk * 1.4 + (text.length - cjk) / 3.4);
}

// Trim text to fit a token budget (proportional cut, re-estimated), with a
// visible marker so the model knows the tail is missing.
export function clampToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (estimateTokens(text) <= maxTokens) return { text, truncated: false };
  let keep = text;
  for (let i = 0; i < 6 && estimateTokens(keep) > maxTokens; i++) {
    const ratio = maxTokens / estimateTokens(keep);
    keep = keep.slice(0, Math.max(200, Math.floor(keep.length * ratio * 0.97)));
  }
  return { text: keep + '\n\n[truncated to fit the local model context]', truncated: true };
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

// path -> source_hash for every ingested page. Companion to
// getIngestedSourcePaths; lets ingest and auto-scan tell new/changed from
// unchanged.
export function getIngestedSourceHashes(app: App): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of app.vault.getMarkdownFiles()) {
    if (!f.path.startsWith(`${wikiDir()}/`)) continue;
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    const src = fm?.source;
    const hash = fm?.source_hash;
    if (typeof src === 'string' && src.length && typeof hash === 'string') map.set(src, hash);
  }
  return map;
}

export type PrecheckSkip = 'empty' | 'frontmatter-only' | 'unchanged' | null;

// Deterministic pre-model gate: is this note worth spending a 20-40s model
// call on? Strips a leading YAML frontmatter block to test for
// "frontmatter-only", and compares content hash to the existing page's.
export function precheckNote(content: string, existingHash: string | undefined): PrecheckSkip {
  if (!content.trim()) return 'empty';
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
  if (!body.trim()) return 'frontmatter-only';
  if (existingHash && contentHash(content) === existingHash) return 'unchanged';
  return null;
}

export interface ChatTurnRecord {
  role: 'user' | 'assistant';
  content: string;
  sources?: { title: string; linkPath: string }[];
}

export function chatTranscriptPath(firstQuestion: string, stamp: string): string {
  return normalizePath(`${wikiChatsDir()}/${stamp}-${slugify(firstQuestion).slice(0, 40)}.md`);
}

// Render a chat thread as a vault-native markdown file: frontmatter for
// Dataview/Query reuse, then Q/A blocks with the deterministic sources.
export function buildChatTranscript(turns: ChatTurnRecord[], mode: string, date: string): string {
  const title = turns.find((t) => t.role === 'user')?.content.slice(0, 80) ?? 'Chat';
  let body = `---\ntags:\n  - chat\nmode: ${mode}\ncreated: ${date}\n---\n\n# ${title}\n\n`;
  for (const t of turns) {
    if (t.role === 'user') {
      // Blockquote, not a heading — H2 per question rendered huge and
      // cluttered the outline. Quote reads as "the question asked".
      const quoted = t.content
        .trim()
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
      body += `${quoted}\n\n`;
    } else {
      body += `${t.content.trim()}\n\n`;
      if (t.sources?.length) {
        body += `*Sources: ${t.sources.map((sc) => `[[${sc.linkPath}|${sc.title}]]`).join(', ')}*\n\n`;
      }
      body += `---\n\n`;
    }
  }
  return body.trimEnd() + '\n';
}

// Strip boilerplate from web-clipped notes before ingest. Local models
// have only 4096 tokens of context, and a clipped article carries a lot
// of navigation/footer noise that crowds out the real content. This is a
// conservative, markdown-only cleaner — it removes structural chrome, not
// prose, so a hand-written note passes through essentially untouched.
export function cleanClippedMarkdown(md: string): string {
  const lines = md.split('\n');
  const kept: string[] = [];
  // Phrases that mark a boilerplate line outright (case-insensitive).
  const junkLine =
    /^(subscribe|sign up|sign in|log in|share this|follow us|advertisement|cookie|accept all|related posts?|read more|newsletter|©|all rights reserved|privacy policy|terms of service)\b/i;
  let consecutiveLinkOnly = 0;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();

    if (junkLine.test(trimmed)) continue;

    // A line that is nothing but a markdown link (nav/menu item), possibly
    // a bullet of one. Drop runs of these (menus, link lists) but keep a
    // lone inline link inside prose.
    const linkOnly = /^[-*]?\s*\[[^\]]*\]\([^)]*\)\s*$/.test(trimmed);
    if (linkOnly) {
      consecutiveLinkOnly++;
      // Only start dropping once several stack up — that's a menu, not a
      // meaningful single reference.
      if (consecutiveLinkOnly >= 2) continue;
      // Hold the first one back until we know if a run follows.
      kept.push(line);
      continue;
    }
    if (consecutiveLinkOnly === 1 && kept.length && /^[-*]?\s*\[[^\]]*\]\([^)]*\)\s*$/.test(kept[kept.length - 1].trim())) {
      // The single held link was standalone in prose — fine, leave it.
    }
    consecutiveLinkOnly = 0;

    // Image-only lines: keep the alt text as a caption, drop the URL noise.
    const imgOnly = trimmed.match(/^!\[([^\]]*)\]\([^)]*\)\s*$/);
    if (imgOnly) {
      if (imgOnly[1]) kept.push(`[image: ${imgOnly[1]}]`);
      continue;
    }

    kept.push(line);
  }
  // Collapse 3+ blank lines to a single blank.
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
