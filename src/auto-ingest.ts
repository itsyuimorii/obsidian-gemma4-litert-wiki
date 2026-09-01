import { App, Modal, TFile } from 'obsidian';
import { contentHash, getIngestedSourceHashes, getIngestedSourcePaths, precheckNote, wikiDir } from './wiki-store';

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
  // Allow-list: when non-empty, only notes under one of these path prefixes
  // are considered — scan never touches the rest of the vault. When omitted or
  // empty, the caller has decided scope some other way (the scan command guards
  // on an empty allow-list before calling; the badge falls back to whole-vault).
  includePrefixes?: string[];
}

export interface ScanCandidate {
  file: TFile;
  // 'refresh' = already ingested and unchanged, re-offered on explicit request.
  reason: 'new' | 'changed' | 'refresh';
}

export interface ScanResult {
  scanned: number;
  eligible: ScanCandidate[];
  // How many eligible notes were left out by maxPerRun this run.
  cappedOut: number;
  // How many notes the quiet period skipped (edited within quietHours).
  // Tracked so the caller can SAY so — a silent skip reads as "scan is
  // broken" to a user who just added notes (issue #41).
  skippedQuiet: number;
  // Notes in scope that are already ingested AND unchanged. Skipped by
  // default, but the caller can offer to re-ingest them — e.g. to regenerate
  // pages after the vocabulary or prompts changed.
  unchanged: TFile[];
}

// Deterministic, no model call. Walk the vault, drop the wiki folder and
// excluded paths, skip notes still inside their quiet period, then keep only
// genuinely new or changed notes.
//
// "Already in the wiki" is decided by getIngestedSourcePaths — the SAME
// signal that draws the "ingested" badge in the file tree — not by the hash
// map alone. The hash map only holds pages that stored a source_hash, so a
// page ingested before that field existed (or any page missing it) would
// otherwise look "new" and get re-offered forever. So: a note that already
// has a page is re-offered ONLY when a stored hash proves its content
// changed; with no hash to compare, we trust the badge and skip it. Better
// to occasionally miss a hash-less edit than to spam already-ingested notes.
export async function findIngestCandidates(app: App, opts: ScanOptions): Promise<ScanResult> {
  const ingested = getIngestedSourcePaths(app);
  const hashes = getIngestedSourceHashes(app);
  const wikiPrefix = `${wikiDir()}/`;
  const cutoff = Date.now() - opts.quietHours * 3_600_000;
  const norm = (p: string) => (p.endsWith('/') ? p : `${p}/`);
  const under = (path: string, prefix: string) => path === prefix || path.startsWith(norm(prefix));
  const excludes = opts.excludePrefixes.map((p) => p.trim()).filter(Boolean);
  const includes = (opts.includePrefixes ?? []).map((p) => p.trim()).filter(Boolean);

  let scanned = 0;
  let skippedQuiet = 0;
  const eligible: ScanCandidate[] = [];
  const unchanged: TFile[] = [];
  for (const f of app.vault.getMarkdownFiles()) {
    if (f.path.startsWith(wikiPrefix)) continue;
    // Allow-list (opt-in scope): if set, only notes under an allowed folder.
    if (includes.length && !includes.some((p) => under(f.path, p))) continue;
    if (excludes.some((p) => under(f.path, p))) continue;
    scanned++;
    if (f.stat.mtime > cutoff) {
      // Quiet period — likely mid-edit. Counted, not silent (issue #41).
      skippedQuiet++;
      continue;
    }
    const content = await app.vault.read(f);
    if (precheckNote(content, undefined) !== null) continue; // empty / frontmatter-only

    if (ingested.has(f.path)) {
      // Already has a wiki page. Re-offer only if a stored hash proves it changed.
      const h = hashes.get(f.path);
      if (h && contentHash(content) !== h) eligible.push({ file: f, reason: 'changed' });
      else unchanged.push(f);
      continue;
    }
    eligible.push({ file: f, reason: 'new' });
  }

  const cappedOut = Math.max(0, eligible.length - opts.maxPerRun);
  return { scanned, eligible: eligible.slice(0, opts.maxPerRun), cappedOut, skippedQuiet, unchanged };
}

// A generated-but-not-written draft awaiting the human tick.
export interface IngestDraft {
  file: TFile;
  reason: 'new' | 'changed' | 'refresh';
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
        text: [d.reason === 'refresh' ? 're-ingest' : d.reason, d.confidence ? `${d.confidence} confidence` : '', d.overwriting ? 'overwrites existing page' : ''].filter(Boolean).join(' · '),
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

/**
 * Which folders to scan — asked, not assumed.
 *
 * "Scan a folder into the wiki" used to scan whichever folders happened to be
 * typed into a settings field, and refuse outright when that field was blank
 * ("go to Settings and name a folder"). A command that names a folder in its
 * own title should ask you which one, and a first run should not bounce you
 * into a settings pane to answer a question the command could have asked.
 *
 * Counts are exact and free: the candidate sweep is deterministic — no model,
 * no GPU — so the dialog can tell you what each folder would actually cost
 * before you commit to it.
 */
// Derived from the README's measured figures, not guessed: warm decode holds
// ~29 tok/s and one note costs two calls.
const SECONDS_PER_NOTE = 20;

export class ScanFolderModal extends Modal {
  private chosen: Set<string>;
  private readonly folders: { path: string; count: number }[];
  private readonly totalCandidates: number;
  private readonly onConfirm: (prefixes: string[]) => void;
  private readonly onCancel: () => void;
  // Set before close() so onClose can tell "confirmed" from "dismissed".
  // Without it the caller had to guess from the outside, and guessed by
  // reading a flag that close() ran before anything could set.
  private confirmed = false;
  private countEl: HTMLElement | null = null;
  private goBtn: HTMLButtonElement | null = null;

  constructor(
    app: App,
    opts: {
      folders: { path: string; count: number }[];
      preselected: string[];
      onConfirm: (prefixes: string[]) => void;
      onCancel: () => void;
    }
  ) {
    super(app);
    this.folders = opts.folders;
    // Pre-ticked with whatever you scanned last, so the common case is one
    // click. The pick is remembered on confirm, without asking.
    this.chosen = new Set(opts.preselected);
    this.totalCandidates = opts.folders.reduce((n, f) => n + f.count, 0);
    this.onConfirm = opts.onConfirm;
    this.onCancel = opts.onCancel;
  }

  private selectedCount(): number {
    let n = 0;
    for (const f of this.folders) if (this.chosen.has(f.path)) n += f.count;
    return n;
  }

  /**
   * Say what the run costs, in notes and in minutes.
   *
   * This replaced a "max notes per scan" ceiling. That number existed because
   * you could not see how big a run was before starting it — so the plugin
   * quietly trimmed it and told you afterwards. Now the size is on screen
   * before you commit, and stopping keeps whatever was drafted, so the honest
   * move is to state the cost and let you decide rather than to decide for
   * you.
   *
   * The estimate is from real instrumentation: warm decode holds ~29 tok/s
   * (see Benchmarks in the README), and one note is two calls, so ~20s each.
   * Rounded up, and never claimed to be exact.
   */
  private syncFooter() {
    const n = this.selectedCount();
    if (this.countEl) {
      this.countEl.empty();
      if (this.chosen.size === 0) {
        this.countEl.setText('Pick at least one folder.');
      } else if (n === 0) {
        // Ticked, but everything in them is already filed and unchanged.
        // "0 notes … roughly 1 minute" was the arithmetic answering a
        // question nobody asked.
        this.countEl.setText('Nothing new in the folders you ticked — they are all already filed.');
      } else {
        const mins = Math.max(1, Math.round((n * SECONDS_PER_NOTE) / 60));
        this.countEl.createDiv({
          text: `${n} note${n === 1 ? '' : 's'}, about one model call each — roughly ${mins} minute${mins === 1 ? '' : 's'}.`,
        });
        this.countEl.createDiv({
          cls: 'gemma4-scan-count-sub',
          text: 'The first one is slower if the model has not loaded yet. You can stop partway and still review what was drafted.',
        });
      }
    }
    if (this.goBtn) {
      this.goBtn.disabled = n === 0;
      this.goBtn.setText(n === 0 ? 'Scan' : `Scan ${n} note${n === 1 ? '' : 's'}`);
    }
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('gemma4-scan-modal');
    contentEl.createEl('h3', { text: 'Scan a folder into the wiki' });
    contentEl.createDiv({
      cls: 'gemma4-scan-lede',
      // This explanation used to sit in the chat panel's empty state, where it
      // was read by someone who had not yet decided to scan anything. It reads
      // better here, above the folder list, at the moment the decision is
      // actually in front of you.
      text:
        'Sweeps the folders you pick for new or changed notes and drafts a page for each. ' +
        'One model call per note, so it takes a while — you can close this and keep working; ' +
        'progress runs in the status bar, and the review list waits for you there if you moved ' +
        'on. Nothing is ever written without your tick.',
    });
    // Name the other door. This dialog is the batch, and the single-note path
    // is a command with a different name — someone who found this one has no
    // reason to guess that "Ingest this note into wiki" is the same job for
    // one file.
    contentEl.createDiv({
      cls: 'gemma4-scan-lede gemma4-scan-lede-aside',
      text:
        'This is the batch. For just the note you have open, close this and press Cmd/Ctrl+P → ' +
        '"Ingest this note into wiki".',
    });

    if (!this.folders.length) {
      contentEl.createDiv({
        cls: 'gemma4-scan-empty',
        text:
          this.totalCandidates === 0
            ? 'Nothing new to file — every note outside the wiki is already ingested and unchanged.'
            : 'No folders found to scan.',
      });
      const only = contentEl.createDiv({ cls: 'gemma4-scan-buttons' });
      only.createEl('button', { text: 'Close' }).addEventListener('click', () => this.close());
      return;
    }

    const list = contentEl.createDiv({ cls: 'gemma4-scan-list' });
    for (const f of this.folders) {
      const row = list.createEl('label', { cls: 'gemma4-scan-row' });
      const box = row.createEl('input', { type: 'checkbox' });
      box.checked = this.chosen.has(f.path);
      box.addEventListener('change', () => {
        if (box.checked) this.chosen.add(f.path);
        else this.chosen.delete(f.path);
        this.syncFooter();
      });
      row.createSpan({ cls: 'gemma4-scan-row-path', text: f.path });
      row.createSpan({
        cls: 'gemma4-scan-row-count',
        text: f.count === 0 ? 'nothing new' : `${f.count} new or changed`,
      });
    }

    this.countEl = contentEl.createDiv({ cls: 'gemma4-scan-count' });

    const buttons = contentEl.createDiv({ cls: 'gemma4-scan-buttons' });
    buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    this.goBtn = buttons.createEl('button', { cls: 'mod-cta', text: 'Scan' });
    this.goBtn.addEventListener('click', () => {
      // Mark the outcome BEFORE closing. close() runs onClose synchronously,
      // and onClose is what reports a dismissal — so anything set afterwards
      // is set too late. This exact ordering silently cancelled every scan:
      // the caller saw "dismissed", returned, and nothing ran, with no error
      // and no notification to say so.
      this.confirmed = true;
      const prefixes = [...this.chosen];
      this.close();
      this.onConfirm(prefixes);
    });
    this.syncFooter();
  }

  onClose() {
    this.contentEl.empty();
    if (!this.confirmed) this.onCancel();
  }
}
