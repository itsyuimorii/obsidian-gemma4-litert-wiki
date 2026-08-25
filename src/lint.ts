import { App, Modal } from 'obsidian';
import { indexPath, logPath, wikiDir, readIndexEntries } from './wiki-store';

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
    .filter((f) => f.path.startsWith(`${wikiDir()}/`) && f.path !== indexPath() && f.path !== logPath());
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

export class LintReportModal extends Modal {
  private report: LintReport;

  constructor(app: App, report: LintReport) {
    super(app);
    this.report = report;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('gemma4-lint-modal');
    contentEl.createEl('h3', { text: 'Wiki lint report' });
    contentEl.createDiv({
      cls: 'gemma4-lint-summary',
      text: `${this.report.pageCount} wiki pages checked.`,
    });

    this.section(
      'Orphan pages',
      'No inbound links from any other wiki page. Consider adding Related links, or re-ingesting nearby notes.',
      this.report.orphans
    );
    this.section(
      'Index entries pointing to missing files',
      'Listed in index.md but the page file does not exist.',
      this.report.missing
    );
    this.section(
      'Pages missing from the index',
      'Page files that have no index.md entry, so Wiki chat cannot find them.',
      this.report.unindexed
    );
  }

  private section(title: string, hint: string, items: string[]) {
    const sec = this.contentEl.createDiv({ cls: 'gemma4-lint-section' });
    sec.createDiv({ cls: 'gemma4-lint-section-title', text: `${title} (${items.length})` });
    if (!items.length) {
      sec.createDiv({ cls: 'gemma4-lint-ok', text: 'None.' });
      return;
    }
    sec.createDiv({ cls: 'gemma4-lint-hint', text: hint });
    const list = sec.createEl('ul', { cls: 'gemma4-lint-list' });
    for (const item of items) list.createEl('li', { text: item });
  }

  onClose() {
    this.contentEl.empty();
  }
}
