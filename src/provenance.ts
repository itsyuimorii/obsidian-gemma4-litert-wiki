import { App, Modal, TFile } from 'obsidian';
import { t, tn } from './i18n';
import { cardGrounding, pickForSpotCheck, rankedPlaces } from './pure';
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
// is what tells it where to look. Not where never to look: some places go to
// pages drawn at random, or the lowest-scoring ones are never read (#168).

export interface ProvenanceSample {
  linkPath: string;
  title: string;
  sourcePath: string;
  keyPoints: string[];
  /** Mentions on the card that occur nowhere in the source note. A fact, not a guess. */
  missingMentions: string[];
  /** Chosen for scoring among the least borne out, or drawn at random (#168). */
  picked: 'ranked' | 'drawn';
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
  const all: (Omit<ProvenanceSample, 'picked'> & { suspicion: number })[] = [];
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
  const chosen = pickForSpotCheck(all, limit);
  const ranked = rankedPlaces(chosen.length);
  return chosen.map(({ suspicion: _suspicion, ...sample }, i) => ({
    ...sample,
    picked: i < ranked ? 'ranked' : 'drawn',
  }));
}

export class ProvenanceReportModal extends Modal {
  private flags: ProvenanceFlag[];
  private checked: number;
  private unchecked: number;
  private samples: ProvenanceSample[];

  constructor(app: App, flags: ProvenanceFlag[], checked: number, unchecked = 0, samples: ProvenanceSample[] = []) {
    super(app);
    this.flags = flags;
    this.checked = checked;
    this.unchecked = unchecked;
    this.samples = samples;
  }

  /**
   * Which pages this run read, and why each one. Without it a clean report
   * cannot be told apart from one that read the same pages as last time, and
   * the draw that reaches every page in turn (#168) is invisible.
   */
  private renderSampled(parent: HTMLElement) {
    if (!this.samples.length) return;
    const details = parent.createEl('details', { cls: 'gemma4-lint-sampled' });
    details.createEl('summary', { text: t('modal.prov.read', { n: this.samples.length }) });
    const ul = details.createEl('ul', { cls: 'gemma4-lint-list' });
    for (const s of this.samples) {
      const li = ul.createEl('li');
      const link = li.createEl('a', { text: s.title });
      link.addEventListener('click', (evt) => {
        evt.preventDefault();
        void this.app.workspace.openLinkText(s.linkPath, '', false);
      });
      li.appendText(t(s.picked === 'ranked' ? 'modal.prov.ranked' : 'modal.prov.drawn'));
    }
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('gemma4-lint-modal');
    contentEl.createEl('h3', { text: t('modal.prov.title') });
    contentEl.createDiv({
      cls: 'gemma4-lint-summary',
      text: tn('modal.prov.summary', this.checked, { flagged: this.flags.length }),
    });

    // A page the model could not be read on is not a page that passed. Saying
    // so is the difference between "all clean" and "all clean, of the ones I
    // managed to check".
    if (this.unchecked) {
      contentEl.createDiv({
        cls: 'gemma4-lint-hint',
        text: tn('modal.prov.unchecked', this.unchecked),
      });
    }

    this.renderSampled(contentEl);

    if (!this.flags.length) {
      contentEl.createDiv({
        cls: 'gemma4-lint-ok',
        text: this.checked
          ? t('modal.prov.clean')
          : t('modal.prov.noneChecked'),
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
      text: t('modal.prov.hint'),
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
