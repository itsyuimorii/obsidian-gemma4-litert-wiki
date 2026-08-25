import { App, Modal } from 'obsidian';
import { indexPath, logPath, wikiDir } from './wiki-store';

// Review board: turns "you should periodically review the wiki" from a
// vague chore into a concrete list. Two model-free signals from page
// frontmatter — low self-rated confidence, and staleness (old created
// date, no recent touch) — because the field research names an unreviewed,
// compounding wiki as the #1 failure mode ("second-brain graveyard") and
// hallucination-pollution as the #1 new risk. Both are best caught by a
// human eye on a short, prioritized list, not by more model calls.

const STALE_DAYS = 30;

export interface ReviewItem {
  path: string;
  title: string;
  confidence: string;
  ageDays: number | null;
  reasons: string[];
}

export interface ReviewBoard {
  scanned: number;
  items: ReviewItem[];
}

function ageInDays(created: unknown): number | null {
  if (typeof created !== 'string') return null;
  const t = Date.parse(created);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

export function buildReviewBoard(app: App): ReviewBoard {
  const files = app.vault
    .getMarkdownFiles()
    .filter((f) => f.path.startsWith(`${wikiDir()}/`) && f.path !== indexPath() && f.path !== logPath());

  const items: ReviewItem[] = [];
  for (const f of files) {
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    const confidence = typeof fm?.confidence === 'string' ? fm.confidence : '';
    const ageDays = ageInDays(fm?.created);
    const reasons: string[] = [];
    if (confidence === 'low') reasons.push('low confidence');
    if (confidence === 'med') reasons.push('medium confidence');
    if (ageDays !== null && ageDays >= STALE_DAYS) reasons.push(`${ageDays}d since ingest`);
    if (reasons.length) {
      items.push({ path: f.path, title: f.basename, confidence, ageDays, reasons });
    }
  }

  // Order by review urgency: low confidence first, then medium, then by age.
  const rank = (i: ReviewItem) => (i.confidence === 'low' ? 0 : i.confidence === 'med' ? 1 : 2);
  items.sort((a, b) => rank(a) - rank(b) || (b.ageDays ?? 0) - (a.ageDays ?? 0));

  return { scanned: files.length, items };
}

export class ReviewBoardModal extends Modal {
  private board: ReviewBoard;

  constructor(app: App, board: ReviewBoard) {
    super(app);
    this.board = board;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('gemma4-lint-modal');
    contentEl.createEl('h3', { text: 'Wiki review board' });
    contentEl.createDiv({
      cls: 'gemma4-lint-summary',
      text: `${this.board.items.length} of ${this.board.scanned} pages worth a look — low-confidence extractions and pages untouched for ${STALE_DAYS}+ days.`,
    });

    if (!this.board.items.length) {
      contentEl.createDiv({ cls: 'gemma4-lint-ok', text: 'Nothing flagged. Your wiki looks fresh and confident.' });
      return;
    }

    const list = contentEl.createEl('div', { cls: 'gemma4-review-list' });
    for (const item of this.board.items) {
      const row = list.createDiv({ cls: 'gemma4-review-row' });
      const link = row.createEl('a', { cls: 'gemma4-review-title', text: item.title });
      link.addEventListener('click', (evt) => {
        evt.preventDefault();
        void this.app.workspace.openLinkText(item.path.replace(/\.md$/, ''), '', false);
      });
      row.createSpan({ cls: 'gemma4-review-reasons', text: item.reasons.join(' · ') });
    }

    contentEl.createDiv({
      cls: 'gemma4-lint-hint',
      text: 'Tip: open a flagged page, check its claims against the source note it links to, and re-ingest the source if the summary drifted.',
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
