import { App, Modal } from 'obsidian';
import { fmOf, indexPath, isWikiPage, logPath, wikiDir, readIndexEntries } from './wiki-store';
import { findDuplicatePairs, type DuplicateCandidate, type DuplicatePair } from './pure';

// Lint v1, deliberately model-free: orphans and index health are graph
// facts the metadata cache already knows. LLM-driven lint phases
// (contradiction detection, auto-fix ordering) stay out of scope — that
// class of multi-step judgment hasn't been validated for a model this
// size.

export interface LintReport {
  pageCount: number;
  orphans: string[];
  missing: string[];
  unindexed: string[];
}

export async function runLint(app: App): Promise<LintReport> {
  const entries = await readIndexEntries(app.vault);
  const wikiFiles = app.vault
    .getMarkdownFiles()
    .filter(isWikiPage);
  const wikiPaths = new Set(wikiFiles.map((f) => f.path));

  // Inbound wiki-to-wiki links only. The index links to every page by
  // design, so counting it would make orphans structurally impossible.
  const inbound = new Map<string, number>();
  for (const [src, targets] of Object.entries(app.metadataCache.resolvedLinks)) {
    if (!src.startsWith(`${wikiDir()}/`) || src === indexPath() || src === logPath()) continue;
    for (const [tgt, count] of Object.entries(targets)) {
      if (tgt === src) continue;
      if (wikiPaths.has(tgt)) inbound.set(tgt, (inbound.get(tgt) ?? 0) + count);
    }
  }

  const orphans = wikiFiles.filter((f) => !(inbound.get(f.path) ?? 0)).map((f) => f.path);
  const missing = entries
    .filter((e) => !app.vault.getAbstractFileByPath(`${e.linkPath}.md`))
    .map((e) => e.linkPath);
  const entryPaths = new Set(entries.map((e) => `${e.linkPath}.md`));
  const unindexed = wikiFiles.filter((f) => !entryPaths.has(f.path)).map((f) => f.path);

  return { pageCount: wikiFiles.length, orphans, missing, unindexed };
}


/**
 * Cards that look like they are about the same subject as another card.
 *
 * Model-free, like the rest of the check: every input already exists on disk.
 * `mentions:` is written at ingest, and the alias table comes from schema.md,
 * where Retag leaves the old-tag-to-vocabulary-tag decisions the user already
 * approved. Resolving both through the aliases is what lets a page still
 * carrying `llm-eval` be seen as the same subject as one carrying `evals`.
 *
 * Concept pages are excluded on purpose. They are named BY a tag, so two of
 * them about one idea is a duplicate TAG, and the repair for that is the
 * vocabulary rebuild — a different box in the same dialog.
 */
export interface SameSubjectReport {
  pairs: DuplicatePair[];
  /** How many qualified in all, so a capped list does not read as the whole answer. */
  total: number;
}

export async function findSameSubject(
  app: App,
  aliases: Record<string, string>,
  cap: number
): Promise<SameSubjectReport> {
  const candidates: DuplicateCandidate[] = [];
  for (const f of app.vault.getMarkdownFiles()) {
    if (!isWikiPage(f)) continue;
    const fm = fmOf(app, f);
    if (fm?.kind === 'concept') continue;
    // A card is a page with a source note behind it. Anything else in the
    // wiki folder — an index, a README — has no subject to be duplicated.
    if (typeof fm?.source !== 'string' || !fm.source) continue;
    const raw = fm?.mentions;
    const mentions = Array.isArray(raw) ? raw.map((m) => String(m)).filter((m) => m.trim()) : [];
    candidates.push({
      linkPath: f.path.replace(/\.md$/, ''),
      title: f.basename,
      mentions,
      mtime: f.stat.mtime,
    });
  }

  // Already linked in either direction means the relationship is recorded,
  // which is all this finding was ever going to ask for.
  const resolved = app.metadataCache.resolvedLinks;
  const linked = (a: string, b: string) =>
    !!resolved[`${a}.md`]?.[`${b}.md`] || !!resolved[`${b}.md`]?.[`${a}.md`];

  return findDuplicatePairs({ pages: candidates, aliases, linked, cap });
}

/** Model-free read of the tag vocabulary's state, for the tidy report. */
export interface TagHealth {
  /** Tags in `## Tags` — the list ingest is allowed to reuse. */
  vocabulary: number;
  /** Tags waiting in `## Pending`. */
  pending: number;
  /** Distinct tags actually carried by wiki pages. */
  inUse: number;
  /** Tags in use that share a stem, so are probably the same idea. */
  clusters: string[][];
  /**
   * In-use tags absent from the vocabulary. The number that says whether the
   * vocabulary is doing its job: "6 tags, 22 in use, 0 waiting" made a reader
   * work out the relationship themselves, and the relationship was the point.
   */
  offVocabulary: number;
}

/**
 * One report for the shape of the wiki, and the repairs for what it found.
 *
 * This replaces five commands. Lint said what was wrong; Relink and Reconcile
 * fixed two of those things; Organize and Retag were the two halves of a
 * third. Knowing all five names, and the order, was left to the user — Retag
 * even printed "run Organize tags first", which is the plugin routing someone
 * by hand through a sequence it already understood.
 *
 * Findings that need nothing are stated and left alone. Findings with a repair
 * carry a checkbox, and the cost is on the label: a repair that only rearranges
 * links is free, one that calls the model says so, because a run that takes a
 * minute should not be a surprise.
 */
export class TidyModal extends Modal {
  private report: LintReport;
  private tags: TagHealth;
  private sameSubject: SameSubjectReport;
  private onApply: (chosen: Set<string>) => Promise<void>;
  private chosen = new Set<string>();

  constructor(
    app: App,
    report: LintReport,
    tags: TagHealth,
    sameSubject: SameSubjectReport,
    onApply: (chosen: Set<string>) => Promise<void>
  ) {
    super(app);
    this.report = report;
    this.tags = tags;
    this.sameSubject = sameSubject;
    this.onApply = onApply;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('gemma4-lint-modal');
    contentEl.createEl('h3', { text: 'Tidy the wiki' });
    contentEl.createDiv({
      cls: 'gemma4-lint-summary',
      text: `${this.report.pageCount} pages checked. Nothing is written until you approve each repair.`,
    });

    // Every repair is listed whether or not the scan found something for it.
    // Tying availability to detection quietly removed working paths: a
    // vocabulary you hand-edited could no longer be applied, and near-duplicate
    // tags that do not share a stem — `llm-eval` and `evals`, the example in
    // the plugin's own prompt — left Organize unreachable. The scan is good
    // enough to choose a default, not good enough to be the only way in.
    const t = this.tags;

    const orphans = this.report.orphans.length;
    this.finding(
      'relink',
      orphans
        ? `${orphans} page${orphans === 1 ? '' : 's'} with no inbound link`
        : 'Related sections — every page has an inbound link',
      'Makes existing links mutual, fills empty Related sections, and drops links to pages that are ' +
        'gone. A page that genuinely relates to nothing stays an orphan.',
      this.report.orphans,
      orphans > 0
    );

    // Fifth repair, and the only one that is about meaning rather than about
    // the graph. It sits after relink because relink is what makes existing
    // links mutual, and a pair this finding would report may already have
    // been joined by then.
    const dupes = this.sameSubject.pairs.length;
    const total = this.sameSubject.total;
    this.finding(
      'dedupe',
      dupes
        ? `${dupes} pair${dupes === 1 ? '' : 's'} of pages look like they are about the same thing` +
          (total > dupes ? ` (of ${total} found)` : '')
        : 'Same-subject pages — no unlinked pair looks like one subject',
      'Links each pair to the other, so the relationship is at least recorded. Nothing is merged and ' +
        'nothing is deleted — two notes about one subject are two pieces of writing, and which to keep ' +
        'is yours. Where a pair is really a cluster, "Build a concept page" is the better answer. ' +
        'No model, nothing to review beyond the preview.',
      this.sameSubject.pairs.map((p) => `${p.a.title}  ·  ${p.b.title}  — ${p.because}`),
      dupes > 0
    );

    const missing = this.report.missing.length;
    this.finding(
      'reconcile',
      missing
        ? `${missing} index entr${missing === 1 ? 'y' : 'ies'} pointing at deleted pages`
        : 'Index — no entries point at deleted pages',
      'Drops dead index entries and any Related links pointing at them. No model, nothing to review.',
      this.report.missing,
      missing > 0
    );

    // Two halves, two boxes. Rebuilding without applying leaves existing pages
    // on their old tags; applying without rebuilding is the path you want after
    // editing schema.md by hand, and merging them removed it.
    const noVocab = !t.vocabulary && t.inUse > 0;
    this.finding(
      'organize',
      noVocab
        ? `No tag vocabulary yet — ${t.inUse} different tags in use, ${t.pending} waiting`
        : t.offVocabulary
          ? `Tag vocabulary — ${t.offVocabulary} of the ${t.inUse} tags your pages use are not in it`
          : `Tag vocabulary — all ${t.inUse} tags your pages use are in it`,
      (noVocab
        ? 'Ingest has nothing to reuse, so every note coins its own. '
        : '') +
        'Rebuilds the vocabulary in schema.md from the tags your pages actually use, folding ' +
        'near-duplicates together. One model call, one preview.',
      t.clusters.length ? t.clusters.map((g) => g.join('  ·  ')) : [],
      noVocab || t.clusters.length > 0
    );

    this.finding(
      'retag',
      'Apply the vocabulary to existing pages',
      'Rewrites page tags to the vocabulary in schema.md — including a vocabulary you edited by ' +
        'hand. Tick this with the box above to do both, or on its own after editing schema.md. ' +
        'One model call, one preview.',
      [],
      noVocab || t.clusters.length > 0
    );

    if (this.report.unindexed.length) {
      this.info(
        `${this.report.unindexed.length} page${this.report.unindexed.length === 1 ? '' : 's'} missing from the index`,
        'Retrieval reads the index first, so these can never be found. Re-ingest the note behind each one.',
        this.report.unindexed
      );
    }

    const buttons = contentEl.createDiv({ cls: 'gemma4-ingest-buttons' });
    const close = buttons.createEl('button', { text: 'Close' });
    close.addEventListener('click', () => this.close());
    const apply = buttons.createEl('button', { cls: 'mod-cta' });
    const sync = () => {
      apply.setText(this.chosen.size ? `Run ${this.chosen.size} of these` : 'Nothing selected');
      apply.disabled = this.chosen.size === 0;
    };
    this.syncApply = sync;
    sync();
    apply.addEventListener('click', () => {
      const chosen = new Set(this.chosen);
      this.close();
      void this.onApply(chosen);
    });
  }

  private syncApply: () => void = () => {};

  private info(title: string, hint: string, items: string[]) {
    const sec = this.contentEl.createDiv({ cls: 'gemma4-lint-section' });
    sec.createDiv({ cls: 'gemma4-lint-section-title', text: title });
    sec.createDiv({ cls: 'gemma4-lint-hint', text: hint });
    const list = sec.createEl('ul', { cls: 'gemma4-lint-list' });
    for (const item of items) list.createEl('li', { text: item });
  }

  private finding(key: string, title: string, hint: string, items: string[], on: boolean) {
    const sec = this.contentEl.createDiv({ cls: 'gemma4-lint-section' });
    const head = sec.createDiv({ cls: 'gemma4-tidy-head' });
    const box = head.createEl('input', { type: 'checkbox' });
    box.checked = on;
    if (on) this.chosen.add(key);
    head.createSpan({ cls: 'gemma4-lint-section-title', text: title });
    box.addEventListener('change', () => {
      if (box.checked) this.chosen.add(key);
      else this.chosen.delete(key);
      this.syncApply();
    });
    sec.createDiv({ cls: 'gemma4-lint-hint', text: hint });
    if (items.length) {
      const list = sec.createEl('ul', { cls: 'gemma4-lint-list' });
      for (const item of items.slice(0, 8)) list.createEl('li', { text: item });
      if (items.length > 8) {
        sec.createDiv({ cls: 'gemma4-lint-hint', text: `…and ${items.length - 8} more.` });
      }
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
