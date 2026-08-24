import { normalizePath, TFile, Vault, type App } from 'obsidian';

// The wiki layer, per Karpathy's pattern: raw notes are never touched;
// the plugin owns a separate wiki/ folder holding generated pages, a
// content-oriented index.md the query path reads first, and an
// append-only log.md with grep-friendly prefixed entries.

export const WIKI_DIR = 'wiki';
export const WIKI_SOURCES_DIR = `${WIKI_DIR}/sources`;
export const WIKI_ANSWERS_DIR = `${WIKI_DIR}/answers`;
export const INDEX_PATH = `${WIKI_DIR}/index.md`;
export const LOG_PATH = `${WIKI_DIR}/log.md`;

export interface NoteExtraction {
  summary: string;
  tags: string[];
  key_points: string[];
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
  return normalizePath(`${WIKI_SOURCES_DIR}/${slugify(sourceBasename)}.md`);
}

export function buildWikiPage(
  sourceBasename: string,
  sourcePath: string,
  extraction: NoteExtraction,
  related: { title: string; linkPath: string }[] = []
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
    `created: ${date}\n` +
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
  for (const dir of [WIKI_DIR, WIKI_SOURCES_DIR, WIKI_ANSWERS_DIR]) {
    if (!vault.getAbstractFileByPath(normalizePath(dir))) {
      await vault.createFolder(normalizePath(dir)).catch(() => {});
    }
  }
  if (!vault.getAbstractFileByPath(INDEX_PATH)) {
    await vault.create(INDEX_PATH, '# Wiki Index\n\nOne line per page: link, then a one-sentence summary.\n\n');
  }
  if (!vault.getAbstractFileByPath(LOG_PATH)) {
    await vault.create(LOG_PATH, '# Wiki Log\n\nAppend-only. One `## [date] action | title` entry per operation.\n\n');
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
  const current = (await readIfExists(vault, INDEX_PATH)) ?? '# Wiki Index\n\n';
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
  await writeFile(vault, INDEX_PATH, lines.join('\n').replace(/\n{3,}/g, '\n\n'));
}

export async function appendLog(vault: Vault, action: string, title: string): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const current = (await readIfExists(vault, LOG_PATH)) ?? '# Wiki Log\n\n';
  await writeFile(vault, LOG_PATH, `${current.trimEnd()}\n## [${date}] ${action} | ${title}\n`);
}

export async function readIndexEntries(vault: Vault): Promise<IndexEntry[]> {
  const content = await readIfExists(vault, INDEX_PATH);
  if (!content) return [];
  const entries: IndexEntry[] = [];
  for (const l of content.split('\n')) {
    const m = l.match(INDEX_LINE);
    if (m) entries.push({ linkPath: m[1], title: m[2], summary: m[3] });
  }
  return entries;
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

export function scoreEntries(question: string, entries: IndexEntry[]): IndexEntry[] {
  const terms = question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
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
  return normalizePath(`${WIKI_ANSWERS_DIR}/${slugify(question).slice(0, 60)}.md`);
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
    if (!f.path.startsWith(`${WIKI_DIR}/`)) continue;
    const src = app.metadataCache.getFileCache(f)?.frontmatter?.source;
    if (typeof src === 'string' && src.length) ingested.add(src);
  }
  return ingested;
}

// Last N log entries — lets Wiki chat answer meta-questions like "what
// did I add today?" from the append-only log instead of failing lexical
// retrieval against page content.
export async function readLogTail(vault: Vault, count: number): Promise<string> {
  const file = vault.getAbstractFileByPath(LOG_PATH);
  if (!(file instanceof TFile)) return '';
  const content = await vault.read(file);
  const entries = content.split('\n').filter((l) => l.startsWith('## ['));
  return entries.slice(-count).join('\n');
}
