import { App, Modal, TFile } from 'obsidian';
import { getIngestedSourceHashes, precheckNote, wikiDir } from './wiki-store';

// Semi-automatic ingest: the plugin does the tedious parts — finding new or
// changed notes, and drafting a summary card for each — but never writes
// without a human tick. The red line (see the design note in the vault) is
// "auto-generate yes, auto-write no": a wrong card must never reach the wiki
// and pollute later queries, so every draft passes through the batch review
// gate below. This module owns the deterministic scan + the review modal;
// the model calls that turn candidates into drafts stay in main.ts, which
// holds the engine.

export interface ScanOptions {
  // Notes modified within this many hours are skipped — you're probably
  // still editing them, and ingesting a half-written draft is worse than
  // waiting.
  quietHours: number;
  // Hard cap per scan so the first run on a large vault doesn't spin the
  // GPU through dozens of notes at once. Overflow is reported, not silently
  // dropped.
  maxPerRun: number;
  // Path prefixes to skip (templates, attachments, etc.). The wiki folder is
  // always excluded automatically.
  excludePrefixes: string[];
}

export interface ScanCandidate {
  file: TFile;
  reason: 'new' | 'changed';
}

export interface ScanResult {
  scanned: number;
  eligible: ScanCandidate[];
  // How many eligible notes were left out by maxPerRun this run.
  cappedOut: number;
}

// Deterministic, no model call. Walk the vault, drop the wiki folder and
// excluded paths, skip notes still inside their quiet period, then use the
// same precheck gate the manual ingest uses (empty / frontmatter-only /
// unchanged-by-hash) to keep only genuinely new or changed notes.
export async function findIngestCandidates(app: App, opts: ScanOptions): Promise<ScanResult> {
  const hashes = getIngestedSourceHashes(app);
  const wikiPrefix = `${wikiDir()}/`;
  const cutoff = Date.now() - opts.quietHours * 3_600_000;
  const excludes = opts.excludePrefixes.map((p) => p.trim()).filter(Boolean);

  let scanned = 0;
  const eligible: ScanCandidate[] = [];
  for (const f of app.vault.getMarkdownFiles()) {
    if (f.path.startsWith(wikiPrefix)) continue;
    if (excludes.some((p) => f.path === p || f.path.startsWith(p.endsWith('/') ? p : `${p}/`))) continue;
    scanned++;
    if (f.stat.mtime > cutoff) continue; // quiet period — likely mid-edit
    const existingHash = hashes.get(f.path);
    const content = await app.vault.read(f);
    if (precheckNote(content, existingHash) !== null) continue; // empty / fm-only / unchanged
    eligible.push({ file: f, reason: existingHash ? 'changed' : 'new' });
  }

  const cappedOut = Math.max(0, eligible.length - opts.maxPerRun);
  return { scanned, eligible: eligible.slice(0, opts.maxPerRun), cappedOut };
}

// A generated-but-not-written draft awaiting the human tick.
export interface IngestDraft {
  file: TFile;
  reason: 'new' | 'changed';
  pagePath: string;
  overwriting: boolean;
  pageContent: string; // the full markdown that will be written on approval
  summary: string;
  tags: string[];
  confidence: string; // 'high' | 'med' | 'low' | ''
}

const confRank = (c: string) => (c === 'low' ? 0 : c === 'med' ? 1 : 2);

// Batch review gate. One row per draft with a checkbox (checked by default);
// low-confidence drafts float to the top so the ones most likely to be wrong
// get the closest look. "Write selected" is the only path to disk.
export class AutoIngestReviewModal extends Modal {
  private drafts: IngestDraft[];
  private failed: number;
  private checked: boolean[];
  private onWrite: (approved: IngestDraft[]) => Promise<void>;

  constructor(
    app: App,
    drafts: IngestDraft[],
    failed: number,
    onWrite: (approved: IngestDraft[]) => Promise<void>
  ) {
    super(app);
    // Low confidence first — most in need of a human eye.
    this.drafts = [...drafts].sort((a, b) => confRank(a.confidence) - confRank(b.confidence));
    this.failed = failed;
    this.checked = this.drafts.map(() => true);
    this.onWrite = onWrite;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('gemma4-lint-modal');
    contentEl.createEl('h3', { text: 'Review drafts before they enter the wiki' });
    contentEl.createDiv({
      cls: 'gemma4-lint-summary',
      text:
        `${this.drafts.length} draft${this.drafts.length === 1 ? '' : 's'} generated` +
        (this.failed ? ` · ${this.failed} failed and were skipped` : '') +
        '. Untick anything that looks wrong, then write the rest. Nothing is saved until you do.',
    });

    const list = contentEl.createDiv({ cls: 'gemma4-review-list' });
    this.drafts.forEach((d, i) => {
      const row = list.createDiv({ cls: 'gemma4-draft-row' });

      const box = row.createEl('input', { type: 'checkbox' });
      box.checked = this.checked[i];
      box.addEventListener('change', () => {
        this.checked[i] = box.checked;
        updateWriteBtn();
      });

      const main = row.createDiv({ cls: 'gemma4-review-main' });
      const titleRow = main.createDiv({ cls: 'gemma4-review-titlerow' });
      const link = titleRow.createEl('a', { cls: 'gemma4-review-title', text: d.file.basename });
      link.addEventListener('click', (evt) => {
        evt.preventDefault();
        void this.app.workspace.openLinkText(d.file.path.replace(/\.md$/, ''), '', false);
      });
      titleRow.createSpan({
        cls: 'gemma4-review-reasons',
        text: [d.reason === 'changed' ? 'changed' : 'new', d.confidence ? `${d.confidence} confidence` : '', d.overwriting ? 'overwrites existing page' : ''].filter(Boolean).join(' · '),
      });
      main.createDiv({ cls: 'gemma4-review-summary', text: d.summary });
      if (d.tags.length) {
        main.createDiv({ cls: 'gemma4-review-tags', text: d.tags.map((t) => `#${t}`).join('  ') });
      }
    });

    const actions = contentEl.createDiv({ cls: 'gemma4-review-actions' });
    const allBtn = actions.createEl('button', { text: 'Toggle all' });
    allBtn.addEventListener('click', () => {
      const anyOff = this.checked.some((c) => !c);
      this.checked = this.checked.map(() => anyOff); // if any off → turn all on, else all off
      const boxes = list.querySelectorAll('input[type="checkbox"]');
      boxes.forEach((b, i) => ((b as HTMLInputElement).checked = this.checked[i]));
      updateWriteBtn();
    });

    const writeBtn = actions.createEl('button', { cls: 'mod-cta' });
    const updateWriteBtn = () => {
      const n = this.checked.filter(Boolean).length;
      writeBtn.setText(n ? `Write ${n} to wiki` : 'Nothing selected');
      writeBtn.disabled = n === 0;
    };
    updateWriteBtn();
    writeBtn.addEventListener('click', () => {
      const approved = this.drafts.filter((_, i) => this.checked[i]);
      this.close();
      void this.onWrite(approved);
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
