import { App, Modal } from 'obsidian';
import { fmOf, wikiDir } from './wiki-store';

// Lint v2b (issue #21): provenance spot-check. Ingest can hallucinate a key
// point the source note never made. This samples a few pages and asks the
// model, per page, which of its key points the SOURCE note does not actually
// support — catching drift between a page and the note it claims to summarize.
// Flag-only and bounded (sample a handful of pages, one model call each).

export interface ProvenanceSample {
  linkPath: string;
  title: string;
  sourcePath: string;
  keyPoints: string[];
}

export interface ProvenanceFlag {
  linkPath: string;
  title: string;
  sourcePath: string;
  unsupported: string[];
}

// Pull the "- " bullets under the page's "## Key points" heading, stopping at
// the next heading.
function parseKeyPoints(body: string): string[] {
  const idx = body.indexOf('## Key points');
  if (idx === -1) return [];
  const after = body.slice(idx + '## Key points'.length);
  const stop = after.search(/\n## /);
  const section = stop === -1 ? after : after.slice(0, stop);
  return section
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);
}

// Wiki pages that have a source note and parseable key points, up to `limit`.
export async function sampleWikiPages(app: App, limit: number): Promise<ProvenanceSample[]> {
  const out: ProvenanceSample[] = [];
  for (const f of app.vault.getMarkdownFiles()) {
    if (!f.path.startsWith(`${wikiDir()}/`)) continue;
    const src = fmOf(app, f)?.source;
    if (typeof src !== 'string' || !src) continue;
    const keyPoints = parseKeyPoints(await app.vault.read(f));
    if (!keyPoints.length) continue;
    out.push({ linkPath: f.path.replace(/\.md$/, ''), title: f.basename, sourcePath: src, keyPoints });
    if (out.length >= limit) break;
  }
  return out;
}

export class ProvenanceReportModal extends Modal {
  private flags: ProvenanceFlag[];
  private checked: number;
  private unchecked: number;

  constructor(app: App, flags: ProvenanceFlag[], checked: number, unchecked = 0) {
    super(app);
    this.flags = flags;
    this.checked = checked;
    this.unchecked = unchecked;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('gemma4-lint-modal');
    contentEl.createEl('h3', { text: 'Provenance spot-check' });
    contentEl.createDiv({
      cls: 'gemma4-lint-summary',
      text: `Checked ${this.checked} page${this.checked === 1 ? '' : 's'}. ${this.flags.length} have key points the source note may not support — candidates to re-ingest, not verdicts.`,
    });

    // A page the model could not be read on is not a page that passed. Saying
    // so is the difference between "all clean" and "all clean, of the ones I
    // managed to check".
    if (this.unchecked) {
      contentEl.createDiv({
        cls: 'gemma4-lint-hint',
        text:
          `${this.unchecked} page${this.unchecked === 1 ? '' : 's'} could not be checked — the model's ` +
          'reply was unusable or ran out of room. Those pages were not verified; run the check again to retry them.',
      });
    }

    if (!this.flags.length) {
      contentEl.createDiv({
        cls: 'gemma4-lint-ok',
        text: this.checked
          ? 'No unsupported key points found in the pages that were checked.'
          : 'No page could be checked.',
      });
      return;
    }

    const list = contentEl.createDiv({ cls: 'gemma4-review-list' });
    for (const f of this.flags) {
      const row = list.createDiv({ cls: 'gemma4-lint-section' });
      const link = row.createEl('a', { cls: 'gemma4-review-title', text: f.title });
      link.addEventListener('click', (evt) => {
        evt.preventDefault();
        void this.app.workspace.openLinkText(f.linkPath, '', false);
      });
      const ul = row.createEl('ul', { cls: 'gemma4-lint-list' });
      for (const u of f.unsupported) ul.createEl('li', { text: u });
    }

    contentEl.createDiv({
      cls: 'gemma4-lint-hint',
      text: 'Open the page, check each flagged point against its source note, and re-ingest if the summary drifted. Nothing was changed.',
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
