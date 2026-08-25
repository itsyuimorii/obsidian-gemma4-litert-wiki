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
export function wikiSkillsDir(): string {
  return `${_wikiDir}/skills`;
}

export interface NoteExtraction {
  summary: string;
  tags: string[];
  key_points: string[];
  // Model's own confidence that the extraction faithfully represents the
  // note — surfaces low-trust pages for review (Dataview-queryable).
  confidence: 'high' | 'med' | 'low';
  // Salient named entities / concepts the note refers to (issue #18). Stored
  // in frontmatter so later features can cluster pages by shared mention.
  mentions: string[];
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
  const mentions = extraction.mentions ?? [];
  const mentionsYaml = mentions.length
    ? `mentions:\n${mentions.map((m) => `  - "${m.replace(/"/g, '')}"`).join('\n')}\n`
    : '';
  const relatedSection = related.length
    ? `\n## Related\n\n${related.map((r) => `- [[${r.linkPath}|${r.title}]]`).join('\n')}\n`
    : '';
  return (
    `---\n` +
    `tags:\n${tagsYaml}\n` +
    `source: "${sourcePath}"\n` +
    (sourceHash ? `source_hash: ${sourceHash}\n` : '') +
    mentionsYaml +
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

const INDEX_HEADER =
  `# Wiki Index\n\n` +
  `> [!info]- What this file is\n` +
  `> The wiki's directory: one line per page — a link, then a one-sentence summary.\n` +
  `> The plugin maintains it. Wiki-mode chat reads this file FIRST to decide which pages to open,\n` +
  `> which is why summaries live here and not just on the pages.\n` +
  `> It repairs itself: entries for pages you delete are dropped automatically (and you can force a\n` +
  `> pass with **Reconcile wiki**). Safe to read; you should not need to hand-edit it.\n\n`;

const LOG_HEADER =
  `# Wiki Log\n\n` +
  `> [!info]- What this file is\n` +
  `> An append-only timeline of what the plugin did, one \`- [date] action | title\` line per\n` +
  `> operation (\`ingest\`, \`concept\`, \`relink\`, \`schema\`). Nothing here is read back — it exists so\n` +
  `> you can check what happened and when, and it greps cleanly by action.\n\n`;

export async function ensureWikiScaffold(vault: Vault): Promise<void> {
  for (const dir of [wikiDir(), wikiSourcesDir(), wikiAnswersDir(), wikiChatsDir(), wikiConceptsDir()]) {
    if (!vault.getAbstractFileByPath(normalizePath(dir))) {
      await vault.createFolder(normalizePath(dir)).catch(() => {});
    }
  }
  // Both files carry a collapsed self-explanation (#50), same pattern as
  // schema.md: the generated parts of the wiki should say what they are where
  // you open them. Callout lines start with "> " and the entry parsers read
  // only "- [[...]]" lines, so the header can never be read as data.
  if (!vault.getAbstractFileByPath(indexPath())) {
    await vault.create(indexPath(), INDEX_HEADER);
  }
  if (!vault.getAbstractFileByPath(logPath())) {
    await vault.create(logPath(), LOG_HEADER);
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
  const current = (await readIfExists(vault, indexPath())) ?? INDEX_HEADER;
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
  const current = (await readIfExists(vault, logPath())) ?? LOG_HEADER;
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
  // New tags ingest has seen that aren't in the vocabulary yet, waiting for
  // you to promote them (issue #3). The vocabulary stays curated; nothing
  // enters it silently.
  pending: string[];
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
  conceptThreshold = DEFAULT_CONCEPT_THRESHOLD,
  pending: string[] = []
): string {
  const tagLines = tags.length
    ? tags.map((t) => `- ${slugify(t)}`).join('\n')
    : '_No tags yet. Ingest a few notes, then run "Organize tags" to build the vocabulary from them._';
  const namingLines = Object.entries(naming)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const pendingLines = pending.length
    ? pending.map((t) => `- ${slugify(t)}`).join('\n')
    : '(none)';
  // Every section carries its own collapsed callout (issues #43, #50) so the
  // rules explain themselves where you are looking, instead of in a preamble
  // you scroll past. These MUST be emitted here rather than hand-added:
  // queuePendingTags and Organize tags regenerate the whole file, so anything
  // written by hand outside the parsed values is lost on the next ingest.
  //
  // Parser-safe by construction: every callout line starts with "> ". The Tags
  // and Pending parsers read only "- " lines, Naming matches "key: value" at
  // line start, and the threshold parser strips "> " lines before looking for
  // its number — so no callout text can be mistaken for a value.
  return (
    `# Wiki Schema\n\n` +
    `This file is the wiki's own configuration — what Andrej Karpathy calls "config as a note".\n` +
    `It is plain markdown you can read and edit by hand, and the plugin parses it before every\n` +
    `ingest. Keeping the rules as a note (not a hidden setting) means they version with your wiki,\n` +
    `stay visible, and follow the same "everything is a file you can open" idea as the rest of the\n` +
    `wiki. Each section below explains itself — click a ▸ to expand it.\n\n` +
    `## Tags\n\n` +
    `> [!tip]- What this is\n` +
    `> Your controlled vocabulary. On ingest the model reuses these exact tags instead of coining\n` +
    `> synonyms (\`llm-eval\` vs \`llm-evaluation\` vs \`evals\`), so pages that belong together share one\n` +
    `> tag — and can then reach the concept-page threshold below.\n` +
    `> You do **not** hand-write this list: run **Organize tags** (settings, or the command palette)\n` +
    `> and the model builds it from the tags your ingested notes already produced. You review the\n` +
    `> result before anything is written. One tag per line.\n` +
    `> Editing it affects **future** ingests only — it never re-runs or edits pages you already have.\n\n` +
    `${tagLines}\n\n` +
    `## Naming\n\n` +
    `> [!tip]- What this does\n` +
    `> The \`concept:\` line is fed into the tag-naming prompt, so editing it changes how new tags are\n` +
    `> named (e.g. asking for a singular noun). It is guidance, not a guarantee — the local model is\n` +
    `> small, so treat it as a nudge.\n` +
    `> File and page names are lower-case and hyphenated no matter what this says: that part is done\n` +
    `> mechanically, not by the model.\n\n` +
    `${namingLines}\n\n` +
    `## Concept threshold\n\n` +
    `> [!tip]- What this does\n` +
    `> When this many pages share a tag — or share a mention — **Build a concept page** offers that\n` +
    `> cluster as a candidate. Raise it to be shown only well-established clusters, lower it to see\n` +
    `> thin ones. Leave the value blank and it falls back to ${DEFAULT_CONCEPT_THRESHOLD}.\n\n` +
    `${conceptThreshold}\n\n` +
    `## Pending\n\n` +
    `> [!tip]- How to clear these\n` +
    `> New tags ingest used that aren't in your vocabulary yet. Ingest also reads this list, so a tag\n` +
    `> waiting here already helps later notes reuse it instead of coining a near-duplicate.\n` +
    `> Two ways to clear them, and **both are your approval**:\n` +
    `> - **By hand** (retail) — cut a line up into \`## Tags\` to keep it; delete the line to reject it.\n` +
    `>   Precise, good for a few tags.\n` +
    `> - **Organize tags** (wholesale) — rebuilds the vocabulary from the tags currently in use, merges\n` +
    `>   near-synonyms, and clears this list. You approve the result in a preview first.\n` +
    `> "The vocabulary never changes on its own" means exactly that: no action of yours — a hand-edit,\n` +
    `> or the command plus **Approve** — no change. Approving the preview *is* your approval, just\n` +
    `> wholesale instead of retail.\n` +
    `> Either way it takes effect for **future** ingests; pages you already have are never touched.\n\n` +
    `${pendingLines}\n`
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
  return {
    tags,
    naming: Object.keys(naming).length ? naming : DEFAULT_NAMING,
    conceptThreshold: tm ? parseInt(tm[0], 10) : DEFAULT_CONCEPT_THRESHOLD,
    pending,
  };
}

export async function readSchema(vault: Vault): Promise<WikiSchema> {
  const content = await readIfExists(vault, schemaPath());
  if (!content) return { tags: [], naming: DEFAULT_NAMING, conceptThreshold: DEFAULT_CONCEPT_THRESHOLD, pending: [] };
  return parseSchema(content);
}

// After an approved ingest, queue any tags that aren't in the vocabulary into
// the schema's Pending section — so the vocabulary stays curated and new tags
// wait for your approval instead of entering it silently. No-op if there is no
// schema.md yet (nothing to govern against).
// Returns the Pending count before and after, so the caller can notice when
// the queue has grown past the point where it is worth folding in (#47) —
// without nagging on every ingest.
export async function queuePendingTags(
  vault: Vault,
  tags: string[]
): Promise<{ before: number; after: number }> {
  const content = await readIfExists(vault, schemaPath());
  if (!content) return { before: 0, after: 0 };
  const schema = parseSchema(content);
  const before = schema.pending.length;
  const known = new Set([...schema.tags, ...schema.pending].map((t) => slugify(t)));
  const fresh = tags.map((t) => slugify(t)).filter((t) => t && !known.has(t));
  if (!fresh.length) return { before, after: before };
  const pending = [...schema.pending, ...fresh];
  const next = buildSchemaFile(schema.tags, schema.naming, schema.conceptThreshold, pending);
  await writeFile(vault, schemaPath(), next);
  return { before, after: pending.length };
}

// ---------------------------------------------------------------------------
// Skills (issue #4) — "config as a note" applied to custom prompts.
//
// A skill is one file in <wiki>/skills/: frontmatter for how it shows up in
// the ⚡ menu, the body is the prompt. Like the schema, the rules live as
// editable notes that version with the wiki, not as a hidden settings string.
// Each skill is still ONE structured ask against the current chat context —
// no tool loop — which is the whole "wiki as input for repeat work" pattern.
// ---------------------------------------------------------------------------

export interface WikiSkill {
  label: string;
  icon: string;
  prompt: string;
  mode?: 'note' | 'wiki';
}

// A skill file is `key: value` frontmatter between --- fences, then the prompt
// as the body. We parse only the handful of keys we use and treat everything
// after the closing fence as the prompt, so a user can write the prompt as
// ordinary markdown (lists, bold) without escaping anything.
function parseSkillFile(name: string, content: string): WikiSkill | null {
  const fm = content.match(/^---\n([\s\S]*?)\n---\n?/);
  const front: Record<string, string> = {};
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      front[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
  }
  const prompt = content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  if (!prompt) return null;
  const mode = front.mode === 'wiki' ? 'wiki' : front.mode === 'note' ? 'note' : undefined;
  return {
    label: front.name || front.label || name,
    icon: front.icon || 'wand-2',
    prompt,
    mode,
  };
}

// Read every skill file in <wiki>/skills/, sorted by filename so the menu
// order is stable and the user can control it by renaming. Missing folder =
// no custom skills (the built-ins still show).
export async function readSkills(vault: Vault): Promise<WikiSkill[]> {
  const folder = vault.getAbstractFileByPath(normalizePath(wikiSkillsDir()));
  if (!folder) return [];
  const skills: WikiSkill[] = [];
  const files = vault
    .getMarkdownFiles()
    .filter((f) => f.path.startsWith(`${wikiSkillsDir()}/`) && f.basename.toLowerCase() !== 'readme')
    .sort((a, b) => a.path.localeCompare(b.path));
  for (const f of files) {
    const skill = parseSkillFile(f.basename, await vault.read(f));
    if (skill) skills.push(skill);
  }
  return skills;
}

function buildSkillFile(name: string, icon: string, mode: 'note' | 'wiki' | undefined, prompt: string): string {
  const modeLine = mode ? `mode: ${mode}\n` : '';
  return `---\nname: ${name}\nicon: ${icon}\n${modeLine}---\n\n${prompt}\n`;
}

const SKILLS_README =
  `# Skills\n\n` +
  `Each \`.md\` file in this folder is a custom skill — a one-shot prompt that shows up in\n` +
  `the ⚡ menu of the chat panel. This is the same "config as a note" idea as \`schema.md\`:\n` +
  `the rules live as plain notes you can read, edit, and version, not as a hidden setting.\n\n` +
  `A skill file is frontmatter + a prompt body:\n\n` +
  `\`\`\`\n---\nname: ELI5\nicon: wand-2\nmode: note\n---\n\nExplain this material like I am five.\n\`\`\`\n\n` +
  `- **name** — what shows in the menu (defaults to the filename).\n` +
  `- **icon** — any Obsidian (Lucide) icon name; defaults to \`wand-2\`.\n` +
  `- **mode** — optional, \`note\` or \`wiki\`. If set, running the skill switches the chat to\n` +
  `  that grounding first (use \`wiki\` for skills that need the catalog or activity log).\n` +
  `- **body** — everything after the closing \`---\` is the prompt, written as ordinary markdown.\n\n` +
  `Each skill is one structured ask against the current chat context (mode + attachments) —\n` +
  `not a multi-step agent. Add a file, and it appears in the menu; delete it, and it is gone.\n` +
  `Files named \`README\` (this one) are ignored.\n`;

// Seed the skills folder with a README and two example skills, the first time
// the user asks for it. Never overwrites an existing file, so re-running is safe.
export async function ensureSkillsScaffold(vault: Vault): Promise<void> {
  const dir = normalizePath(wikiSkillsDir());
  if (!vault.getAbstractFileByPath(dir)) {
    await vault.createFolder(dir).catch(() => {});
  }
  const seeds: Array<[string, string]> = [
    [`${wikiSkillsDir()}/README.md`, SKILLS_README],
    [
      `${wikiSkillsDir()}/eli5.md`,
      buildSkillFile('ELI5', 'baby', 'note', 'Explain this material like I am five, in plain language and short sentences.'),
    ],
    [
      `${wikiSkillsDir()}/action-items.md`,
      buildSkillFile('Action items', 'list-checks', 'note', 'List the concrete next actions this material implies, as a checklist. One action per line, each starting with a verb.'),
    ],
  ];
  for (const [path, content] of seeds) {
    if (!vault.getAbstractFileByPath(normalizePath(path))) {
      await vault.create(normalizePath(path), content).catch(() => {});
    }
  }
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

// One-hop link expansion (issue #14): given the seed pages the lexical
// scorer picked, pull in the wiki pages they link to and the pages that link
// to them. A wiki-link neighbour is often the page that actually holds the
// answer even when its own summary didn't share the question's words —
// lexical retrieval alone can't see that, the link graph can.
export function expandByLinks(
  app: App,
  seeds: IndexEntry[],
  allEntries: IndexEntry[],
  maxExtra: number
): IndexEntry[] {
  if (!seeds.length || maxExtra <= 0) return [];
  const byPath = new Map(allEntries.map((e) => [`${e.linkPath}.md`, e]));
  const seedPaths = new Set(seeds.map((e) => `${e.linkPath}.md`));
  const prefix = `${wikiDir()}/`;
  const resolved = app.metadataCache.resolvedLinks;
  const neighbours = new Set<string>();

  // Outbound: seed -> targets.
  for (const seedPath of seedPaths) {
    for (const tgt of Object.keys(resolved[seedPath] ?? {})) {
      if (byPath.has(tgt) && !seedPaths.has(tgt)) neighbours.add(tgt);
    }
  }
  // Inbound: any wiki page -> a seed (backlinks).
  for (const [src, targets] of Object.entries(resolved)) {
    if (!src.startsWith(prefix) || !byPath.has(src) || seedPaths.has(src)) continue;
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
