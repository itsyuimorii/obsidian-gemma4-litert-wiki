import { App, Modal, TFile } from 'obsidian';
import { cardGrounding, mostSuspect } from './pure';
import { fmOf, wikiDir } from './wiki-store';

// Lint v2b (issue #21): provenance spot-check. Ingest can hallucinate a key
// point the source note never made. This samples a few pages and asks the
// model, per page, which of its key points the SOURCE note does not actually
// support — catching drift between a page and the note it claims to summarize.
// Flag-only and bounded (sample a handful of pages, one model call each).
//
// Which handful is decided without the model (#159): every card is matched
// against its source note, and the pages whose mentions and key points are
// least borne out go first. The model is the slow, careful reader; matching
// is what tells it where to look.

export interface ProvenanceSample {
  linkPath: string;
  title: string;
  sourcePath: string;
  keyPoints: string[];
  /** Mentions on the card that occur nowhere in the source note. A fact, not a guess. */
  missingMentions: string[];
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

// The `limit` wiki pages most worth checking: those with a source note that
// still exists and parseable key points, least borne out by that note first.
export async function sampleWikiPages(app: App, limit: number): Promise<ProvenanceSample[]> {
  const all: (ProvenanceSample & { suspicion: number })[] = [];
  for (const f of app.vault.getMarkdownFiles()) {
    if (!f.path.startsWith(`${wikiDir()}/`)) continue;
    const fm = fmOf(app, f);
    const src = fm?.source;
    if (typeof src !== 'string' || !src) continue;
    // A page whose note is gone cannot be checked; it used to take one of
    // the eight places and then be skipped.
    const srcFile = app.vault.getAbstractFileByPath(src);
    if (!(srcFile instanceof TFile)) continue;
    const keyPoints = parseKeyPoints(await app.vault.read(f));
    if (!keyPoints.length) continue;
    const mentions = Array.isArray(fm?.mentions) ? fm.mentions.map((m) => String(m)) : [];
    const grounding = cardGrounding({ keyPoints, mentions }, await app.vault.cachedRead(srcFile), srcFile.basename);
    all.push({
      linkPath: f.path.replace(/\.md$/, ''),
      title: f.basename,
      sourcePath: src,
      keyPoints,
      missingMentions: grounding.missingMentions,
      suspicion: grounding.suspicion,
    });
  }
  return mostSuspect(all, limit).map(({ suspicion: _suspicion, ...sample }) => sample);
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
      text:
        `Checked ${this.checked} page${this.checked === 1 ? '' : 's'}, the ones whose source note bears them out least. ` +
        `${this.flags.length} have key points or mentions the note may not support — candidates to re-ingest, not verdicts.`,
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
