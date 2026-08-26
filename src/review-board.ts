import { App, Modal, TFile } from 'obsidian';
import { contentHash, indexPath, logPath, wikiDir } from './wiki-store';

// Review board: turns "you should periodically review the wiki" from a
// vague chore into a concrete list. Model-free signals from page frontmatter
// — low self-rated confidence, source drift (the raw note changed since
// ingest, by source_hash), and staleness (old created date) — because the
// field research names an unreviewed, compounding wiki as the #1 failure
// mode ("second-brain graveyard") and hallucination-pollution as the #1 new
// risk. Best caught by a human eye on a short, prioritized list, not by more
// model calls.

export interface ReviewItem {
  path: string;
  title: string;
  confidence: string;
  ageDays: number | null;
  drifted: boolean;
  staleConcept: boolean;
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

export async function buildReviewBoard(app: App, staleDays: number): Promise<ReviewBoard> {
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

    // Source drift (issue #20): the raw note was edited after this page was
    // ingested, so the summary may now be out of date. This is a stronger,
    // more actionable signal than raw age ("re-ingest this one").
    let drifted = false;
    const srcPath = typeof fm?.source === 'string' ? fm.source : '';
    const srcHash = typeof fm?.source_hash === 'string' ? fm.source_hash : '';
    if (srcPath && srcHash) {
      const srcFile = app.vault.getAbstractFileByPath(srcPath);
      if (srcFile instanceof TFile) {
        const cur = await app.vault.read(srcFile);
        if (contentHash(cur) !== srcHash) {
          drifted = true;
          reasons.push('source changed since ingest');
        }
      }
    }

    // Stale concept overview (issue #60 ripple): membership changed after the
    // overview was written — ingest added a page or the pruner removed one —
    // so the prose no longer reflects ## Pages. Rebuilding the concept page
    // clears the flag.
    // Guarded on kind: the community frontmatter convention also puts
    // `stale` on ordinary wiki pages, and "rebuild this concept page" would
    // be the wrong instruction for one of those.
    const staleConcept = fm?.kind === 'concept' && fm?.stale === true;
    if (staleConcept) reasons.push('members changed — rebuild this concept page');

    if (ageDays !== null && ageDays >= staleDays) reasons.push(`${ageDays}d since ingest`);
    if (reasons.length) {
      items.push({ path: f.path, title: f.basename, confidence, ageDays, drifted, staleConcept, reasons });
    }
  }

  // Order by urgency: source drift and stale concept overviews first (both
  // actionable — re-ingest / rebuild), then low confidence, then medium,
  // then by age.
  const rank = (i: ReviewItem) =>
    i.drifted || i.staleConcept ? -1 : i.confidence === 'low' ? 0 : i.confidence === 'med' ? 1 : 2;
  items.sort((a, b) => rank(a) - rank(b) || (b.ageDays ?? 0) - (a.ageDays ?? 0));

  return { scanned: files.length, items };
}

export class ReviewBoardModal extends Modal {
  private board: ReviewBoard;
  private staleDays: number;

  constructor(app: App, board: ReviewBoard, staleDays: number) {
    super(app);
    this.board = board;
    this.staleDays = staleDays;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('gemma4-lint-modal');
    contentEl.createEl('h3', { text: 'Wiki review board' });
    contentEl.createDiv({
      cls: 'gemma4-lint-summary',
      text:
        `${this.board.items.length} of ${this.board.scanned} pages worth a look — low-confidence extractions, ` +
        `changed sources, concept overviews whose members changed, and pages untouched for ${this.staleDays}+ days.`,
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
    if (this.board.items.some((i) => i.staleConcept)) {
      contentEl.createDiv({
        cls: 'gemma4-lint-hint',
        text: 'Stale concept overviews: run "Build a concept page from a tag" on the same tag to rewrite the overview — that clears the flag.',
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
