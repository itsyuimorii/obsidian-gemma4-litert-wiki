import { normalizePath, TFile, Vault, type App } from 'obsidian';

// The wiki layer, per Karpathy's pattern: raw notes are never touched;
// the plugin owns a separate wiki/ folder holding generated pages, a
// content-oriented index.md the query path reads first, and an
// append-only log.md with grep-friendly prefixed entries.

// Wiki layer folder name is user-configurable (Settings). Held in one
// mutable module var; every path derives from it through a getter so a
// changed setting takes effect everywhere without re-import. The plugin
// calls setWikiDir() on load before any wiki operation runs.
// No emoji in the default name. It was tried: it does make the folder easy to
// spot, but it lands in every page path and every wikilink
// ("[[📚 gemma-wiki/sources/foo|foo]]"), and the glyph renders a size larger
// than the surrounding text in the file explorer, which no amount of CSS on
// our side can fix. Discoverability is handled where it belongs instead — the
// folder is revealed and highlighted on first run, and the ribbon icon says
// what it opens.
export const DEFAULT_WIKI_DIR = 'gemma-wiki';
let _wikiDir = DEFAULT_WIKI_DIR;

export function setWikiDir(name: string): void {
  const clean = name.trim().replace(/^\/+|\/+$/g, '');
  _wikiDir = clean || DEFAULT_WIKI_DIR;
}

export function wikiDir(): string {
  return _wikiDir;
}
// Named cards/, and renamed FROM sources/ deliberately. The folder holds
// model-generated summary cards, and calling that folder "sources" gave the
// word two opposite meanings at once: Karpathy's sources are the immutable
// raw notes, and this folder is precisely the layer derived from them. Even
// the author kept tripping over it. A card also HAS a `source:` line in its
// frontmatter — pointing at the raw note — which finally reads correctly now.
export function wikiSourcesDir(): string {
  return `${_wikiDir}/cards`;
}
// Kept only so the upgrade notice can find leftovers from before answers
// moved into the user's own vault. NOT in the scaffold and NOT created.
export function wikiAnswersDir(): string {
  return `${_wikiDir}/answers`;
}
// Kept for the same reason as wikiAnswersDir: finding what an older version
// left behind. Nothing writes here any more.
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
 * Where a note's card lives.
 *
 * This used to be `slugify(file.basename)` and nothing else, which made the
 * filename the note's identity. Obsidian vaults are full of same-named files in
 * different folders — a README per project, a date per daily folder, an
 * index.md wherever — and every such pair mapped to one card. The second ingest
 * overwrote the first, which then lost its card, which made it a new candidate
 * again on the next scan, which overwrote the second. Two notes could bounce
 * off each other forever, and nothing said so.
 *
 * Identity now comes from the note, not from its name. A card records its
 * source in frontmatter, so the card a note already has can be found by
 * reading it — which also means existing vaults keep every card they have
 * rather than re-drafting the lot under new names.
 *
 * Only when a note has no card yet is a name minted, and then the plain
 * basename is still tried first: `cards/readme.md` is what you want to see
 * until the day two notes want it.
 *
 * `reserved` holds paths minted earlier in the same batch. A scan drafts
 * before it writes, so two new same-named notes would otherwise both find the
 * name free and the second would silently replace the first between the review
 * list and the disk.
 */
export function cardPathFor(app: App, file: TFile, reserved?: Set<string>): string {
  const existing = existingCardPath(app, file.path);
  if (existing) return existing;

  const dir = wikiSourcesDir();
  const parent = file.parent?.name ?? '';
  const stem = file.path.replace(/\.md$/, '');
  // Widening: the name alone, then qualified by its folder, then by the whole
  // path, then counted. Every step is derived from the note, so the answer is
  // the same on every call for the same note.
  const candidates = [
    slugify(file.basename),
    parent ? `${slugify(parent)}-${slugify(file.basename)}` : '',
    slugify(stem),
  ].filter(Boolean);
  for (let n = 2; n <= 99; n++) candidates.push(`${slugify(file.basename)}-${n}`);

  for (const c of candidates) {
    const path = normalizePath(`${dir}/${c}.md`);
    if (reserved?.has(path)) continue;
    const taken = app.vault.getAbstractFileByPath(path);
    if (!taken) {
      reserved?.add(path);
      return path;
    }
  }
  // 99 notes sharing a basename and a folder is not a real vault, but returning
  // undefined here would be worse than one deterministic collision.
  return normalizePath(`${dir}/${slugify(file.path)}.md`);
}

/** The card this note already has, by its recorded source. Null if none. */
export function existingCardPath(app: App, notePath: string): string | null {
  const prefix = `${wikiSourcesDir()}/`;
  for (const f of app.vault.getMarkdownFiles()) {
    if (!f.path.startsWith(prefix)) continue;
    if (app.metadataCache.getFileCache(f)?.frontmatter?.source === notePath) return f.path;
  }
  return null;
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
  // Every tag can be filtered away (e.g. all rejected) — omit the block then.
  const pageTags = extraction.tags.filter(isUsableTag).map((t) => slugify(t));
  const tagsYaml = pageTags.length ? `tags:\n${pageTags.map((t) => `  - ${t}`).join('\n')}\n` : '';
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
    tagsYaml +
    `source: "${sourcePath}"\n` +
    (sourceHash ? `source_hash: ${sourceHash}\n` : '') +
    mentionsYaml +
    `created: ${date}\n` +
    `confidence: ${extraction.confidence}\n` +
    `---\n\n` +
    `# ${sourceBasename}\n\n` +
    // The line that has to be where the mistake would be made. A card is build
    // output: the next ingest regenerates it, so anything you fix here is
    // thrown away silently. Saying it in the folder README is saying it where
    // nobody is standing when they decide to edit.
    `> [!info]- Generated card — edit the note, not this\n` +
    `> This is a summary of [[${sourceBasename}]], rebuilt from it each time you ingest.\n` +
    `> **Changes made here are replaced on the next ingest.** To correct something, edit the note; the review board will flag this card as drifted and offer to rebuild it.\n\n` +
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

// Lucide glyphs as inline SVG, for the generated notes. Obsidian renders inline
// HTML in reading view, so "click <icon>" can show the actual button instead of
// naming it. Written so the sentence still reads correctly if a future
// sanitiser strips the tag — the icon is an aid, never the only signal.
const ICON_SVG = (paths: string, box = '0 0 24 24'): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="${box}" fill="none" ` +
  `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ` +
  `style="vertical-align:-3px">${paths}</svg>`;

// The plugin's own ribbon icon, so a note can say "click this" and show the
// actual button rather than describing it. Same paths as addIcon() in main.ts;
// if that mark changes, this has to change with it.
const ICON_BRAND = ICON_SVG(
  '<path d="M20.8 12.5 H79.2 a4 4 0 0 1 4 4 V83.3 a4 4 0 0 1 -4 4 H20.8 a8.3 8.3 0 0 1 -8.3 -8.3 ' +
    'V20.8 a8.3 8.3 0 0 1 8.3 -8.3 Z"/>' +
    '<path d="M29.2 12.5 V87.5"/>' +
    '<path d="M58 33 l5.27 11.73 11.73 5.27 -11.73 5.27 -5.27 11.73 -5.27 -11.73 -11.73 -5.27 ' +
    '11.73 -5.27 Z" fill="currentColor" stroke="none"/>',
  '0 0 100 100'
);

const ICON_SAVE_TO_WIKI = ICON_SVG(
  '<path d="M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>' +
    '<path d="M3 15h6"/><path d="M6 12v6"/>'
);

const ICON_SAVE_DISK = ICON_SVG(
  '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/>' +
    '<path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>'
);

const ICON_ZAP = ICON_SVG(
  '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 ' +
    '.78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>'
);

// The rest of the chat panel's controls, so the README can name a button by
// drawing it. Same Lucide glyphs the panel itself asks Obsidian for.
const ICON_ATTACH = ICON_SVG('<path d="M5 12h14"/><path d="M12 5v14"/>');

const ICON_COPY = ICON_SVG(
  '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>' +
    '<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'
);

const ICON_REGEN = ICON_SVG(
  '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>' +
    '<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>'
);

const ICON_TRASH = ICON_SVG(
  '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>' +
    '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'
);

// Expanded, not a collapsed toggle. This is the first file a new user opens,
// and "> [!info]-" hides its own contents behind a click nobody knows to make —
// the explanation was there and invisible. Entries are appended to the end of
// the file, so everything here has to sit above "## Pages".
// index.md is an index. The layout tables and the how-it-works notes used to
// live here and pushed the entries — the reason anyone opens the file — three
// screens down. They now live in the folder's README, where explanation is the
// point rather than the obstacle.
const INDEX_HEADER =
  `# Wiki Index\n\n` +
  `One line per page: a link, then a one-sentence summary. **Wiki-mode chat reads this file first** to decide which pages to open. It repairs itself — entries for deleted pages are dropped automatically — so you should not need to hand-edit it.\n\n` +
  `> [!info]- What this folder is\n` +
  // Full path, not [[README]]: six files now share that basename (this folder
  // and each of the five below it), and Obsidian resolved the bare link to
  // whichever it liked.
  `> Everything the plugin writes lives here; your own notes are never modified by the plugin — they are yours to edit, and the wiki catches up. Full layout and rules: [[${_wikiDir}/README|${_wikiDir}/README]].\n\n` +
  `## Pages\n\n`;

const LOG_HEADER =
  `# Wiki Log\n\n` +
  `**Append-only record of what the plugin did**, one \`- [date] action | title\` line per operation, so it greps cleanly by action. Nothing here is ever read back.\n\n` +
  `> [!info]- Actions you will see\n` +
  `> \`ingest\` a note became a page · \`improve\` a raw note was reformatted after you approved it · \`concept\` a concept page was built · \`relink\` Related sections were re-synced · \`schema\` the tag vocabulary was rewritten\n`;

// Every folder and file the plugin owns, in display order. Exported so the
// settings page can show the layout and the repair button can report what was
// missing, without keeping a second copy of the list that drifts.
// One definition of "a page in the wiki", because there were ten copies of it
// and they disagreed. index/log/schema are the wiki's own machinery, and every
// README is documentation for the folder it sits in — none of them is a page,
// so none of them should ever appear in lint, the review board, retag, relink
// or the contradiction sweep.
/**
 * The four folders whose files are pages: things that go in `index.md` and
 * that lint, the review board, retagging and concept clustering all iterate.
 *
 * An allow-list, not a deny-list. It used to be "anything under the wiki
 * folder except index, log, schema and READMEs", which quietly counted every
 * file in `skills/` as a page — lint reported each one as an orphan, and the
 * review board offered to refresh a prompt for going stale. A deny-list is
 * also wrong for every folder added later, which would each have to remember
 * to exclude themselves.
 */
function pageDirs(): string[] {
  // Two folders, and both are generated from notes you wrote. There is no
  // third pile to rank below them: an answer you keep is written into your own
  // vault now, where it is an ordinary note, and the only route by which one
  // becomes material is the same scan every other note goes through.
  //
  // That is the whole rule, and it holds structurally rather than by
  // remembering to exclude things: everything retrievable derives from a note
  // you wrote.
  return [wikiSourcesDir(), wikiConceptsDir()];
}

export function isWikiPage(file: { path: string; basename: string }): boolean {
  if (file.basename.toLowerCase() === 'readme') return false;
  return pageDirs().some((dir) => file.path.startsWith(`${dir}/`));
}

export function wikiScaffoldPaths(): { path: string; what: string }[] {
  return [
    { path: `${_wikiDir}/README.md`, what: 'What this folder is, and the rules' },
    { path: `${wikiSourcesDir()}/`, what: 'One summary card per ingested note' },
    { path: `${wikiConceptsDir()}/`, what: 'Pages built across a shared tag' },
    { path: `${wikiSkillsDir()}/`, what: 'One file per ⚡ menu entry' },
    { path: `${wikiChatsDir()}/`, what: 'Conversations you chose to keep' },
    { path: indexPath(), what: 'Catalog — wiki chat reads this first' },
    { path: logPath(), what: 'Append-only record of what ran' },
    { path: schemaPath(), what: 'Tag vocabulary, naming rules, rejected tags' },
  ];
}



// A README per folder, in the same shape as index.md: a bold opening line, then
// expanded "> [!info]" blocks, with a table wherever there is something to
// tabulate. Two rules learned the hard way — never "[!info]-", which collapses
// the explanation behind a click nobody knows to make, and never wrap a
// paragraph across source lines, which Obsidian renders as hard breaks.
//
// Excluded from every page enumeration by isWikiPage(), so documenting a folder
// never costs you a phantom wiki page in lint or the review board.
const SKILLS_README =
  `# skills\n\n` +
  `**Each \`.md\` file in this folder is a custom skill** — a one-shot prompt that appears in the ⚡ menu of the chat panel. Add a file, get a menu item; delete it, and it is gone. Same "config as a note" idea as \`schema.md\`: the rules live as plain notes you can read, edit and version, not as a hidden setting.\n\n` +
  `> [!info] The file format\n` +
  `> Frontmatter, then the prompt as ordinary markdown:\n` +
  `>\n` +
  `> \`\`\`\n` +
  `> ---\n` +
  `> name: Counter-argument\n` +
  `> icon: scale\n` +
  `> mode: note\n` +
  `> ---\n` +
  `>\n` +
  `> Argue the strongest case against what this note claims.\n` +
  `> \`\`\`\n` +
  `>\n` +
  `> | Key | Meaning |\n` +
  `> |---|---|\n` +
  `> | \`name\` | What shows in the menu. Defaults to the filename. |\n` +
  `> | \`icon\` | Any Obsidian (Lucide) icon name. Defaults to \`wand-2\`. |\n` +
  `> | \`mode\` | Optional, \`note\` or \`wiki\`. If set, the skill is **shown greyed unless the panel is already in that mode** — it will not switch you into it, because a menu item should not quietly change what the panel is grounded in. Leave it out and the skill runs in whichever mode you are in. |\n` +
  `> | \`fill\` | Optional, \`true\`. Puts the prompt in the input box and waits instead of sending it — for a skill that has to be aimed at something. End the prompt with the blank and the cursor lands there. |\n` +
  `> | body | Everything after the closing \`---\` is the prompt. |\n\n` +
  `> [!info] The three that are not files\n` +
  `> The ⚡ menu also holds **Quiz**, **Flashcards** and **Find gaps**, which ship inside the plugin rather than as files — so this folder will always show fewer things than the menu does. They cannot be edited or deleted; copy one into a file here if you want your own version of it.\n` +
  `>\n` +
  `> | | Asks |\n` +
  `> |---|---|\n` +
  `> | **Quiz** | Practice questions on the open note, answers included |\n` +
  `> | **Flashcards** | Q/A pairs you can paste into a flashcard app |\n` +
  `> | **Find gaps** | What the **topic** raises but never answers |\n` +
  `>\n` +
  `> All three are note-scoped, like everything shipped here: run against a whole wiki they retrieve nothing, because the words in a prompt like "create practice questions" match no page summary.\n\n` +
  `> [!info] Documenting a skill\n` +
  `> A \`> [!info]\` callout anywhere in the body is **documentation, not prompt** — it is stripped before the model sees the file. That is how \`unclear-bits.md\` and \`action-items.md\` explain themselves without those words reaching Gemma.\n` +
      `>\n` +
      `> The two files that ship here carry a \`stamp:\` line in their frontmatter. **Leave it alone and the plugin keeps the file current when a release improves it; edit anything in the file and it is yours, permanently.** Deleting the stamp opts out too.\n` +
  `>\n` +
  `> Plain blockquotes are left alone, in case you want one inside a prompt.\n\n` +
  `> [!info] Where the answer goes\n` +
  `> Into the chat. Under every answer there is a save button — **you decide after reading whether it was worth keeping** — and it writes the answer into your own notes, beside the note it came from, behind the usual preview.\n\n` +
  `> [!info] What a skill is not\n` +
  `> Each skill is **one structured ask** against the current chat context — the mode plus any attached notes. It is not a multi-step agent, and it cannot chain tools. Calling it a skill is generous: it is a saved prompt with a menu entry, plus somewhere for the answer to land.\n` +
  `>\n` +
  `> Files named \`README\` (this one) are ignored.\n`;

// Every README opens with the same line, because the rule is the same for all
// of them and the only place it can be read at the moment it matters is the
// file itself. The plugin used to stamp each one with a hash of its own text
// and freeze it the moment you edited it — which meant an edited README stayed
// frozen on whatever a release said the day you touched it, silently
// describing behaviour the plugin no longer had, with nothing to tell you
// which of the two states you were in. Generated documentation is build
// output, the same as a card; one rule for both is one rule to remember.
const README_PREAMBLE =
  `> [!info] Generated file — your edits are replaced when Obsidian starts\n` +
  `> The plugin owns every \`README\` in this folder and rewrites them on startup, so they always describe the version you are running. Nothing here is a setting. **Anything you want to keep belongs in a note of your own.**\n\n`;

const CHATS_README =
  `# chats\n\n` +
  `**A conversation you pressed save on.** The chat panel keeps your last thread on its own, so this folder is not a log of everything you asked — it holds the threads you decided were worth keeping, one file each, named after the question that started them.\n\n` +
  `> [!info] These are not material\n` +
  `> Nothing here is retrieved, indexed, linted, relinked, retagged, or swept for contradictions. **Wiki chat cannot see this folder**, and neither can a scan.\n` +
  `>\n` +
  `> That is deliberate, and it is what makes keeping them safe. A model's answer that re-entered the wiki would come back months later cited to your own notes and indistinguishable from something you wrote — so an answer is output, never input. If a conversation contains something that should become material, **put it in a note of your own and scan that**; it becomes a card like any other note, because everything the wiki retrieves derives from a note you wrote.\n\n` +
  `> [!info] The one thing here that is yours\n` +
  `> Everything else under this folder is rebuilt from your notes if you delete it. **These files are not.** They are the only irreplaceable thing in the plugin's own directory, so if you clear out \`${'$'}{_wikiDir}\` to start over, move this folder out first.\n\n` +
  `> [!info] Reading one back\n` +
  `> Each question is a heading, so the outline pane gives you the thread at a glance. Every answer keeps the **Sources** it stood on at the time, and an answer given from general knowledge rather than your notes says so on its own line — the same distinction the panel makes on screen.\n`;

// Both halves are thunks. The body used to be a plain string built at import
// time, which froze `${_wikiDir}` at the default: rename the folder to `brain`
// and its regenerated README still opened with `# gemma-wiki`.
const FOLDER_READMES: Array<[() => string, () => string]> = [
  [() => `${wikiSkillsDir()}/README.md`, () => SKILLS_README],
  [() => `${wikiChatsDir()}/README.md`, () => CHATS_README],
  [
    () => `${_wikiDir}/README.md`,
    () =>
    `# ${_wikiDir}\n\n` +
      `**This folder is the only thing the plugin writes.** Your own notes are never moved or modified *by the plugin* — they stay wherever you keep them, and **editing them yourself is normal**: fix the note, and the wiki notices (the card shows as *drifted* on the review board) and offers to catch up. **Fixing the original note is the real fix; editing a card is a temporary patch that the next re-ingest overwrites.** *Improve formatting* is the single command that edits a note, and it always shows you the result first.\n\n` +
      `> [!info] Where the plugin lives` + `\n` +
      `> Click ${ICON_BRAND} in the ribbon down the left edge of the window to open the chat panel. That is where you ask about a note or about the whole wiki, run a skill, and save an answer back here.` + `\n` +
      `>` + `\n` +
      `> Everything else is a command: press <kbd>Cmd/Ctrl</kbd> + <kbd>P</kbd> and type *Gemma Wiki*.` + `\n\n` +
      `> [!info] Your notes stay where they are` + `\n` +
      `> **You do not reorganise anything to use this.** Your notes are the first layer already — wherever they live, whatever the folders are called. Nothing has to move.` + `\n` +
      `>` + `\n` +
      `> | To file | Do this |` + `\n` +
      `> |---|---|` + `\n` +
      `> | One note | Open it → the **Ingest this note into wiki** chip, or <kbd>Cmd/Ctrl</kbd>+<kbd>P</kbd> |` + `\n` +
      `> | A batch | **Scan a folder into the wiki** — it lists every folder with a count and you tick the ones you want |` + `\n` +
      `>` + `\n` +
      `> Web-clipped articles work the same way, and clipper boilerplate — *Subscribe*, *Share this*, cookie banners, nav link runs — is stripped before the model reads it, so the card is about the article. If you use **Obsidian Web Clipper**, giving it one landing folder (*Templates → your template → Note location*) is worth doing for your own sake: clips arrive in one place, so scanning them is one tick instead of hunting. **The plugin does not care which folder that is, or whether you have one.**` + `\n\n` +
      `> [!info] Before it can answer anything` + `\n` +
      `> The model is downloaded once — about 3 GB — and cached. It is not bundled with the plugin, so the first question you ask (or **Settings → Download model**) starts the download; you can keep working while it runs, and it resumes if interrupted.` + `\n` +
      `>` + `\n` +
      `> After that the plugin **never touches the network again**. There is no server, no API key, and no account: Gemma 4 runs inside Obsidian's own process on your GPU. Requires a desktop Obsidian with WebGPU — **Settings → [Test] Check WebGPU** confirms it in one click.` + `\n\n` +
      `## What it can do` + `\n\n` +
      `Nothing here reaches the network. Gemma 4 runs inside Obsidian on your GPU, so every command below costs GPU time rather than money, and works on a plane.` + `\n\n` +
      `> [!info] Ask` + `\n` +
      `> | | What it does |` + `\n` +
      `> |---|---|` + `\n` +
      `> | **Chat with active note** | Answers grounded in the note you have open — and nothing else. It says "not in the note" instead of guessing. |` + `\n` +
      `> | **Ask your wiki** | The other half of the same panel. Reads \`index.md\` to pick the pages worth opening, then answers from those, citing them. A question about the *collection* — *Find connections*, *What's still open?* — grounds in **every page instead**, because "what links my pages" is not a question retrieval can find an answer to. |` + `\n` +
      `> | **Skills** | Saved prompts — *Quiz*, *Flashcards*, *Find gaps*, plus *Action items* and *Unclear bits*, which ship as files. **All of them work on the open note**, so in Wiki mode they show greyed with a line saying to switch. A skill with \`fill: true\` puts its prompt in the input box and waits for you to finish the sentence instead of sending — that is how *Feynman* asks which idea. ${ICON_ZAP} in the panel. **Drop a \`.md\` file in \`skills/\` and it appears in the menu.** A skill file is frontmatter plus a prompt, so the menu holds questions; anything that *does* something is a chip above the input instead. |` + `\n\n` +
      `> [!info] File notes into the wiki` + `\n` +
      `> | | What it does |` + `\n` +
      `> |---|---|` + `\n` +
      `> | **Ingest this note into wiki** | Reads the open note and writes one card in \`cards/\`: summary, key points, tags, and how confident the model was. The note itself is untouched. **This is the one-note version of Scan.** |` + `\n` +
      `> | **Scan a folder into the wiki** | The same thing over whole folders. It asks which ones, and **shows how many new or changed notes each holds and roughly how long the run takes** before you commit. Then it drafts them all and shows you the batch — **nothing is written until you approve it**. |` + `\n` +
      `> | **Suggest tags & links** | Proposes frontmatter tags and links to related pages, for one note. You review before it writes. |` + `\n\n` +
      `> [!info] Build on top of what is filed` + `\n` +
      `> | | What it does |` + `\n` +
      `> |---|---|` + `\n` +
      `> | **Build a concept page** | Pick a tag or a name that several pages share; get a page written *above* them that links down into each. This is the wiki layer, not another summary. |` + `\n` +
      `> [!info] Check the wiki against itself` + `\n` +
      `> | | What it does |` + `\n` +
      `> |---|---|` + `\n` +
      `> | **Review board** | Everything that needs a human: low-confidence pages, and pages whose source note has changed since they were made. |` + `\n` +
      `> | **Find contradictions** | Compares pages against each other and reports claims that cannot both be true. |` + `\n` +
      `> | **Provenance spot-check** | Takes key points off a page and checks each one against the note it came from. Catches invented detail. |` + `\n` +
      `> | **Tidy the wiki** | Checks first — orphan pages, dead index entries, tag drift, no model — then offers four repairs you tick: make links mutual, drop dead index entries, rebuild the tag vocabulary, apply it to existing pages. Each runs behind its own preview. |` + `\n\n` +
      `> [!info] The one command that edits your own note` + `\n` +
      `> **Improve formatting** is the only thing here that writes into a note of yours. It fixes headings, lists and spacing — **it does not rewrite your words**, and the rewritten note is shown to you in full before anything is saved.` + `\n` +
      `>` + `\n` +
      `> A long note is split on its own headings and done in several passes; you are told how many before it starts. Select a section first to aim it at just that part.` + `\n\n` +
      `## schema.md — the tag rules` + `\n\n` +
      `> [!info] The file is deliberately small` + `\n` +
      `> You edit \`schema.md\` in source view, where collapsed explanations do not collapse — so the explanations live here instead, and the file itself is a dozen lines you can take in at a glance. Each section there carries a one-line hint saying what goes where.` + `\n\n` +
      `> [!info] Three ways it changes, and all three are yours` + `\n` +
      `> | | How | Good for |` + `\n` +
      `> |---|---|---|` + `\n` +
      `> | **By hand** | Edit \`schema.md\` and save — it is read before every ingest. | A tag or two, precisely |` + `\n` +
      `> | **Tidy the wiki** | <kbd>Cmd/Ctrl</kbd>+<kbd>P</kbd> → *Tidy the wiki* | Rebuilding the vocabulary from the tags your pages actually use, and bringing existing pages in line afterwards — two repairs, tick either or both |` + `\n` +
      `>` + `\n` +
      `> Editing affects **future** ingests only. Pages already written keep their tags until you run the retag repair in *Tidy the wiki*, which shows every change before writing. Nothing in the file ever changes without an approval of yours.` + `\n\n` +
      `> [!info] What each section holds` + `\n` +
      `> | Section | What goes there |` + `\n` +
      `> |---|---|` + `\n` +
      `> | **Tags** | The vocabulary, one \`- tag\` per line. Ingest reuses these instead of coining near-synonyms (\`llm-eval\` vs \`evals\`), which is what lets pages cluster into concept pages. Expect the occasional odd borrow from a small model — curate by hand when precision matters. |` + `\n` +
      `> | **Naming** | \`concept:\` is fed into the tag-naming prompt. A nudge, not a guarantee; file names are lower-cased and hyphenated mechanically either way. |` + `\n` +
      `> | **Concept threshold** | How many pages must share a tag before **Build a concept page** offers the cluster. Blank falls back to 4. |` + `\n` +
      `> | **Pending** | Tags ingest coined, waiting on you. Move a line up into Tags to keep it, delete it to reject it, move it into Rejected to ban it. A tag waiting here already helps later ingests reuse it. |` + `\n` +
      `> | **Rejected** | The veto, and it outranks everything: never re-proposed, never applied, never queued. Deleting from Tags alone lasts until the next Organize — a page still carrying the tag brings it back. A line here is permanent. |` + `\n\n` +
      `## The chat panel` + `\n\n` +
      `> [!info] Every answer ends with its Sources` + `\n` +
      `> **The plugin lists what it put in the prompt. The model is never asked to cite anything.** Citation is exactly the thing a small local model would get wrong in a way nobody notices — an invented page name reads as well as a real one.` + `\n` +
      `>` + `\n` +
      `> So the Sources row under an answer is not the model's claim about where it looked. It is the plugin's record of what it sent, and every entry is clickable.` + `\n` +
      `>` + `\n` +
      `> If the material does not contain the answer, you get told that instead of a guess — in both modes.` + `\n\n` +
      `> [!info] Header` + `\n` +
      `> | Control | What it does |` + `\n` +
      `> |---|---|` + `\n` +
      `> | **This note** / **Wiki** | Which material the answer is allowed to use. *This note* = the note you have open. *Wiki* = the pages in this folder. Switching also changes the suggestion chips underneath. |` + `\n` +
      `> | ${ICON_TRASH} | Clear the thread. Nothing is written anywhere. |` + `\n\n` +
      `> [!info] Under each answer` + `\n` +
      `> | Control | What it does |` + `\n` +
      `> |---|---|` + `\n` +
      `> | ${ICON_COPY} | Copy the answer as markdown. |` + `\n` +
      `> | ${ICON_REGEN} | Ask again from the same question. Useful when an answer starts well and drifts. |` + `\n` +
      `> | ${ICON_SAVE_TO_WIKI} | **Save as note.** Writes the answer into your own notes, beside the note it came from, recording which model wrote it and from which sources. It is then an ordinary note of yours — so the next scan can card it like any other, which is the only way anything becomes material. |` + `\n\n` +
      `> [!info] Around the input box` + `\n` +
      `> | Control | What it does |` + `\n` +
      `> |---|---|` + `\n` +
      `> | ${ICON_ATTACH} | Attach another note as extra context, on top of whatever the current mode already sends. |` + `\n` +
      `> | ${ICON_ZAP} | The skills menu. Built-ins plus every file in \`skills/\`. A skill can declare which mode it needs; one that needs the other mode is **shown greyed rather than switching you into it** — a menu item should not quietly change what the panel is grounded in. |` + `\n` +
      `> | The chips above it | Three one-press starters, fixed — the row you learn is the row you keep. In Wiki mode: *Scan a folder*, *Find connections*, *What's still open?* **While a scan is running, the first one becomes *Stop scan*.** **A chip with a small icon does something; a chip without one asks something.** The ones that do are always behind their own preview. |` + `\n` +
      `> | <kbd>Enter</kbd> | Send. <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line. |` + `\n` +
      `> | Send / stop | Answers stream in as they are generated. While one is running the send button becomes a stop button — pressing it keeps whatever has arrived so far. |` + `\n\n` +
      `## While something is running` + `\n\n` +
      `Ingesting a note is half a minute. Scanning a folder, or reformatting a long note, is minutes. You are not meant to sit and watch.` + `\n\n` +
      `> [!info] It pops once, then moves to the status bar` + `\n` +
      `> Starting is a moment, so it pops in the corner like anything else. **Staying started is not a moment**, so the running detail moves to the status bar along the bottom edge — always visible, never covering what you are reading, and **impossible to dismiss by accident**. Click it and it repeats the current step instead of disappearing. It pops again when it finishes.` + `\n` +
      `>` + `\n` +
      `> The same one line shows three things, whichever is true:` + `\n` +
      `>` + `\n` +
      `> | Looks like | Means |` + `\n` +
      `> |---|---|` + `\n` +
      `> | ⏳ *Drafting 7/30 — …* | Working. Click to repeat the message. |` + `\n` +
      `> | ✅ *30 drafts ready to review* | **Finished, and waiting for you.** Click to open it. |` + `\n` +
      `> | 📥 *4 to review* | Notes have changed since you filed them. Click to scan. **Off by default**, and when on it only *counts* — it never runs the model behind your back. |` + `\n\n` +
      `> [!info] Stopping a scan` + `\n` +
      `> While one is running, the **Scan a folder** chip becomes **Stop scan** — and so does "Stop the running scan" on the command palette.` + `\n` +
      `>` + `\n` +
      `> A model call cannot be interrupted, so **the note being drafted right now finishes first** — up to a minute — and it is kept. Everything drafted up to that point goes to the review list as usual; the rest is simply offered again on the next scan. **Stopping never loses work and never writes anything.**` + `\n\n` +
      `> [!info] A dialog will not jump in front of you` + `\n` +
      `> If you stayed and waited, the result opens by itself — you are waiting on it, and making you click again would be silly.` + `\n` +
      `>` + `\n` +
      `> **If you went back to your notes while it ran, it does not open.** It waits on the status bar as ✅ until you ask for it. A dialog that steals the window minutes after you started something is an ambush: by then you are typing somewhere else, and it is the first you hear of the whole operation.` + `\n\n` +
      `> [!info] One more mark, in the file explorer` + `\n` +
      `> A small mark next to a note means it already has a card in \`cards/\`. Decoration only — **the note file itself is untouched**.` + `\n\n` +
      `## Settings worth knowing about` + `\n\n` +
      `> [!info] The five that change what happens` + `\n` +
      `> | Setting | Why you would touch it |` + `\n` +
      `> |---|---|` + `\n` +
      `> | **Context window** | How much the model holds at once. Bigger = longer notes fit whole and answers ground on more; costs GPU memory and time to the first word. **If the model fails to load or answers get worse after raising it, lower it.** Takes effect after the plugin reloads. |` + `\n` +
      `> | **Never scan these** | Folders that are not notes: templates, attachments, an archive. Skipped by every scan whatever you tick. There is no "which folders" setting — the scan dialog asks, and remembers your last pick. |` + `\n` +
      `> | **Stale after (days)** | How old a page gets before the review board asks you to look at it again. |` + `\n` +
      `> | **Default chat mode** | Whether the panel opens on *This note* or *Wiki*. |` + `\n` +
      `> | **Knowledge folder name** | Renames this folder and rewrites every internal link. Asks first. |` + `\n` +
      `>` + `\n` +
      `> Settings also shows a live map of this folder with a tick or *missing* per row, and a **Repair folders** button that recreates anything gone. It only ever adds.` + `\n\n` +
      `## Where things go` + `\n\n` +
      `> [!info] Folders` + `\n` +
      `> | Folder | What lands here |` + `\n` +
      `> |---|---|` + `\n` +
      `> | \`cards/\` | **One summary card per note you ingest.** Your note is the source; the card is derived from it. |` + `\n` +
      `> | \`concepts/\` | Pages built *across* everything sharing a tag or mention. |` + `\n` +
      `> | \`skills/\` | One file per entry in the ${ICON_ZAP} skills menu. **Add a file, get a menu item.** |` + `\n` +
      `>` + `\n` +
      `> Every folder has a README of its own describing what belongs in it.` + `\n\n` +
      `> [!info] The three files\n` +
      `> | File | What it is |\n` +
      `> |---|---|\n` +
      `> | \`index.md\` | The catalog: one line per page. **Wiki-mode chat reads it first** to decide which pages to open — which is why the summaries live there and not only on the pages. **Tidy the wiki** forces a repair pass. |\n` +
      `> | \`log.md\` | Append-only record of every operation, greppable by action. |\n` +
      `> | \`schema.md\` | Your tag vocabulary, the naming rules, and the tags you rejected. Edit it by hand and the plugin obeys. |\n\n` +
      `> [!info] Deleting things\n` +
      `> Delete any page freely — its index entry is dropped automatically.\n` +
      `>\n` +
      `> Delete a **folder** and it is recreated empty the next time Obsidian starts, or from **Settings → Repair folders**. **The pages that were inside it are not restored** — the plugin maintains this scaffolding, it does not back it up. Run **Tidy the wiki** afterwards to clear the index entries they left behind.\n` +
      `>\n` +
      `> **One exception: \`chats/\`.** Every other page here is rebuilt from your notes if you lose it — a card by re-ingesting, a concept page by rebuilding it. A saved conversation has no source to rebuild from. If you are clearing this folder out to start over, move that one somewhere else first.\n`,
  ],
  [
    () => `${wikiSourcesDir()}/README.md`,
    () =>
    `# cards\n\n` +
      `**One card here for each note you have ingested** — a model-written summary: key points, tags, and how confident the model was about its own extraction.\n\n` +
      `> [!info] A card is not your note\n` +
      `> Your original notes stay wherever you keep them and are **never touched by the plugin**. A card is the wiki's summary *of* a note — the \`source\` line in its frontmatter points back at the real one.\n` +
      `>\n` +
      `> **Found a mistake while chatting? Fix the original note, not the card.** Edit the note, and the plugin notices: the card shows up on the review board as *drifted*, and re-ingesting rebuilds it from the corrected note.\n` +
      `>\n` +
      `> Editing a card directly is a temporary patch — nothing tracks it, and the next re-ingest overwrites it (behind a preview, so you will see it happen).\n\n` +
      `> [!info] What the frontmatter does\n` +
      `> | Field | What it does |\n` +
      `> |---|---|\n` +
      `> | \`source\` | The note this card was made from, wherever it lives in your vault. |\n` +
      `> | \`source_hash\` | What that note looked like at the time. **This is how drift is caught** — edit the note and the review board reports this card as out of date. |\n` +
      `> | \`confidence\` | \`high\`, \`med\` or \`low\`, written by the model about its own extraction. Anything below \`high\` lands on the review board. |\n` +
      `> | \`tags\` | One to three topics, drawn from the vocabulary in \`schema.md\`. |\n\n` +
      `> [!info] Deleting\n` +
      `> **Deleting a card breaks nothing:** its entry in \`index.md\` is dropped automatically, and **Tidy the wiki** clears links pointing at it from other pages.\n`,

  ],
  [
    () => `${wikiConceptsDir()}/README.md`,
    () =>
    `# concepts\n\n` +
      `**Pages built *across* other pages.** Everything in \`cards/\` is about one note. A concept page is about a *theme*: pick a tag or a mention that two or more pages share, and the plugin writes a page above them that links down into each one.\n\n` +
      `> [!info] Why this folder exists\n` +
      `> A pile of summaries is still a pile.\n` +
      `>\n` +
      `> **This is where the wiki grows a second storey** — the layer where you can ask what you think about a subject, rather than what one note said about it.\n\n` +
      `> [!info] How they differ from ingested pages\n` +
      `> | | \`cards/\` | \`concepts/\` |\n` +
      `> |---|---|---|\n` +
      `> | Made from | One note | Every page sharing a tag |\n` +
      `> | Named after | The note | The tag |\n` +
      `> | Frontmatter | \`source\`, \`source_hash\` | \`kind: concept\` |\n` +
      `> | Retag touches it | Yes | No — it is named by its tag |\n`,
  ],
];

// Runs on every layout-ready, not just before the first write: an empty
// plugin that has created nothing is unreadable — you cannot tell what it
// intends to do with your vault until it has already done it. Every call is
// a no-op once the folders exist.
export async function ensureWikiScaffold(vault: Vault): Promise<void> {
  for (const dir of [wikiDir(), wikiSourcesDir(), wikiConceptsDir(), wikiSkillsDir()]) {
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
  // schema.md is mixed ownership, and regeneration is what enforces the
  // split: the five data slots (tags, naming, threshold, pending, rejected)
  // ride through the parser untouched, everything around them is rebuilt from
  // the current template. Deleted a callout? It is back next start. Edited
  // your tags? Never overwritten. No stamp, no hash, no state — the parser
  // itself is the definition of what is yours.
  const schemaFile = vault.getAbstractFileByPath(schemaPath());
  if (!schemaFile) {
    await vault.create(schemaPath(), buildSchemaFile([])).catch(() => {});
  } else if (schemaFile instanceof TFile) {
    const current = await vault.read(schemaFile).catch(() => null);
    if (current !== null) {
      const d = parseSchema(current);
      const rebuilt = buildSchemaFile(d.tags, d.naming, d.conceptThreshold, d.pending, d.rejected);
      if (rebuilt !== current) await vault.modify(schemaFile, rebuilt).catch(() => {});
    }
  }
  // READMEs are the plugin's own documentation and are rewritten on every
  // start — each one says so in its first line. There used to be a stamp here
  // that froze a README forever the moment it was edited; that left stale
  // documentation in the vault with nothing marking it stale, and it made a
  // second rule where the card already set one: build output gets rebuilt.
  for (const [pathOf, bodyOf] of FOLDER_READMES) {
    const path = normalizePath(pathOf());
    const text = README_PREAMBLE + bodyOf();
    const existing = vault.getAbstractFileByPath(path);
    if (!existing) {
      await vault.create(path, text).catch(() => {});
      continue;
    }
    if (!(existing instanceof TFile)) continue;
    // Compared, not stamped: writing only on a real difference keeps every
    // start from touching five files for nothing, but the comparison is
    // against the current default rather than against what we last wrote.
    // There is no state for a vault to be in.
    const current = await vault.read(existing).catch(() => null);
    if (current === text) continue;
    await vault.modify(existing, text).catch(() => {});
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
  // Tags the user has banned by hand. Highest authority: Organize never
  // re-proposes them, ingest never uses them, Pending never queues them —
  // a plain deletion from Tags only lasts until the next rebuild, because
  // rebuilds read the tags still in use on pages. This list is permanent.
  rejected: string[];
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
  pending: string[] = [],
  rejected: string[] = []
): string {
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
    `${rejectedLines}\n`
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
  return {
    tags,
    naming: Object.keys(naming).length ? naming : DEFAULT_NAMING,
    conceptThreshold: tm ? parseInt(tm[0], 10) : DEFAULT_CONCEPT_THRESHOLD,
    pending,
    rejected,
  };
}

export async function readSchema(vault: Vault): Promise<WikiSchema> {
  const content = await readIfExists(vault, schemaPath());
  if (!content) return { tags: [], naming: DEFAULT_NAMING, conceptThreshold: DEFAULT_CONCEPT_THRESHOLD, pending: [], rejected: [] };
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
  // Rejected tags never enter the queue — the ban is the user's veto (#56).
  const known = new Set(
    [...schema.tags, ...schema.pending, ...schema.rejected].map((t) => slugify(t))
  );
  const fresh = tags.filter(isUsableTag).map((t) => slugify(t)).filter((t) => !known.has(t));
  if (!fresh.length) return { before, after: before };
  const pending = [...schema.pending, ...fresh];
  const next = buildSchemaFile(schema.tags, schema.naming, schema.conceptThreshold, pending, schema.rejected);
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
  /**
   * Put the prompt in the input box and stop, instead of sending it.
   *
   * For a skill that needs one word from you — which concept, which section.
   * A skill is one prompt and one press, and that is right for "quiz me on
   * this"; it is wrong for anything that has to be aimed. Ending the prompt
   * with the blank and leaving the cursor there costs one press and keeps the
   * careful wording that a hand-typed question would lose.
   */
  fill?: boolean;
}

// A skill file is `key: value` frontmatter between --- fences, then the prompt
// as the body. We parse only the handful of keys we use and treat everything
// after the closing fence as the prompt, so a user can write the prompt as
// ordinary markdown (lists, bold) without escaping anything.
// A skill file's body is sent to the model verbatim, which left nowhere to
// explain what the skill is for — the file could not document itself the way
// index.md and schema.md do. So one rule: a "> [!info]" callout is
// documentation and is stripped before the prompt is assembled. Plain
// blockquotes are left alone; someone may well want one inside a prompt.
function stripCalloutBlocks(body: string): string {
  const out: string[] = [];
  let inCallout = false;
  for (const line of body.split('\n')) {
    if (/^>\s*\[!/.test(line)) {
      inCallout = true;
      continue;
    }
    if (inCallout) {
      // The block runs until the first line that is not a quote line.
      if (/^>/.test(line) || line.trim() === '') continue;
      inCallout = false;
    }
    out.push(line);
  }
  return out.join('\n');
}

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
  const prompt = stripCalloutBlocks(content.replace(/^---\n[\s\S]*?\n---\n?/, '')).trim();
  if (!prompt) return null;
  const mode = front.mode === 'wiki' ? 'wiki' : front.mode === 'note' ? 'note' : undefined;
  return {
    label: front.name || front.label || name,
    icon: front.icon || 'wand-2',
    prompt,
    mode,
    fill: front.fill === 'true',
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

function buildSkillFile(
  name: string,
  icon: string,
  mode: 'note' | 'wiki' | undefined,
  prompt: string,
  doc?: string,
  fill = false
): string {
  const modeLine = (mode ? `mode: ${mode}\n` : '') + (fill ? 'fill: true\n' : '');
  // The callout goes above the prompt so the file reads as documentation first;
  // stripCalloutBlocks() removes it again on the way to the model.
  const docBlock = doc ? `${doc}\n\n` : '';
  return `---\nname: ${name}\nicon: ${icon}\n${modeLine}---\n\n${docBlock}${prompt}\n`;
}


// Seed the skills folder with a README and two example skills, the first time
// the user asks for it. Never overwrites an existing file, so re-running is safe.
export async function ensureSkillsScaffold(vault: Vault): Promise<void> {
  const dir = normalizePath(wikiSkillsDir());
  if (!vault.getAbstractFileByPath(dir)) {
    await vault.createFolder(dir).catch(() => {});
  }
  const seeds: Array<[string, string]> = [
    // Replaces feynman.md, which had no job of its own: its first half was
    // Summarize and its second was close to Find gaps. The real Feynman
    // technique is YOU explaining and noticing where you stumble, which needs
    // a conversation; this plugin is one structured ask by design, and what
    // survives of the technique in one shot is two other menu entries.
    //
    // What the old prompt was genuinely good at was its second half on a
    // brain-dump note — naming the shorthand nobody else could follow. That
    // is not Summarize and not Find gaps (which asks what the TOPIC leaves
    // open); it is a legibility check on your own writing, and it earns a
    // place where the technique could not.
    [
      `${wikiSkillsDir()}/unclear-bits.md`,
      buildSkillFile(
        'Unclear bits',
        'help-circle',
        'note',
        'Find the places in this note that another person could not follow — and that you ' +
          'yourself would not follow in six months.\n\n' +
          'Look for: shorthand and abbreviations that are never expanded; names, tools and ' +
          'projects referred to without saying what they are; fragments that assume context the ' +
          'note does not contain; and links or titles mentioned with no indication of what they ' +
          'hold.\n\n' +
          'For each one, quote the exact phrase, say what is missing, and suggest the shortest ' +
          'addition that would fix it.\n\n' +
          'If nothing in the note would stop another reader, say so — and name the one or two ' +
          'things that came closest, so it is clear what you looked at. Do not invent problems ' +
          'to fill the list.',
        `> [!info] What this skill is\n` +
          `> **A legibility check on your own writing.** It finds the bits of a note that only made sense to you on the day you wrote them — the abbreviation you never expanded, the tool named with no hint of what it does, the line that assumes something the note never says.\n` +
          `>\n` +
          `> Most useful on a fast note: a brain dump, a meeting scribble, anything written in shorthand or in more than one language. **On a note that was written carefully it will find nothing** — and will say what came closest, so you can tell it looked.\n` +
          `>\n` +
          `> | | Asks |\n` +
          `> |---|---|\n` +
          `> | **Summarize** | What does this note say? |\n` +
          `> | **Find gaps** | What does the **topic** leave unanswered? |\n` +
          `> | **This skill** | What would **nobody else understand**? |\n` +
          `>\n` +
          `> Everything below this box is the prompt. **Callouts are documentation and are stripped before the model sees it** — edit the prompt freely, and delete this box if you want.`
      ),
    ],
    [
      `${wikiSkillsDir()}/action-items.md`,
      buildSkillFile(
        'Action items',
        'list-checks',
        'note',
        'List the concrete next actions this material implies, as a checklist. One action per line, each starting with a verb.',
        `> [!info] What this skill is\n` +
          `> Turns a note you have been sitting on into a checklist you can act from. **One action per line, each starting with a verb** — so "email the PI about the waitlist", not "waitlist situation".\n` +
          `>\n` +
          `> Runs against whatever the chat is grounded in: the open note, or the pages the wiki retrieved. Switch it to \`mode: wiki\` in the frontmatter if you want it over the whole wiki instead.\n` +
          `>\n` +
          `> Everything below this box is the prompt. **Callouts are documentation and are stripped before the model sees it.**`
      ),
    ],
  ];
  // Same deal as the generated READMEs: a seed the plugin wrote should get a
  // better version when one ships, and a seed you edited is yours forever.
  //
  // Without this, improving a shipped skill only reached vaults created after
  // the change — which bit twice, most visibly when Feynman was rewritten to
  // fill the input box and every existing vault went on sending the old
  // prompt, correctly, from the old file.
  for (const [path, content] of seeds) {
    const norm = normalizePath(path);
    const existing = vault.getAbstractFileByPath(norm);
    if (!existing) {
      await vault.create(norm, stampSeed(content)).catch(() => {});
      continue;
    }
    if (!(existing instanceof TFile)) continue;
    const current = await vault.read(existing).catch(() => null);
    if (current === null || !isUnmodifiedSeed(current)) continue;
    if (stripSeedStamp(current) === content) continue;
    await vault.modify(existing, stampSeed(content)).catch(() => {});
  }
}

// The stamp for a skill file goes INSIDE the frontmatter, not at the end of
// the file the way a README's does. A skill's body is the prompt: an HTML
// comment appended to it would be sent to the model. parseSkillFile reads the
// keys it knows and ignores the rest, so an extra one costs nothing.
const SEED_STAMP = /^stamp: ([0-9a-f]{8})\n/m;

export function stripSeedStamp(text: string): string {
  return text.replace(SEED_STAMP, '');
}

function stampSeed(content: string): string {
  const hash = contentHash(content);
  // Seeds always start with frontmatter; put the stamp on the line after the
  // opening fence so it survives the user editing anything below it.
  return content.startsWith('---\n')
    ? content.replace('---\n', `---\nstamp: ${hash}\n`)
    : `${content}\n<!-- gemma-wiki: generated (${hash}) -->\n`;
}

/** True only while the file still hashes to what the plugin wrote. */
export function isUnmodifiedSeed(text: string): boolean {
  const m = SEED_STAMP.exec(text);
  if (!m) return false;
  return contentHash(stripSeedStamp(text)) === m[1];
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

/**
 * Load the retrieved pages.
 *
 * This used to return two piles — pages, and saved answers ranked below them
 * under a heading telling the model which to believe. That was the middle path
 * while answers were retrieved at all. They are not: `pageDirs()` is cards and
 * concepts, so no answer ever gets an index entry, so no entry reaching here
 * could have an answers/ prefix and the second pile was always empty.
 *
 * The rule that replaced it needs no ranking, because it is structural:
 * everything retrievable derives from a note you wrote.
 */
export async function loadPages(
  vault: Vault,
  entries: IndexEntry[],
  maxTotalChars: number
): Promise<string> {
  let pages = '';
  for (const e of entries) {
    const content = await readIfExists(vault, `${e.linkPath}.md`);
    if (!content) continue;
    if (pages.length + content.length > maxTotalChars) break;
    pages += `### Page: ${e.title}\n${content}\n\n`;
  }
  return pages;
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
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

/**
 * A note written from a chat answer, for the user's own vault.
 *
 * The frontmatter is two facts and no bookkeeping. `written_by` and `sources`
 * are exactly what a copy-paste destroys, and they are why a button beats
 * Cmd+C at all.
 *
 * Deliberately absent: `tags:`, because choosing tags for a file in someone's
 * own folder is presumptuous — when this note is later ingested its card gets
 * tags, which is where model-chosen tags belong. And `derived` and
 * `read_hashes`, both of which were only ever read by code that filters to
 * wiki pages and so could never see an answer.
 */
export function buildAnswerNote(
  question: string,
  answer: string,
  sources: { title: string; linkPath: string }[],
  opts: { model: string; titleLabel?: string }
): string {
  const date = new Date().toISOString().slice(0, 10);
  const sourceLines = sources.map((s) => `- [[${s.linkPath}|${s.title}]]`).join('\n');
  // A canned prompt makes a terrible H1 ("Create 5 practice questions that
  // test understanding of this material. Number each..."). Prefer the label.
  const title = opts.titleLabel ?? (question.length > 90 ? `${question.slice(0, 87)}…` : question);
  const sourcesYaml = sources.length
    ? `sources:\n${sources.map((x) => `  - "[[${x.title}]]"`).join('\n')}\n`
    : '';
  return (
    `---\n` +
    `written_by: ${opts.model}\n` +
    `created: ${date}\n` +
    sourcesYaml +
    `---\n\n` +
    `# ${title}\n\n` +
    (opts.titleLabel ? `> [!quote]- The exact prompt\n> ${question}\n\n` : '') +
    `${answer.trim()}\n` +
    (sourceLines ? `\n## Sources\n\n${sourceLines}\n` : '')
  );
}


/**
 * A whole conversation as one note.
 *
 * The counterpart to buildAnswerNote, and it exists for the same reason a
 * per-answer save does: an exchange you want to keep should end up somewhere
 * you can read it later without this plugin installed. What is different is
 * where it lands. The first version of this wrote into `gemma-wiki/chats/` —
 * a folder the plugin tells you is safe to delete, and one auto-ingest is
 * hard-coded to walk past, so the transcript could never become material
 * however good it was. It goes in your own folders now, like a saved answer.
 *
 * Every question gets a heading, so the file explorer's outline and the
 * document outline both give you the thread at a glance. Sources are recorded
 * per answer rather than pooled at the end: in a thread that switched notes,
 * one list at the bottom would attribute all of it to whatever came last.
 */
export function buildChatTranscript(
  turns: ChatTurnRecord[],
  opts: { model: string; titleLabel: string }
): string {
  const date = new Date().toISOString().slice(0, 10);
  // Union of everything cited, for frontmatter — the per-answer lists below
  // stay authoritative about which answer stood on what.
  const seen = new Map<string, string>();
  for (const t of turns) for (const s of t.sources ?? []) seen.set(s.linkPath, s.title);
  const sourcesYaml = seen.size
    ? `sources:\n${[...seen.values()].map((t) => `  - "[[${t}]]"`).join('\n')}\n`
    : '';

  const body: string[] = [];
  let first = true;
  for (const turn of turns) {
    if (turn.role === 'user') {
      const q = turn.content.trim();
      // The H1 is this question, so heading it again puts the same line twice
      // at the top of the note. It still appears in the outline — as the H1 —
      // with the follow-ups nested under it, which is the shape the thread
      // actually has. A long first question is truncated in the title, so the
      // two differ and the heading is kept.
      if (first) {
        first = false;
        if (q === opts.titleLabel) continue;
      }
      // A heading has to be one line. A pasted paragraph as a question keeps
      // its first line as the heading and the rest as a quote under it.
      const [head, ...rest] = q.split('\n');
      body.push(`## ${head.trim()}`);
      if (rest.join('\n').trim()) body.push(rest.map((l) => `> ${l}`).join('\n'));
      continue;
    }
    body.push(turn.content.trim());
    if (turn.grounding === 'direct') {
      body.push('*Answered from general knowledge, not from your notes.*');
    } else if (turn.sources?.length) {
      body.push(
        `**Sources:** ${turn.sources.map((s) => `[[${s.linkPath}|${s.title}]]`).join(' · ')}`
      );
    }
  }

  return (
    `---\n` +
    `written_by: ${opts.model}\n` +
    `created: ${date}\n` +
    `kind: conversation\n` +
    sourcesYaml +
    `---\n\n` +
    `# ${opts.titleLabel}\n\n` +
    `${body.join('\n\n')}\n`
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
  /**
   * What this turn was grounded in — the mode plus the note, or `wiki`, or
   * `direct` for an ungrounded answer.
   *
   * Follow-up context is only ever built from turns that share the current
   * key. The panel is one scrolling transcript, but the material under it
   * changes when you switch notes or modes, and a model handed "what does it
   * say about caching?" after three turns about a different note answers
   * confidently about the wrong one.
   */
  grounding?: string;
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
