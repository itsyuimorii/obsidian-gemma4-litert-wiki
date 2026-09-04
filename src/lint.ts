import { App, Modal } from 'obsidian';
import { indexPath, isWikiPage, logPath, wikiDir, readIndexEntries } from './wiki-store';

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
  private onApply: (chosen: Set<string>) => Promise<void>;
  private chosen = new Set<string>();

  constructor(
    app: App,
    report: LintReport,
    tags: TagHealth,
    onApply: (chosen: Set<string>) => Promise<void>
  ) {
    super(app);
    this.report = report;
    this.tags = tags;
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

    // Free, and almost always right: a link that exists in one direction is a
    // relationship, so the page it points at should say so too.
    if (this.report.orphans.length) {
      this.finding(
        'relink',
        `${this.report.orphans.length} page${this.report.orphans.length === 1 ? '' : 's'} with no inbound link`,
        'Make existing links mutual, and ask the model for pages that have no Related section at all. ' +
          'A page that genuinely relates to nothing stays an orphan.',
        this.report.orphans,
        true
      );
    } else {
      this.ok('Every page has an inbound link.');
    }

    if (this.report.missing.length) {
      this.finding(
        'reconcile',
        `${this.report.missing.length} index entr${this.report.missing.length === 1 ? 'y' : 'ies'} pointing at deleted pages`,
        'Drop them from the index, and remove links pointing at them. No model, nothing to review.',
        this.report.missing,
        true
      );
    }

    if (this.report.unindexed.length) {
      this.info(
        `${this.report.unindexed.length} page${this.report.unindexed.length === 1 ? '' : 's'} missing from the index`,
        'Retrieval reads the index first, so these can never be found. Re-ingest the note behind each one.',
        this.report.unindexed
      );
    }

    // The signal is an empty vocabulary, not a long pending list: with nothing
    // to reuse, every ingest coins its own tag and the near-duplicates pile up.
    const t = this.tags;
    if (!t.vocabulary && t.inUse) {
      this.finding(
        'tags',
        `No tag vocabulary yet — ${t.inUse} different tags in use, ${t.pending} waiting`,
        'Ingest has nothing to reuse, so every note coins its own. Fold them into one vocabulary and ' +
          'apply it to existing pages. Two model calls, one preview each.',
        t.clusters.map((g) => g.join('  ·  ')),
        true
      );
    } else if (t.clusters.length) {
      this.finding(
        'tags',
        `${t.clusters.length} group${t.clusters.length === 1 ? '' : 's'} of tags look like the same idea`,
        'Rebuild the vocabulary from the tags in use and apply it. Two model calls, one preview each.',
        t.clusters.map((g) => g.join('  ·  ')),
        false
      );
    } else if (t.vocabulary) {
      this.ok(`Vocabulary of ${t.vocabulary} tags, no obvious duplicates.`);
    }

    const buttons = contentEl.createDiv({ cls: 'gemma4-ingest-buttons' });
    const close = buttons.createEl('button', { text: 'Close' });
    close.addEventListener('click', () => this.close());
    const apply = buttons.createEl('button', { cls: 'mod-cta' });
    const sync = () => {
      apply.setText(this.chosen.size ? `Fix ${this.chosen.size} of these` : 'Nothing selected');
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

  private ok(text: string) {
    this.contentEl.createDiv({ cls: 'gemma4-lint-ok', text });
  }

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
