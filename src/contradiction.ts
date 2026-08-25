import { App, Modal, TFile } from 'obsidian';
import { readIndexEntries, wikiDir } from './wiki-store';

// Lint v2 (issue #5): contradiction candidates. Unlike Lint v1 (graph facts,
// no model), this needs the model to judge whether two pages state
// incompatible things. Two guards keep it honest and cheap:
//  1. Flag-only — it never edits anything; a wrong flag is just ignored,
//     same fault-tolerance as the related-links picker.
//  2. Bounded — only pages that share a tag are paired (a note about ETFs
//     and a note about TCP can't contradict), and the pair count is capped,
//     so an O(n^2) model sweep can't run away on a big wiki.

export interface WikiPageMeta {
  linkPath: string;
  title: string;
  summary: string;
  tags: string[];
  // Page file mtime — pair ordering checks recently-changed pages first.
  mtime: number;
}

export interface PagePair {
  a: WikiPageMeta;
  b: WikiPageMeta;
}

export interface ContradictionFlag {
  a: WikiPageMeta;
  b: WikiPageMeta;
  reason: string;
}

function normalizeTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((t) => String(t).toLowerCase());
  if (typeof raw === 'string') return raw.split(/[,\s]+/).filter(Boolean).map((t) => t.toLowerCase());
  return [];
}

// Wiki pages with their index summary (one line each) and frontmatter tags.
export async function collectWikiPages(app: App): Promise<WikiPageMeta[]> {
  const entries = await readIndexEntries(app.vault);
  const pages: WikiPageMeta[] = [];
  for (const e of entries) {
    const file = app.vault.getAbstractFileByPath(`${e.linkPath}.md`);
    if (!(file instanceof TFile)) continue;
    if (!file.path.startsWith(`${wikiDir()}/`)) continue;
    const tags = normalizeTags(app.metadataCache.getFileCache(file)?.frontmatter?.tags);
    pages.push({ linkPath: e.linkPath, title: e.title, summary: e.summary, tags, mtime: file.stat.mtime });
  }
  return pages;
}

// Pairs of pages sharing at least one tag, capped, ORDERED BY CHURN: the pair
// whose fresher page changed most recently is checked first. The old
// deterministic index order re-checked the same oldest pairs on every run —
// with 65 qualifying pairs and a cap of 12, a freshly ingested pair ranked
// #39 was never judged, run after run (issue #56). Recency puts new and
// edited pages at the front, which is also where contradictions appear.
// Returns the pairs to check (capped) AND how many qualified in total, so the
// caller can say how many were left out. Stopping at the cap without counting
// made truncation invisible: "0 flagged" then reads as "your wiki is
// consistent" even when most pairs were never looked at.
export function pairsSharingTag(
  pages: WikiPageMeta[],
  cap: number
): { pairs: PagePair[]; total: number } {
  const pairs: PagePair[] = [];
  let total = 0;
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      const shared = pages[i].tags.some((t) => t && pages[j].tags.includes(t));
      if (!shared) continue;
      total++;
      pairs.push({ a: pages[i], b: pages[j] });
    }
  }
  pairs.sort((x, y) => Math.max(y.a.mtime, y.b.mtime) - Math.max(x.a.mtime, x.b.mtime));
  return { pairs: pairs.slice(0, cap), total };
}

export class ContradictionReportModal extends Modal {
  private flags: ContradictionFlag[];
  private checked: number;
  private total: number;

  constructor(app: App, flags: ContradictionFlag[], checked: number, total: number) {
    super(app);
    this.flags = flags;
    this.checked = checked;
    this.total = total;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('gemma4-lint-modal');
    contentEl.createEl('h3', { text: 'Contradiction candidates' });
    contentEl.createDiv({
      cls: 'gemma4-lint-summary',
      // The coverage fraction lives HERE, in the report the user reads — a
      // transient toast is not where "53 pairs were never looked at" belongs.
      text:
        `Checked ${this.checked} of ${this.total} tag-sharing page pair${this.total === 1 ? '' : 's'}` +
        `${this.total > this.checked ? ' (most recently changed first; run again after edits to rotate coverage)' : ''}. ` +
        `${this.flags.length} flagged for a human look — these are candidates, not verdicts.`,
    });

    if (!this.flags.length) {
      contentEl.createDiv({ cls: 'gemma4-lint-ok', text: 'No contradictions flagged.' });
      return;
    }

    const list = contentEl.createDiv({ cls: 'gemma4-review-list' });
    for (const f of this.flags) {
      const row = list.createDiv({ cls: 'gemma4-lint-section' });
      const titles = row.createDiv({ cls: 'gemma4-review-titlerow' });
      for (const p of [f.a, f.b]) {
        const link = titles.createEl('a', { cls: 'gemma4-review-title', text: p.title });
        link.addEventListener('click', (evt) => {
          evt.preventDefault();
          void this.app.workspace.openLinkText(p.linkPath, '', false);
        });
      }
      row.createDiv({ cls: 'gemma4-review-summary', text: f.reason });
    }

    contentEl.createDiv({
      cls: 'gemma4-lint-hint',
      text: 'Open both pages, check them against their source notes, and re-ingest whichever drifted. Nothing was changed.',
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
