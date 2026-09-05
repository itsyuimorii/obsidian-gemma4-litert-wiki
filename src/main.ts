import { addIcon, App, FileSystemAdapter, FuzzySuggestModal, MarkdownView, Notice, Plugin, setIcon, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import { fs, http, path, type Bytes, type HttpServer } from './node-api';
import type { Engine } from '@litert-lm/core';
import { ChatView, VIEW_TYPE_CHAT } from './chat-view';
import { DURATION, failureText, logNotice, mark, notify, notifyAndLog, Progress, type NoticeKind } from './notify';
import { ConfirmModal, IngestPreviewModal, ScaffoldCreatedModal, OnboardingModal, RelinkPreviewModal, SuggestTagsLinksModal, type RelinkProposal } from './ingest-modal';
import { getModelBlob, isModelDownloaded, partialBytes, tryMigrateLegacyCache } from './model-store';
import { ensureCommonJsMarker, ensureRuntimeFile, isRuntimeFile } from './wasm-store';
import { setWasmScriptResolver } from './wasm-loader';
import {
  appendLog,
  buildConceptPage,
  buildSchemaFile,
  buildWikiPage,
  conceptPagePath,
  ensureSkillsScaffold,
  ensureWikiScaffold,
  fmOf,
  isWikiPage,
  wikiScaffoldPaths,
  indexPath,
  readSchema,
  schemaPath,
  upsertIndexEntry,
  clampToTokens,
  cleanClippedMarkdown,
  contentHash,
  getIngestedSourceHashes,
  getIngestedSourcePaths,
  precheckNote,
  queuePendingTags,
  readIndexEntries,
  slugify,
  setWikiDir,
  wikiAnswersDir,
  wikiDir,
  cardPathFor,
  writeWikiPage,
  type IndexEntry,
  type NoteExtraction,
} from './wiki-store';
import { findSameSubject, runLint, TidyModal, type TagHealth } from './lint';
import type { DuplicatePair } from './pure';
import {
  collectWikiPages,
  ContradictionReportModal,
  pairsSharingTag,
  type ContradictionFlag,
  type WikiPageMeta,
} from './contradiction';
import {
  ProvenanceReportModal,
  sampleWikiPages,
  type ProvenanceFlag,
} from './provenance';
import { buildReviewBoard, ReviewBoardModal } from './review-board';
import { AutoIngestReviewModal, findIngestCandidates, ScanFolderModal, type IngestDraft } from './auto-ingest';
import { GemmaWikiSettingTab, DEFAULT_SETTINGS, type GemmaWikiSettings } from './settings';
import { chunkForImprove, estimateImproveTokens } from './pure';
import {
  looksCutOff,
  looksRepetitive,
  nextOutputCap,
  parseModelJson,
  textOf,
  type ParseFailure,
} from './model-output';

/** The output budget one extraction starts with. A card is a small object. */
const INGEST_OUTPUT_TOKENS = 768;

/** What a provenance check on one page produced, including the ways it can fail. */
type ProvenanceCheck = { ok: true; unsupported: string[] } | { ok: false; reason: string };

// Throwaway spike plugin. v0.0.1-2 proved WebGPU + the LiteRT-LM WASM
// runtime can load inside Obsidian's Electron renderer with zero external
// processes. v0.0.3 (this file) is V1: actually download the 2.97 GB
// Gemma 4 E4B model, run a real generation, and measure whether it's fast
// enough / accurate enough to be useful — using "fix grammar of selected
// text" as the first real task, since it's single-turn, needs no wiki
// context, and matches the model-friendly pattern obsidian-local-gpt uses.
//
// v0.0.2 fixes still apply: wasm served over a loopback HTTP server
// (file:// script tags are blocked by Electron), and self.Module.locateFile
// pre-seeded (Obsidian's Node-integrated renderer makes `typeof __filename`
// true inside litertlm_wasm_internal.js, which hijacks its own
// scriptDirectory auto-detection).

const MIME: Record<string, string> = {
  '.js': 'application/javascript',
  '.wasm': 'application/wasm',
};

const MODEL_URL =
  'https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it-web.litertlm';

// Replaced with the build time by build.js. If this literal survives into
// main.js, the bundle was produced without the stamping step.
declare const BUILD_STAMP: string;

// Scans are no longer trimmed to a hidden ceiling: the dialog states the size
// and the rough time before you commit, and stopping mid-run keeps whatever
// was drafted. findIngestCandidates still wants a number.
const NO_SCAN_CAP = Number.MAX_SAFE_INTEGER;

// One debug channel, off unless Developer commands is on. Twenty-one log lines
// in someone's console is noise from a plugin they installed to read notes, and
// the setting already means "I am debugging this". Module-level so a helper can
// log without holding the plugin; set once on load, which means anything before
// settings load is silent — the correct meaning of quiet by default.
let debugLogging = false;
export function setDebugLogging(on: boolean) {
  debugLogging = on;
}
function log(...args: unknown[]) {
  if (debugLogging) console.log('[gemma-litert-wiki]', ...args);
}

async function checkWebGPU(): Promise<{ ok: boolean; detail: string }> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
    return { ok: false, detail: 'navigator.gpu is not present in this Obsidian build.' };
  }
  try {
    const gpu = (navigator as unknown as { gpu: { requestAdapter: () => Promise<unknown> } }).gpu;
    const adapter = (await gpu.requestAdapter()) as { info?: Record<string, unknown> } | null;
    if (!adapter) {
      return { ok: false, detail: 'requestAdapter() resolved to null — interface exists but no usable GPU adapter.' };
    }
    const info = adapter.info ?? {};
    return { ok: true, detail: `Adapter found. ${JSON.stringify(info)}` };
  } catch (err) {
    return { ok: false, detail: `requestAdapter() threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// Model download/caching moved to src/model-store.ts (resumable, on-disk).


// Tag picker for concept-page building (issue #19): only tags shared by two
// or more pages are offered, since a concept page over a single page is
// pointless.
interface TagCluster {
  tag: string;
  members: IndexEntry[];
}
class ConceptTagModal extends FuzzySuggestModal<TagCluster> {
  private clusters: TagCluster[];
  private onPick: (c: TagCluster) => void;

  constructor(app: App, clusters: TagCluster[], onPick: (c: TagCluster) => void) {
    super(app);
    this.clusters = clusters;
    this.onPick = onPick;
    this.setPlaceholder('Pick a tag to build a concept page for…');
  }
  getItems(): TagCluster[] {
    return this.clusters;
  }
  getItemText(c: TagCluster): string {
    return `${c.tag}  (${c.members.length} pages)`;
  }
  onChooseItem(c: TagCluster): void {
    this.onPick(c);
  }
}

export default class LiteRtSpikePlugin extends Plugin {
  private server: HttpServer | null = null;
  private serverBaseUrl: string | null = null;
  /** The directory the loopback server serves — also where the glue is required from. */
  private wasmDir: string | null = null;
  private wasmLoadPromise: Promise<void> | null = null;
  private enginePromise: Promise<Engine> | null = null;
  // What the engine actually granted, read back from LiteRT-LM after
  // Engine.create — not what we asked for. null until the model loads.
  private effectiveContextTokens: number | null = null;
  private scanStatusEl: HTMLElement | null = null;
  // What is running right now, if anything — the status bar's first duty.
  private runningText: string | null = null;
  // A finished run whose dialog is waiting for you to ask for it.
  // How many notes the background count last found worth reviewing.
  private reviewCount = 0;
  // Did attention leave while the current run was going? Decides whether the
  // result opens itself or waits.
  private chatBusy = false;
  private runStartedAt = 0;
  // The pinned toast for the running operation, and whether the user closed
  // it. A dismissal is respected until they ask for it back.
  private statusNotice: Notice | null = null;
  private runDismissed = false;
  private tickId: number | null = null;
  private autoScanIntervalId: number | null = null;
  settings: GemmaWikiSettings = { ...DEFAULT_SETTINGS };

  // ---------------------------------------------------------------------
  // Where a running operation lives.
  //
  // It used to be a Notice pinned open for the whole run. That is the wrong
  // surface for it three ways over: a toast covers the note you are reading,
  // it vanishes for good if you click it (there is no way to ask for it
  // back), and during the 20-40 seconds of an actual generation it does not
  // move — a frozen box in the corner reads as a bug, not as work.
  //
  // A run belongs in the status bar. It is always visible, it is never in
  // front of anything, it cannot be dismissed by accident, and it survives
  // you switching notes — which is what you will do, because these
  // operations take minutes.
  //
  // Toasts keep what they are good at: moments. The result of a run is a
  // moment. The run itself is not.
  // ---------------------------------------------------------------------

  /**
   * Is a model operation already running?
   *
   * There is one engine, one status line and one clock, so there is one
   * operation at a time — and until now only scan enforced that. Pressing
   * Formatting while an ingest was mid-flight started a second call on the
   * same GPU, and the two runs then fought over a single runningText and a
   * single runStartedAt, which is what put two toasts on screen showing
   * different elapsed times for the same note.
   */
  isBusy(): boolean {
    return this.runningText !== null || this.scanRunning || this.chatBusy;
  }

  /**
   * The chat panel is generating.
   *
   * It tracks its own busy flag for its own send button, and that flag was
   * invisible from here — so while an answer streamed, isBusy() said no and
   * every chip stayed live. Pressing Formatting mid-answer started a second
   * call on the same engine, which is the thing the guard exists to stop.
   */
  setChatBusy(busy: boolean): void {
    if (this.chatBusy === busy) return;
    this.chatBusy = busy;
    this.notifyBusyChange();
  }

  /**
   * What is running, without its sub-status.
   *
   * The live text carries a stage after an em dash — "Ingesting X —
   * Extracting…" — which is right in a progress line and wrong in a sentence
   * about it, where it produced "Ingesting X — Extracting… — wait for that to
   * finish." Two dashes and a stage nobody asked about.
   */
  runningLabel(): string | null {
    if (this.runningText === null) return this.chatBusy ? 'Answering' : null;
    return this.runningText.split(' — ')[0].replace(/[…:]\s*$/, '');
  }

  /**
   * Refuse a second operation, and say what is already going.
   *
   * The UI disables these entries while something runs, so reaching this is
   * usually the command palette, which routes around any button.
   */
  private refuseIfBusy(): boolean {
    if (!this.isBusy()) return false;
    notify('warn', `Busy: ${this.runningLabel() ?? 'a scan is running'}. Wait for that to finish.`);
    return true;
  }

  private status(text: string) {
    // Both surfaces, for the whole run. Two earlier attempts each fixed one
    // half and broke the other:
    //
    //   A toast pinned open for the run — you cannot miss it, but clicking it
    //   destroys it with no way back, and it does not move while the model
    //   generates, so a frozen box reads as a hang.
    //
    //   The status bar alone — survives everything, but the top-right went
    //   silent for minutes, so pressing a command acknowledged nothing, and
    //   the bar is at the edge of the window where it is easy to miss and can
    //   be switched off entirely.
    //
    // So: keep the toast AND the bar, and fix what was actually wrong with
    // the toast. It carries a running clock so it visibly moves. Dismissing
    // it is honoured — it means "out of my way" — and the status bar is the
    // way back: click it and the toast returns.
    const wasIdle = this.runningText === null;
    if (wasIdle) {
      this.runStartedAt = Date.now();
      this.runDismissed = false;
      if (this.tickId === null) {
        this.tickId = window.setInterval(() => this.paintRun(), 1000);
        this.registerInterval(this.tickId);
      }
    }
    this.runningText = text;
    this.paintRun();
    if (wasIdle) this.notifyBusyChange();
  }

  /** Elapsed time, so a long generation never looks like a hang. */
  private elapsed(): string {
    const s = Math.floor((Date.now() - this.runStartedAt) / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  /** Redraw both surfaces for the running operation. Called every second. */
  private paintRun() {
    if (this.runningText === null) return;
    const body = mark('progress', `${this.runningText}  ·  ${this.elapsed()}`);
    if (this.statusNotice) {
      // Obsidian removes a dismissed Notice from the DOM. Writing to it after
      // that is shouting into a void, and re-opening it would be overriding a
      // decision the user just made.
      if (this.statusNotice.messageEl?.isConnected) {
        this.statusNotice.setMessage(body);
      } else {
        // Stop writing to it, but KEEP the reference. Dropping it here left
        // an orphan: statusEnd hides via this.statusNotice, so a toast we had
        // let go of could never be closed again and sat on screen frozen at
        // its last message while the next run opened a second one beside it.
        this.runDismissed = true;
      }
    } else if (!this.runDismissed) {
      this.statusNotice = new Notice(body, 0);
    }
    this.renderStatusBar();
  }

  /** Bring back a toast the user dismissed, from the status bar. */
  private reopenRunNotice() {
    if (this.runningText === null) return;
    this.runDismissed = false;
    this.statusNotice?.hide();
    this.statusNotice = null;
    this.paintRun();
  }

  /**
   * Finish the running operation.
   *
   * The kind decides the mark and how long the result stays up, so a caller
   * never picks a millisecond count. Warnings and failures also go to
   * `log.md`, because a toast is not a record.
   */
  private statusEnd(text?: string, kind: NoticeKind = 'done', durationMs?: number) {
    const wasRunning = this.runningText !== null;
    this.runningText = null;
    if (this.tickId !== null) {
      window.clearInterval(this.tickId);
      this.tickId = null;
    }
    this.statusNotice?.hide();
    this.statusNotice = null;
    this.runDismissed = false;
    this.renderStatusBar();
    if (wasRunning) this.notifyBusyChange();
    if (!text) return;
    notify(kind, text, durationMs);
    void logNotice(this.app.vault, kind, text);
  }

  /**
   * The one status-bar slot, shared by three things that are never true at
   * once, in priority order: something is running, a finished run is waiting
   * to be looked at, or there are notes worth reviewing.
   */
  private renderStatusBar() {
    const el = this.scanStatusEl;
    if (!el) return;
    if (this.runningText !== null) {
      el.setText(`⏳ ${this.runningText}  ·  ${this.elapsed()}`);
      el.setAttr('aria-label', `${this.runningText} — click to bring the message back`);
      el.show();
      return;
    }
    if (this.reviewCount > 0 && this.settings.autoScanEnabled) {
      el.setText(`📥 ${this.reviewCount} to review`);
      el.setAttr('aria-label', 'New or changed notes — click to scan and review');
      el.show();
      return;
    }
    el.hide();
  }

  /** Clicking the status bar does whatever its current state means. */
  private onStatusBarClick() {
    if (this.runningText !== null) {
      this.reopenRunNotice();
      return;
    }
    void this.scanAndReviewIngest(
      this.settings.scanInclude.split(',').map((v) => v.trim()).filter(Boolean)
    );
  }



  /**
   * Run an approved write, and say so when it fails.
   *
   * Every "Approve and write" callback was a fire-and-forget async IIFE, so a
   * failure after approval had nowhere to go: the promise rejected into the
   * void, and the `notify('done', …)` that sat after the await never ran. The
   * user saw the modal close and then nothing at all — which reads exactly
   * like success. Deleting the note while its preview is open is enough to
   * reach it. A write the user authorised is the last place to fail quietly.
   */
  private runApproved(what: string, job: () => Promise<void>): void {
    void job().catch((err) => {
      this.statusFail(what, err);
    });
  }

  /** Report a thrown error through the status toast, in the house style. */
  private statusFail(what: string, err: unknown) {
    console.error(`[gemma-litert-wiki] ${what} failed`, err);
    this.statusEnd(failureText(what, err), 'error');
  }

  async onload() {
    // Which build is actually running. Obsidian caches a plugin's main.js
    // until it is disabled and re-enabled, so "I rebuilt it" and "the app is
    // running it" are two different facts — and telling them apart by
    // watching for a notification that may or may not appear is guesswork.
    // BUILD_STAMP is written at build time; if it does not match the file on
    // disk, the plugin needs a toggle off and on.
    log(`loaded — v${this.manifest.version} build ${BUILD_STAMP}`);
    await this.loadSettings();
    setWikiDir(this.settings.wikiDir);
    this.addSettingTab(new GemmaWikiSettingTab(this.app, this));

    // Brand mark: a closed book with the spark on its cover.
    //
    // The spark is the one from the original logo, unchanged — it was never the
    // problem. The container was: a page card with a folded corner reads as
    // "new file" in a ribbon that already holds a folder and a search glass.
    // A bound volume says the thing the page card could not, which is that this
    // is a wiki and not a note.
    //
    // Same geometry as assets/logo.svg, so the ribbon, the setup card, the
    // README and the store listing are one mark rather than four.
    // addIcon expects inner SVG for a 0 0 100 100 viewBox.
    addIcon(
      'gemma-wiki-logo',
      '<path d="M20.8 12.5 H79.2 a4 4 0 0 1 4 4 V83.3 a4 4 0 0 1 -4 4 H20.8 a8.3 8.3 0 0 1 -8.3 -8.3 V20.8 a8.3 8.3 0 0 1 8.3 -8.3 Z" ' +
        'stroke="currentColor" stroke-width="8.3" stroke-linejoin="round" stroke-linecap="round" fill="none"/>' +
        '<path d="M29.2 12.5 V87.5" stroke="currentColor" stroke-width="8.3" stroke-linecap="round"/>' +
        '<path d="M58 33 l5.27 11.73 11.73 5.27 -11.73 5.27 -5.27 11.73 -5.27 -11.73 -11.73 -5.27 11.73 -5.27 Z" fill="currentColor"/>'
    );

    // Say something the moment a knowledge folder is deleted, not at the next
    // launch. The rule — the folder comes back, the pages inside it do not —
    // is written in the folder's README, but nobody reads a README before the
    // thing it warns about. Said here it lands while Cmd+Z still works and the
    // pages are still in Obsidian's trash.
    //
    // The count comes from index.md rather than the vault: by the time this
    // fires the files are gone from the index, but their catalog entries are
    // still there, which is exactly the list of what was lost.
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (!(file instanceof TFolder)) return;
        const dir = wikiDir();
        if (file.path !== dir && !file.path.startsWith(`${dir}/`)) return;
        // Count the folder's own descendants first. Obsidian hands us the
        // pre-deletion TFolder, so its children are usually still readable —
        // and that is the only source that works when the whole knowledge
        // folder goes, because index.md is inside it and went too. Falling
        // back to the catalog covers the case where children are already gone.
        const countPages = (f: TFolder): number =>
          f.children.reduce(
            (n, c) =>
              n + (c instanceof TFolder ? countPages(c) : c.path.endsWith('.md') && !/README\.md$/i.test(c.path) ? 1 : 0),
            0
          );
        this.runApproved('Wiki folder', async () => {
          let lost = 0;
          try {
            lost = countPages(file);
          } catch {
            lost = 0;
          }
          if (!lost) {
            lost = (await readIndexEntries(this.app.vault)).filter((e) =>
              e.linkPath.startsWith(`${file.path}/`)
            ).length;
          }
          const pages = lost
            ? `${lost} page${lost === 1 ? '' : 's'} went with it. `
            : 'It was empty. ';
          // Through the shared vocabulary, and into log.md — this is exactly
          // the notice worth a record, since the toast fades and the pages
          // that went with the folder do not come back.
          notifyAndLog(
            this.app.vault,
            'warn',
            `Deleted "${file.path}". ${pages}` +
              'The folder comes back when Obsidian restarts, or from Settings → Repair folders — ' +
              (lost
                ? 'the pages do not. Undo now with Cmd/Ctrl+Z, or restore them from Obsidian\'s ' +
                  'trash, then run "Tidy the wiki" if you decide to let them go.'
                : 'nothing was lost.')
          );
        });
      })
    );

    // Follow the folder if it is renamed or moved from the file explorer.
    // Without this the setting kept pointing at the old path: every folder read
    // as missing, and "Create missing" built a second, empty knowledge base
    // beside the real one — the plugin fighting the user instead of following.
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (!(file instanceof TFolder) || oldPath !== wikiDir()) return;
        this.runApproved('Rename', async () => {
          this.settings.wikiDir = file.path;
          await this.saveSettings();
          setWikiDir(file.path);
          this.refreshIngestBadges();
          notify('info', `Knowledge folder is now "${file.path}" — Gemma Wiki followed the rename.`);
        });
      })
    );

    this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this));

    this.addRibbonIcon('gemma-wiki-logo', 'Gemma Wiki — ask your notes (local, free)', () => {
      void this.activateChatView();
    });

    // Status-bar "N to review" chip (issue #2). Clicking runs the full
    // scan+draft+review flow; the chip's count itself is model-free.
    this.scanStatusEl = this.addStatusBarItem();
    this.scanStatusEl.addClass('mod-clickable');
    this.scanStatusEl.hide();
    this.scanStatusEl.addEventListener('click', () => this.onStatusBarClick());

    // Build the wiki folders on first load rather than on first write. Until
    // this ran, a freshly installed plugin had created nothing at all, so
    // there was no way to see what it was going to do with the vault — and
    // schema.md and skills/ only appeared if you happened to run the right
    // command. Seeding skills/ also means the panel's menu is not empty on
    // day one. Both calls are no-ops once the files exist.
    // Build the wiki folders on load rather than on first write, then say so.
    // The folder is created unconditionally — asking permission to make an
    // empty working directory is a dialog with one sensible answer. What the
    // user does need is to be told it happened, once, in a form they cannot
    // miss and can act on. Both calls are no-ops once the files exist.
    this.app.workspace.onLayoutReady(() => {
      this.runApproved('Startup', async () => {
        // Cross-machine safety. wikiDir lives in data.json, which many sync
        // setups do not carry, so machine B can be looking for "gemma-wiki"
        // while the vault it just synced holds "wiki" — and would happily
        // build a second, empty knowledge base beside the real one. If the
        // configured folder is missing but something that looks like a wiki
        // is present, ask before creating anything.
        if (!this.app.vault.getAbstractFileByPath(wikiDir())) {
          const found = this.findExistingWiki();
          if (found) {
            const use = await new Promise<boolean>((resolve) => {
              new ConfirmModal(this.app, {
                title: 'Found an existing Gemma Wiki',
                body:
                  `This vault already contains "${found}/", which has an index and a cards ` +
                  `folder — but this machine is configured to use "${wikiDir()}/", which is not ` +
                  'here.\n\nThat usually means the folder was renamed on another machine and the ' +
                  'setting did not sync.\n\nUse the folder that is actually here? Choosing "No" ' +
                  `creates a second, empty wiki at "${wikiDir()}/".`,
                confirmText: `Use "${found}/"`,
                onResult: resolve,
              }).open();
            });
            if (use) {
              this.settings.wikiDir = found;
              await this.saveSettings();
              setWikiDir(found);
            }
          }
        }

        const existedBefore = !!this.app.vault.getAbstractFileByPath(wikiDir());
        const gone = wikiScaffoldPaths()
          .filter((e) => !this.app.vault.getAbstractFileByPath(e.path.replace(/\/$/, '')))
          .map((e) => e.path);
        await ensureWikiScaffold(this.app.vault);
        await ensureSkillsScaffold(this.app.vault);
        log('scaffold check:', { dir: wikiDir(), existedBefore, restored: gone });

        // The folder did not exist a moment ago and does now, so say what
        // appeared. This used to also require a "never shown" flag, which
        // suppressed the card in the one case where it is most wanted: someone
        // deleted the whole knowledge folder and it was just rebuilt from
        // nothing. existedBefore already says exactly what the flag was trying
        // to say, and says it correctly.
        if (!existedBefore) {
          // Open index.md *before* the card. Obsidian expands and highlights the
          // parent folders of whatever file is active, so this is what actually
          // makes the new folder visible — an emoji in its name would be seen
          // once and then live in every path and every wikilink forever.
          // Dismissing the card then leaves the folder open in the explorer,
          // index.md in the editor, and the chat panel on the right.
          await this.app.workspace.openLinkText(indexPath().replace(/\.md$/, ''), '', false);
          this.showSetupCard();
          return;
        }

        // Otherwise: say something only if something was actually put back.
        // Silently repairing is worse than it sounds — a folder does not go
        // missing on its own, so the user deleted it, and they should know it
        // returned rather than discover it later and think the delete failed.
        // A notice, not a dialog: there is nothing to decide, and it is already
        // fixed by the time they read it.
        // Reaching here means this was not the first run — that branch returns
        // above. So the only question left is whether anything was actually
        // put back. It used to also require existedBefore, which meant the
        // worst case — the entire knowledge folder deleted — rebuilt in total
        // silence, while losing one subfolder got a notice.
        if (gone.length) {
          notifyAndLog(
            this.app.vault,
            'warn',
            `Restored ${gone.length} missing item${gone.length === 1 ? '' : 's'} in ${wikiDir()}/:\n` +
              gone.join('\n') +
              '\n\nPages that were deleted are not restored — run "Tidy the wiki" to drop their index entries.'
          );
        }

        // Leftovers from before answers moved into the user's own vault.
        // Said once, and nothing is moved: relocating a hundred files on
        // upgrade is exactly the kind of help nobody asked for, and this
        // plugin does not touch files in a vault that it did not just write.
        // Empty folders are left too — deleting a directory in someone's vault
        // to tidy up our own scaffold is not proportionate.
        await this.noteRetiredFolders();
      });
    });
    this.app.workspace.onLayoutReady(() => this.rescheduleAutoScan());

    this.addCommand({
      id: 'litert-open-chat',
      name: 'Chat with active note (local Gemma)',
      callback: () => {
        void this.activateChatView();
      },
    });

    this.addCommand({
      id: 'litert-ingest-note',
      // One name for one action, in the palette and on the chip alike. A
      // button reading "File this note" beside a command reading "Ingest
      // active note" is the same crime as Scan carrying two names.
      name: 'Ingest this note into wiki (local Gemma)',
      callback: () => void this.ingestActiveNote(),
    });

    this.addCommand({
      id: 'litert-scan-ingest',
      // Renamed from "Scan notes for wiki (semi-automatic ingest)". Nobody
      // types "semi-automatic ingest" into a command palette — that was my
      // word for it, not the user's. "Batch" and "folder" are what someone
      // reaches for when they have thirty notes and do not want to file them
      // one at a time.
      name: 'Scan a folder into the wiki (batch, local Gemma)',
      callback: () => void this.scanAndReviewIngest(),
    });

    // Stopping used to require going back to Settings, because the only Stop
    // control was the same button that started it. If you launched from the
    // command palette that meant hunting through a settings pane to cancel
    // something you started with two keystrokes.
    //
    // checkCallback keeps it out of the palette entirely unless a scan is
    // actually running, so it never shows up as a command that does nothing.
    this.addCommand({
      id: 'litert-stop-scan',
      name: 'Stop the running scan',
      checkCallback: (checking: boolean) => {
        if (!this.isScanning()) return false;
        if (!checking) {
          this.cancelScan();
          notify('info', 'Stopping — the note being drafted right now will finish first.');
        }
        return true;
      },
    });

    this.addCommand({
      id: 'litert-suggest-tags-links',
      name: 'Suggest tags & links for active note (local Gemma)',
      callback: () => {
        if (this.refuseIfBusy()) return;
        void this.suggestTagsAndLinks();
      },
    });

    this.addCommand({
      id: 'litert-improve-note',
      name: 'Improve formatting of active note (local Gemma)',
      callback: () => void this.improveActiveNote(),
    });

    this.addCommand({
      id: 'litert-review-board',
      name: 'Review board (low-confidence, drifted, and stale pages)',
      callback: async () => {
        const board = await buildReviewBoard(this.app, this.settings.staleDays);
        new ReviewBoardModal(this.app, board, this.settings.staleDays).open();
      },
    });

    this.addCommand({
      id: 'litert-tidy-wiki',
      name: 'Tidy the wiki (check, then fix what you approve)',
      callback: () => {
        if (this.refuseIfBusy()) return;
        void this.tidyWiki();
      },
    });

    this.addCommand({
      id: 'litert-concept-page',
      name: 'Build a concept page from a tag or mention (local Gemma)',
      callback: () => void this.createConceptPage(),
    });

    this.addCommand({
      id: 'litert-find-contradictions',
      name: 'Find contradictions in wiki (local Gemma)',
      callback: () => {
        if (this.refuseIfBusy()) return;
        void this.findContradictions();
      },
    });

    this.addCommand({
      id: 'litert-provenance-check',
      name: 'Provenance spot-check (local Gemma)',
      callback: () => {
        if (this.refuseIfBusy()) return;
        void this.spotCheckProvenance();
      },
    });

    // Diagnostics I wrote for myself while getting LiteRT-LM to run inside
    // Electron. They are genuinely useful when something is broken — "is
    // WebGPU there", "does the runtime load without the model", "can this
    // model actually hold a JSON schema" — but they are four of the twenty
    // entries a user sees when they type the plugin's name, and none of them
    // is a thing anyone wants to do with their notes. Off unless asked for,
    // in Settings → Model → Developer commands.
    if (this.settings.devCommands) {
      this.addCommand({
        id: 'litert-check-webgpu',
        name: '[Test] Check WebGPU',
        callback: async () => {
          const result = await checkWebGPU();
          log('WebGPU check:', result);
          if (result.ok) notify('done', `WebGPU OK — ${result.detail}`, DURATION.NORMAL);
          else notify('error', `WebGPU unavailable — ${result.detail}`);
        },
      });

      this.addCommand({
        id: 'litert-load-wasm',
        name: '[Test] Load WASM runtime (no model download)',
        callback: async () => {
          const p = new Progress('Loading LiteRT-LM WASM runtime… full detail in the console (Cmd/Ctrl+Opt+I).');
          try {
            await this.ensureWasmLoaded();
            p.done('LiteRT-LM WASM runtime loaded successfully.');
          } catch (err) {
            p.fail('Loading the WASM runtime', err);
          }
        },
      });

    this.addCommand({
      id: 'litert-download-model',
      name: 'Download model (one-time, ~3GB)',
      callback: async () => {
        this.status('Preparing model download…');
        try {
          const blob = await this.ensureModelBlob((text) => {
            log(text);
            this.status(text);
          });
          this.statusEnd(`Model ready — ${(blob.size / 1e9).toFixed(2)} GB, cached. It never downloads again.`);
        } catch (err) {
          this.statusFail('Downloading the model', err);
        }
      },
    });

      this.addCommand({
        id: 'litert-fix-grammar',
        name: '[Test] Fix grammar of selection',
        editorCallback: async (editor) => {
          const selection = editor.getSelection();
          if (!selection.trim()) {
            notify('warn', 'Select some text first, then run this command.');
            return;
          }
          // v1 finding (2026-08-24): the 28s TTFT on a cold engine was mostly
          // one-time GPU warmup cost, not per-call — once warm, prefill jumps
          // ~5-6x. Cap is deliberately loose here — this spike's job right
          // now is to find where the model's real context ceiling is
          // (currently unknown), not to pre-guess a safe limit. A hard
          // failure at some length is a valid, useful result, not a bug to
          // prevent.
          const MAX_INPUT_CHARS = 40000;
          if (selection.length > MAX_INPUT_CHARS) {
            notify(
              'warn',
              `Selection is ${selection.length} chars — over the ${MAX_INPUT_CHARS} limit for this spike. ` +
                'Select a shorter passage (a paragraph, not a whole note).'
            );
            return;
          }
          // Rough token estimate (chars/3, generous for mixed CJK/English) so
          // the output budget scales with input instead of being a fixed
          // guess that either truncates long inputs or wastes tokens on
          // short ones.
          const estimatedInputTokens = Math.ceil(selection.length / 3);
          const maxOutputTokens = Math.min(4096, Math.max(256, Math.ceil(estimatedInputTokens * 1.5)));

          const p = new Progress('Loading model (first run downloads ~3GB)…');
          let conversation: import('@litert-lm/core').Conversation | undefined;
          try {
            const engine = await this.ensureEngine((text) => {
              log(text);
              p.update(text);
            });
            p.update('Generating…');

            const { SamplerType } = await import('@litert-lm/core');
            conversation = await engine.createConversation({
              preface: {
                messages: [
                  {
                    role: 'system',
                    content:
                      'You are a copy editor. Fix grammar and spelling mistakes in the text the user gives you. ' +
                      'Return ONLY the corrected text — no explanation, no preamble, no quotes around it. ' +
                      'If the text is already correct, return it unchanged.',
                  },
                ],
              },
              sessionConfig: {
                samplerParams: { type: SamplerType.GREEDY },
                maxOutputTokens,
              },
            });

            const wallStart = Date.now();
            let result = '';
            const stream = conversation.sendMessageStreaming(selection);
            const reader = stream.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              const content = value?.content;
              if (typeof content === 'string') {
                result += content;
              } else if (Array.isArray(content)) {
                for (const part of content) {
                  if (part.type === 'text' && part.text) result += part.text;
                }
              }
            }
            const wallMs = Date.now() - wallStart;

            const bench = await conversation.getBenchmarkInfo();
            log('Grammar fix result:', result);
            log('Wall time (ms):', wallMs);
            log('Benchmark info:', bench);

            editor.replaceSelection(result.trim());
            p.done(
              `Done in ${(wallMs / 1000).toFixed(1)}s — decode ${bench.lastDecodeTokensPerSecond.toFixed(1)} tok/s, ` +
                `TTFT ${bench.timeToFirstTokenInSecond.toFixed(2)}s. Replaced selection; see console for full numbers.`,
              DURATION.LONG
            );
          } catch (err) {
            p.fail('Fixing grammar', err);
          } finally {
            await conversation?.delete().catch(() => {});
          }
        },
      });

      this.addCommand({
        id: 'litert-json-reliability',
        name: '[Test] JSON reliability test (5 runs)',
        editorCallback: async (editor) => {
          const selection = editor.getSelection();
          if (!selection.trim()) {
            notify('warn', 'Select a short paragraph first, then run this command.');
            return;
          }
          if (selection.length > 3000) {
            notify('warn', 'Keep it under 3000 chars for this test — pick a single paragraph.');
            return;
          }

          const RUNS = 5;
          // Named because the truncation check needs the same number the
          // session was given; a budget stated in two places is a budget that
          // drifts.
          const MAX_OUTPUT = 512;
          const p = new Progress('JSON reliability test: loading model…');
          try {
            const engine = await this.ensureEngine((text) => {
              log(text);
              p.update(text);
            });

            const { SamplerType } = await import('@litert-lm/core');
            let successCount = 0;
            const outcomes: string[] = [];

            for (let i = 1; i <= RUNS; i++) {
              p.update(`JSON reliability test: run ${i}/${RUNS}…`);
              let conversation: import('@litert-lm/core').Conversation | undefined;
              try {
                conversation = await engine.createConversation({
                  preface: {
                    messages: [
                      {
                        role: 'system',
                        content:
                          'You extract structured metadata from a note. Given the text the user provides, ' +
                          'respond with ONLY a single JSON object matching this exact shape, no markdown code ' +
                          'fences, no explanation, nothing before or after it: ' +
                          '{"summary": "one sentence summary", "tags": ["tag1", "tag2", "tag3"]}. ' +
                          'Tags must be short lowercase noun phrases, exactly 3 of them.',
                      },
                    ],
                  },
                  sessionConfig: {
                    samplerParams: { type: SamplerType.GREEDY },
                    maxOutputTokens: MAX_OUTPUT,
                  },
                });

                let raw = '';
                const stream = conversation.sendMessageStreaming(selection);
                const reader = stream.getReader();
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  raw += textOf(value?.content);
                }

                // The two measurements this command exists to produce, beside
                // the pass/fail. The repetition thresholds in model-output.ts
                // are set conservatively and have NOT been calibrated against
                // this model — doing that means reading these numbers off real
                // replies and seeing where good output and looping output
                // actually separate. Printed on every run, valid or not, so a
                // sample can be gathered by running this a few times.
                const loop = looksRepetitive(raw);
                const cut = looksCutOff(raw, MAX_OUTPUT);
                const measured =
                  `run=${loop.longestRun} distinct=${loop.distinctRatio.toFixed(3)}` +
                  `${loop.repetitive ? ' LOOPING' : ''}` +
                  `${cut.atBudget ? ' at-budget' : ''}${cut.midSentence ? ' mid-sentence' : ''}`;

                const read = parseModelJson<Record<string, unknown>>(raw);
                if (!read.ok) {
                  log(`Run ${i}: ${read.reason}`, 'raw:', raw, measured);
                  outcomes.push(`Run ${i}: ${read.reason.toUpperCase()} [${measured}] — raw: ${raw}`);
                } else {
                  const rec = read.value;
                  const valid =
                    typeof rec.summary === 'string' &&
                    Array.isArray(rec.tags) &&
                    rec.tags.length === 3 &&
                    rec.tags.every((t: unknown) => typeof t === 'string');
                  if (valid && !loop.repetitive) {
                    successCount++;
                    log(`Run ${i}: OK`, rec, measured);
                    outcomes.push(`Run ${i}: OK [${measured}] — ${JSON.stringify(rec)}`);
                  } else if (valid) {
                    // The shape passed and the content is a loop. This is the
                    // exact failure the shape checks cannot see.
                    log(`Run ${i}: valid shape, repetition loop`, rec, measured);
                    outcomes.push(`Run ${i}: LOOP [${measured}] — ${JSON.stringify(rec)}`);
                  } else {
                    log(`Run ${i}: parsed but wrong shape`, rec, 'raw:', raw, measured);
                    outcomes.push(`Run ${i}: WRONG SHAPE [${measured}] — ${JSON.stringify(rec)}`);
                  }
                }
              } finally {
                await conversation?.delete().catch(() => {});
              }
            }

            log('JSON reliability test summary:', `${successCount}/${RUNS} valid`, outcomes);
            const text = `JSON reliability: ${successCount}/${RUNS} valid. Full detail in console (search "JSON reliability").`;
            if (successCount === RUNS) p.done(text, DURATION.LONG);
            else p.warn(text);
          } catch (err) {
            p.fail('The JSON reliability test', err);
          }
        },
      });
    }

    // Badge refresh: once the layout is ready, then whenever metadata
    // resolves (covers wiki page creation, deletion, and vault sync).
    this.app.workspace.onLayoutReady(() => this.refreshIngestBadges());
    this.registerEvent(this.app.metadataCache.on('resolved', () => this.refreshIngestBadges()));

    // Keep the index honest when a wiki page is deleted: index.md isn't updated
    // by the delete itself, so a removed page lingers as a ghost entry (and a
    // dead related link). Prune on any delete inside the wiki folder.
    this.registerEvent(
      this.app.vault.on('delete', (f) => {
        if (!f.path.startsWith(`${wikiDir()}/`)) return;
        this.runApproved('Prune', async () => {
          await this.pruneIndex();
          await this.pruneDeadRelatedLinks();
        });
      })
    );
  }

  // Small file-explorer badge on raw notes that already have a wiki page.
  // Purely decorative DOM on the explorer item — the note file itself is
  // never modified by the plugin, per the raw-notes-are-read-only rule.
  refreshIngestBadges() {
    const ingested = getIngestedSourcePaths(this.app);
    for (const leaf of this.app.workspace.getLeavesOfType('file-explorer')) {
      const fileItems = (leaf.view as unknown as { fileItems?: Record<string, { selfEl?: HTMLElement }> })
        .fileItems;
      if (!fileItems) continue;
      for (const [path, item] of Object.entries(fileItems)) {
        const el = item?.selfEl;
        if (!el) continue;
        const existing = el.querySelector(':scope > .gemma4-ingested-badge');
        if (ingested.has(path)) {
          if (!existing) {
            const badge = el.createSpan({ cls: 'gemma4-ingested-badge' });
            setIcon(badge, 'book-check');
            badge.setAttribute('aria-label', 'In wiki');
          }
        } else {
          existing?.remove();
        }
      }
    }
  }

  onunload() {
    // No detachLeavesOfType here. Obsidian's guidelines say not to, and the
    // reason is concrete: it discards the user's layout on every reload, so a
    // plugin update silently closes a panel they had docked where they wanted
    // it. Obsidian tears the view down on its own.
    this.server?.close();
    this.server = null;
    this.serverBaseUrl = null;
    this.wasmDir = null;

    // The engine owns the loaded model and its WebGPU allocations — gigabytes
    // that Obsidian will not reclaim on its own, and a disable/enable cycle to
    // pick up a new build would otherwise load a second engine beside the
    // first. onunload cannot await, so this is fire-and-forget: take the
    // promise away first so nothing can hand out the engine mid-teardown, and
    // swallow the error, since there is no UI left to report it to.
    const engine = this.enginePromise;
    this.enginePromise = null;
    this.wasmLoadPromise = null;
    if (engine) {
      void engine
        .then((e) => e.delete())
        .catch((err) => console.error('[gemma-litert-wiki] engine teardown failed', err));
    }
  }

  private async activateChatView() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
    if (existing) {
      await workspace.revealLeaf(existing);
      return;
    }
    const leaf: WorkspaceLeaf | null = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
    await workspace.revealLeaf(leaf);
  }

  private ensureWasmLoaded(): Promise<void> {
    if (!this.wasmLoadPromise) {
      this.wasmLoadPromise = (async () => {
        const baseUrl = await this.ensureLocalServer();
        log('Serving wasm/ from', baseUrl);

        // litertlm_wasm_internal.js auto-detects its own scriptDirectory via
        // `typeof __filename`, which is a real global in Obsidian's
        // Node-integrated Electron renderer (it points at Obsidian's own
        // file, not this script) — that hijacks the correct
        // document.currentScript-based path and the wasm binary fetch falls
        // back to resolving against Obsidian's own page origin.
        // Pre-seeding self.Module.locateFile is the escape hatch the file
        // itself checks first (see wasm/litertlm_wasm_internal.js:60-64).
        const globalWithModule = self as unknown as { Module?: Record<string, unknown> };
        globalWithModule.Module = {
          ...(globalWithModule.Module ?? {}),
          locateFile: (p: string) => baseUrl + p,
        };

        // The runtime asks for its glue by URL. Our replacement for the
        // vendor's loader requires that file off disk instead of injecting a
        // <script> tag, so it needs to know where the URL points: same
        // filename, in the folder the loopback server is already serving.
        const served = this.wasmDir;
        if (!served) throw new Error('The local runtime server did not report its directory.');
        ensureCommonJsMarker(served);
        setWasmScriptResolver((url) => path.join(served, path.basename(new URL(url).pathname)));

        const { loadLiteRtLm } = await import('@litert-lm/core');
        await loadLiteRtLm(baseUrl);
        log('loadLiteRtLm() resolved without throwing.');
      })().catch((err) => {
        this.wasmLoadPromise = null;
        throw err;
      });
    }
    return this.wasmLoadPromise;
  }

  // This-note write action (issue #6): suggest tags + wiki links for the
  // active note. Same generate→preview→confirm shape as ingest, but it edits
  // the raw note — tags merged into frontmatter via the safe processFrontMatter
  // API (no hand-rolled YAML), links appended as a Related section only if the
  // note doesn't already have one. Nothing is written until the user approves.
  async suggestTagsAndLinks() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      notify('warn', 'Open a note first.');
      return;
    }
    const content = await this.app.vault.read(file);
    if (precheckNote(content, undefined) !== null) {
      notify('noop', 'Note is empty — nothing to suggest.');
      return;
    }

    this.status(`Suggesting tags & links for "${file.basename}"…`);
    try {
      const clamped = clampToTokens(cleanClippedMarkdown(content), this.budget('ingest'));
      const extraction = await this.extractNoteMetadata(clamped.text, (t) =>
        this.status(`Suggesting for "${file.basename}" — ${t}`)
      );

      // Dedupe suggested tags against whatever the note already has.
      const existing = new Set<string>();
      const rawTags = fmOf(this.app, file)?.tags;
      if (Array.isArray(rawTags)) rawTags.forEach((t) => existing.add(slugify(String(t))));
      else if (typeof rawTags === 'string') rawTags.split(/[,\s]+/).forEach((t) => t && existing.add(slugify(t)));
      const newTags = extraction.tags.map((t) => slugify(t)).filter((t) => t && !existing.has(t));

      const selfLink = cardPathFor(this.app, file).replace(/\.md$/, '');
      const candidates = (await this.liveIndexEntries()).filter((e) => e.linkPath !== selfLink);
      const related = candidates.length ? await this.pickRelatedPages(extraction.summary, candidates) : [];
      this.statusEnd();

      new SuggestTagsLinksModal(this.app, file.path, newTags, related, () => {
        this.runApproved('Suggest', async () => {
          if (newTags.length) {
            await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
              const cur = Array.isArray(fm.tags)
                ? fm.tags.map(String)
                : typeof fm.tags === 'string' && fm.tags
                  ? [fm.tags]
                  : [];
              fm.tags = Array.from(new Set([...cur, ...newTags]));
            });
          }
          if (related.length) {
            const cur = await this.app.vault.read(file);
            if (!cur.includes('\n## Related')) {
              const block = `\n## Related\n\n${related.map((r) => `- [[${r.linkPath}|${r.title}]]`).join('\n')}\n`;
              await this.app.vault.append(file, block);
            }
          }
          notify('done', `Updated "${file.basename}" — tags & links added.`);
          this.refreshIngestBadges();
        });
      }).open();
    } catch (err) {
      this.statusFail('Suggest', err);
    }
  }

  // A folder counts as a knowledge base if it holds both an index and a
  // cards/ subfolder — specific enough not to match someone's own notes.
  // Returns nothing if there is more than one candidate: guessing between two
  // is worse than asking for none.

  private findExistingWiki(): string | null {
    const hits = this.app.vault
      .getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder)
      .filter(
        (f) =>
          f.path &&
          f.path !== wikiDir() &&
          !!this.app.vault.getAbstractFileByPath(`${f.path}/index.md`) &&
          !!this.app.vault.getAbstractFileByPath(`${f.path}/cards`)
      )
      .map((f) => f.path);
    return hits.length === 1 ? hits[0] : null;
  }

  // The first-run card, on demand. Shown automatically once; this is how you
  // get it back. Repeating it on every launch would be nagging — after the
  // first time there is nothing new in it, and Obsidian restores the panel with
  // the rest of the workspace anyway.
  /**
   * Say once that answers/ and chats/ are no longer written to.
   *
   * Only when they actually hold something. A folder that exists and is empty
   * is a scaffold leftover nobody will miss, and a notice about it would be
   * the plugin talking about its own housekeeping.
   */
  private async noteRetiredFolders(): Promise<void> {
    if (this.settings.retiredFoldersNoticed) return;
    const counts: string[] = [];
    // chats/ is written to again — the folder was never the problem, the
    // indexing was, and it is excluded structurally now. Only answers/ is
    // retired.
    for (const dir of [wikiAnswersDir()]) {
      const folder = this.app.vault.getAbstractFileByPath(dir);
      if (!(folder instanceof TFolder)) continue;
      const n = folder.children.filter((c) => c instanceof TFile && c.name !== 'README.md').length;
      if (n) counts.push(`${dir}/ — ${n} file${n === 1 ? '' : 's'}`);
    }
    this.settings.retiredFoldersNoticed = true;
    await this.saveSettings();
    if (!counts.length) return;
    notifyAndLog(
      this.app.vault,
      'info',
      'Saved answers now go into your own notes, beside the note they came from.\n\n' +
        `This folder is no longer written to and nothing was moved:\n${counts.join('\n')}\n\n` +
        'Anything worth keeping can go wherever you keep notes — and once it is there, ' +
        'a scan can turn it into a wiki card like any other note.',
      DURATION.LONG
    );
  }

  showSetupCard() {
    new ScaffoldCreatedModal(
      this.app,
      wikiDir(),
      wikiScaffoldPaths(),
      () => void this.app.workspace.openLinkText(indexPath().replace(/\.md$/, ''), '', false),
      () => void this.activateChatView()
    ).open();
  }

  // One button for "put the folders back". The scaffold runs on load, so this
  // is for the cases load cannot cover: a folder deleted by hand, a sync that
  // dropped an empty directory, or a knowledge-folder rename. Idempotent —
  // it reports what was missing rather than claiming to have done work.
  async repairWikiFolders() {
    const missing = wikiScaffoldPaths()
      .filter((e) => !this.app.vault.getAbstractFileByPath(e.path.replace(/\/$/, '')))
      .map((e) => e.path);
    await ensureWikiScaffold(this.app.vault);
    await ensureSkillsScaffold(this.app.vault);
    if (!missing.length) {
      notify('noop', `Everything is already in place under ${wikiDir()}/.`);
      return;
    }
    notify('done', `Created ${missing.length} missing item${missing.length === 1 ? '' : 's'}:\n${missing.join('\n')}`);
  }

  async createSkillsFolder() {
    await ensureSkillsScaffold(this.app.vault);
    const path = `${wikiDir()}/skills`;
    notify('done', `Skills folder ready at ${path}. Open its README, then add a .md file per skill.`);
    const readme = this.app.vault.getAbstractFileByPath(`${path}/README.md`);
    if (readme instanceof TFile) await this.app.workspace.getLeaf(true).openFile(readme);
  }

  // Tally the tags in use across wiki pages (frontmatter), skipping the
  // plugin's own structural tags, sorted most-frequent first. Shared by
  // "Organize tags" (which cleans this list) and ingest (which, before any
  // vocabulary exists, prefers these so tags converge from day one — issue #38).
  private wikiTagCounts(): [string, number][] {
    const SKIP = new Set(['concept', 'answer', 'chat']);
    const counts = new Map<string, number>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!isWikiPage(f)) continue;
      const raw = fmOf(this.app, f)?.tags;
      const tags = Array.isArray(raw)
        ? raw.map((t) => String(t))
        : typeof raw === 'string'
          ? raw.split(/[,\s]+/).filter(Boolean)
          : [];
      for (const t of tags) {
        const tag = slugify(t);
        if (!tag || SKIP.has(tag)) continue;
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }

  async suggestTagVocabulary(): Promise<boolean> {
    const counts = this.wikiTagCounts();
    if (!counts.length) {
      notify(
        'warn',
        'No tags yet — the vocabulary is built from the tags your ingested notes already produced. ' +
          'Ingest a few notes first, then run "Tidy the wiki".'
      );
      return false;
    }

    this.status('Organizing the tag vocabulary…');
    let vocab: string[];
    try {
      vocab = await this.cleanTagVocabulary(counts);
      this.statusEnd('Vocabulary ready — review it below.');
    } catch (err) {
      console.error('[gemma-litert-wiki] vocab suggest failed', err);
      this.statusFail('Suggest', err);
      return false;
    }
    if (!vocab.length) {
      notify('noop', 'The model returned an empty vocabulary — nothing to write.');
      return false;
    }

    // Preserve any Naming / Concept-threshold the user has set, and enforce
    // the Rejected list: a banned tag never re-enters the vocabulary, no
    // matter how many pages still carry it — the ban is the user's veto and
    // outranks usage (mechanical filter, not a prompt hope).
    const existing = await readSchema(this.app.vault);
    const rejectedSet = new Set(existing.rejected.map((t) => slugify(t)));
    vocab = vocab.filter((t) => !rejectedSet.has(t));
    if (!vocab.length) {
      notify('noop', 'Every proposed tag is on the Rejected list — nothing to write.');
      return false;
    }
    const content = buildSchemaFile({ ...existing, tags: vocab, pending: [] });
    const path = schemaPath();
    const overwriting = !!this.app.vault.getAbstractFileByPath(path);
    // Resolves when the dialog is answered, not when it opens. Tidy runs
    // Organize and Retag back to back, and an `await` that returned at
    // `.open()` let Retag start against the OLD vocabulary and stack its
    // dialog on top of this one.
    return await new Promise<boolean>((resolve) => {
      new IngestPreviewModal(
        this.app,
        path,
        content,
        overwriting,
        () => {
          this.runApproved('Organize tags', async () => {
            await ensureWikiScaffold(this.app.vault);
            await writeWikiPage(this.app.vault, path, content);
            await appendLog(this.app.vault, 'schema', `tag vocabulary (${vocab.length} tags)`);
            this.statusEnd(`Schema written: ${path}`);
            resolve(true);
          });
        },
        undefined,
        {
          // schema.md is not build output — it is the file you are invited to
          // edit — so the card sentence about rebuilding from a note was
          // simply false here.
          overwriteWarning:
            'Your current vocabulary is replaced by the one above. Tags you moved to Rejected are kept.',
          onDismiss: () => resolve(false),
        }
      ).open();
    });
  }

  // Related links must only ever point at pages that still exist. index.md is
  // NOT auto-pruned when the user deletes a source page, so it can list ghosts;
  // linking to those produces dead [[links]] that open blank. Filter the index
  // to live files before offering anything as a related page.
  private async liveIndexEntries(): Promise<IndexEntry[]> {
    const entries = await readIndexEntries(this.app.vault);
    return entries.filter(
      (e) => this.app.vault.getAbstractFileByPath(`${e.linkPath}.md`) instanceof TFile
    );
  }

  // Keep index.md honest automatically: drop entries whose page file no longer
  // exists. The index isn't pruned when the user deletes a page, so it
  // accumulates ghosts that break related links and pollute retrieval. Called
  // on every ingest so the index self-heals — no manual cleanup needed.
  private async pruneIndex(): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(indexPath());
    if (!(file instanceof TFile)) return;
    const content = await this.app.vault.read(file);
    const LINE = /^- \[\[([^\]|]+)\|/;
    const lines = content.split('\n');
    const kept = lines.filter((l) => {
      const m = l.match(LINE);
      return !m || this.app.vault.getAbstractFileByPath(`${m[1]}.md`) instanceof TFile;
    });
    if (kept.length !== lines.length) await this.app.vault.modify(file, kept.join('\n'));
  }

  // Pending is the queue of tags ingest coined that aren't in the vocabulary.
  // It works as a soft vocabulary (ingest reads it too), but past a point a
  // long queue means the vocabulary itself is stale and clusters are
  // fragmenting. Nudge once, when the queue crosses the mark — not on every
  // ingest, which would just train the user to ignore it.
  private notePendingGrowth(before: number, after: number): void {
    const MARK = 20;
    if (before < MARK && after >= MARK) {
      notifyAndLog(
        this.app.vault,
        'warn',
        `${after} tags are waiting in schema.md's Pending list. Run "Tidy the wiki" to fold them ` +
          'into the vocabulary — until then, similar notes keep coining near-duplicate tags.'
      );
    }
  }

  // Karpathy's ingest "touches 15 files in one pass" — a new source updates
  // the pages it relates to, not just its own. Our cheap, gate-consistent
  // slice of that: after a page is written, DETERMINISTICALLY add it to the
  // member list of every concept page sharing one of its tags or mentions,
  // and mark that concept page stale (its prose overview no longer reflects
  // the membership). No model call, no content generation — bookkeeping,
  // same standing as pruneIndex. Rebuilding the overview stays a human
  // action via "Build a concept page", which clears the flag by rewriting.
  private async rippleConceptPages(newPagePath: string, subjects: string[]): Promise<void> {
    const subjectSet = new Set(subjects.map((s) => slugify(s)).filter(Boolean));
    if (!subjectSet.size) return;
    // Never ripple a concept page into another concept page's member list —
    // members are source pages (#62). Concept pages are only ever targets.
    const newFile = this.app.vault.getAbstractFileByPath(newPagePath);
    if (newFile instanceof TFile && this.app.metadataCache.getFileCache(newFile)?.frontmatter?.kind === 'concept') return;
    const newLink = newPagePath.replace(/\.md$/, '');
    const newTitle = newLink.split('/').pop() ?? newLink;
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!f.path.startsWith(`${wikiDir()}/`)) continue;
      const fm = fmOf(this.app, f);
      if (fm?.kind !== 'concept') continue;
      const raw = fm?.tags;
      const conceptTags = Array.isArray(raw) ? raw.map((t) => slugify(String(t))) : [];
      if (!conceptTags.some((t) => t !== 'concept' && subjectSet.has(t))) continue;
      const content = await this.app.vault.read(f);
      if (content.includes(`[[${newLink}|`) || content.includes(`[[${newLink}]]`)) continue;
      const idx = content.indexOf('\n## Pages');
      if (idx === -1) continue;
      // Append to the member list: after the heading, past existing bullets.
      const head = content.slice(0, idx);
      const tail = content.slice(idx);
      const lines = tail.split('\n');
      let last = 0;
      for (let i = 0; i < lines.length; i++) if (lines[i].startsWith('- [[')) last = i;
      lines.splice(last + 1, 0, `- [[${newLink}|${newTitle}]]`);
      await this.app.vault.modify(f, head + lines.join('\n'));
      await this.app.fileManager.processFrontMatter(f, (cfm: Record<string, unknown>) => {
        cfm.stale = true;
      });
      await appendLog(this.app.vault, 'ripple', `${newTitle} -> ${f.basename} (concept)`);
    }
  }

  // A page's Related section is "healthy" when it exists, lists at least one
  // link, and every link still resolves. Anything else — no section, an empty
  // one, or one holding a dead link — is a candidate for re-syncing (#44).
  /** The linkPaths a page's Related section currently lists, in file order. */
  private readRelatedLinksOn(content: string): string[] {
    const cut = content.indexOf('\n## Related');
    if (cut === -1) return [];
    return content
      .slice(cut)
      .split('\n')
      .map((l) => /^- \[\[([^\]|]+)\|/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => m[1]);
  }


  // Deleting a wiki page leaves every OTHER page that linked to it holding a
  // dead [[link]] in its "## Related" list — pruneIndex only fixes index.md.
  // Strip those lines so related links never point at a page that is gone.
  //
  // Deterministic bookkeeping, not generation: it only removes bullets whose
  // link target no longer exists, so it cannot lose information or touch the
  // page's own content. Same standing as pruneIndex, which already repairs
  // index.md on delete. Raw notes are never touched — wiki pages only.
  private async pruneDeadRelatedLinks(): Promise<void> {
    const LINK = /^- \[\[([^\]|]+)\|/;
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!isWikiPage(f)) continue;
      const content = await this.app.vault.read(f);
      // Same repair for both generated link lists: a source page's
      // "## Related" and a concept page's "## Pages" member list.
      let updated = content;
      let touchedConceptMembers = false;
      for (const heading of ['\n## Related', '\n## Pages']) {
        const idx = updated.indexOf(heading);
        if (idx === -1) continue;
        const head = updated.slice(0, idx);
        const tail = updated.slice(idx);
        const lines = tail.split('\n');
        const kept = lines.filter((l) => {
          const m = l.match(LINK);
          return !m || this.app.vault.getAbstractFileByPath(`${m[1]}.md`) instanceof TFile;
        });
        if (kept.length === lines.length) continue;
        if (heading === '\n## Pages') touchedConceptMembers = true;
        // If every link is gone, drop the empty heading too rather than
        // leaving a bare section with nothing under it.
        const hasLink = kept.some((l) => LINK.test(l));
        updated = hasLink ? head + kept.join('\n') : `${head}\n`;
      }
      if (updated === content) continue;
      await this.app.vault.modify(f, updated);
      // A concept page that lost a member has an overview describing pages
      // that are gone — flag it for a rebuild, same as when one is added.
      if (touchedConceptMembers && fmOf(this.app, f)?.kind === 'concept') {
        await this.app.fileManager.processFrontMatter(f, (cfm: Record<string, unknown>) => {
          cfm.stale = true;
        });
      }
    }
  }

  // Lint v2 (issue #5): flag contradiction candidates. Bounded — only pages
  // sharing a tag are paired, capped at 12 pairs — so the O(n^2) model sweep
  // can't run away. Flag-only: it never edits anything.
  async findContradictions() {
    const MAX_PAIRS = 12;
    this.status('Collecting wiki pages…');
    const pages: WikiPageMeta[] = await collectWikiPages(this.app);
    const { pairs, total: uncappedPairs } = pairsSharingTag(pages, MAX_PAIRS);
    if (!pairs.length) {
      this.statusEnd(
        pages.length < 2
          ? 'Need at least two wiki pages to compare.'
          : 'No tag-sharing page pairs to check — nothing can contradict.',
        'noop'
      );
      return;
    }

    const flags: ContradictionFlag[] = [];
    // Count the pairs the model failed to judge. Without this, twelve failed
    // calls and twelve clean verdicts both report "0 flagged" — the same
    // silent-failure pattern that hid the related-picker regression.
    let unjudged = 0;
    try {
      for (let i = 0; i < pairs.length; i++) {
        const { a, b } = pairs[i];
        this.status(`Checking ${i + 1}/${pairs.length} — ${a.title} vs ${b.title}…`);
        const verdict = await this.judgeContradiction(a.title, a.summary, b.title, b.summary);
        if (!verdict) unjudged++;
        else if (verdict.contradict) flags.push({ a, b, reason: verdict.reason });
      }
      this.statusEnd();
    } catch (err) {
      console.error('[gemma-litert-wiki] contradiction scan failed', err);
      this.statusFail('Contradiction scan', err);
      return;
    }
    // The pair cap is also silent otherwise: "0 flagged" reads as "your wiki is
    // consistent" when pairs were never looked at.
    const notChecked = uncappedPairs - pairs.length;
    if (unjudged || notChecked) {
      notify(
        'warn',
        [
          unjudged ? `${unjudged} of ${pairs.length} pairs could not be judged (see console)` : '',
          notChecked ? `${notChecked} more pair${notChecked === 1 ? '' : 's'} not checked this run (cap ${MAX_PAIRS})` : '',
        ]
          .filter(Boolean)
          .join('; ') + '.'
      );
    }
    new ContradictionReportModal(this.app, flags, pairs.length, uncappedPairs).open();
  }

  // Provenance spot-check (issue #21): sample a few wiki pages and, per page,
  // ask the model which of its key points the SOURCE note does not support.
  // Bounded (a handful of pages, one call each) and flag-only.
  async spotCheckProvenance() {
    const LIMIT = 8;
    this.status('Sampling wiki pages…');
    const samples = await sampleWikiPages(this.app, LIMIT);
    if (!samples.length) {
      this.statusEnd('No ingested pages with key points to check.', 'noop');
      return;
    }
    const flags: ProvenanceFlag[] = [];
    // Pages the model could not be read on. Counted rather than swallowed:
    // "8 checked, all clean" is a different sentence from "6 checked, all
    // clean, 2 could not be read".
    let unchecked = 0;
    try {
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        this.status(`Checking ${i + 1}/${samples.length} — ${s.title}…`);
        const srcFile = this.app.vault.getAbstractFileByPath(s.sourcePath);
        if (!(srcFile instanceof TFile)) continue; // source note gone
        const srcText = clampToTokens(cleanClippedMarkdown(await this.app.vault.read(srcFile)), this.budget('provenance')).text;
        const result = await this.checkProvenance(srcText, s.keyPoints);
        if (!result.ok) {
          unchecked++;
          continue;
        }
        if (result.unsupported.length) {
          flags.push({
            linkPath: s.linkPath,
            title: s.title,
            sourcePath: s.sourcePath,
            unsupported: result.unsupported,
          });
        }
      }
      this.statusEnd();
    } catch (err) {
      console.error('[gemma-litert-wiki] provenance check failed', err);
      this.statusFail('Provenance check', err);
      return;
    }
    new ProvenanceReportModal(this.app, flags, samples.length - unchecked, unchecked).open();
  }

  // One strict-JSON call: given the tags currently in use (with counts),
  // return a SMALL merged vocabulary. A controlled vocabulary is meant to
  // converge — the model merges synonyms AND collapses narrow subtopics into
  // broader parents, aiming for roughly one tag per 2-3 pages; it only reshapes
  // tags that already exist, it does not invent.
  async cleanTagVocabulary(tagsWithCounts: [string, number][]): Promise<string[]> {
    // Target size from how many pages there are (≈ total tag-uses / 3 tags per
    // page): ~1 tag per 2.5 pages, clamped so tiny and huge wikis stay sane.
    const totalUses = tagsWithCounts.reduce((s, [, n]) => s + n, 0);
    const approxPages = Math.max(1, Math.round(totalUses / 3));
    const target = Math.min(25, Math.max(6, Math.round(approxPages / 2.5)));
    const engine = await this.ensureEngine((t) => this.status(t));
    const { SamplerType } = await import('@litert-lm/core');
    let conversation: import('@litert-lm/core').Conversation | undefined;
    try {
      conversation = await engine.createConversation({
        preface: {
          messages: [
            {
              role: 'system',
              content:
                "You organize a personal wiki's tag vocabulary into a SMALL controlled list. Given " +
                'the tags currently in use (with how many pages use each), respond with ONLY a JSON ' +
                'object, no fences: {"vocabulary": ["tag", ...]}. ' +
                `Aim for about ${target} tags — a controlled vocabulary is meant to CONVERGE, not ` +
                'label every nuance. Merge aggressively: collapse near-synonyms AND narrow subtopics ' +
                'into their broader parent (e.g. llm-eval / llm-evaluation / evals -> llm-evaluation; ' +
                'index-funds / etf-basics / active-management -> investing; gpu-serving / llm-inference ' +
                '-> llm-optimization). Drop one-off noise. Prefer broad, reusable tags over fine ones. ' +
                'Every entry must be a TOPIC someone would browse by — a subject or domain term. Drop ' +
                'generic process words (extraction, editing, motion): they mean different things in ' +
                'different fields, so they group unrelated pages. ' +
                'Use lowercase kebab-case. Only reshape tags from the input — do NOT invent new topics.',
            },
          ],
        },
        sessionConfig: { samplerParams: { type: SamplerType.GREEDY }, maxOutputTokens: 512 },
      });
      const list = tagsWithCounts.map(([t, n]) => `- ${t} (${n})`).join('\n');
      this.status('Asking Gemma to organize the vocabulary…');
      const message = await conversation.sendMessage(`Tags in use:\n${list}`);
      const raw = textOf(message.content);
      const read = parseModelJson<{ vocabulary?: unknown }>(raw);
      if (!read.ok) {
        console.error(`[gemma-litert-wiki] cleanTagVocabulary: ${read.reason}`, raw);
        return [];
      }
      const parsed = read.value;
      if (!Array.isArray(parsed.vocabulary)) return [];
      return [...new Set(parsed.vocabulary.filter((t): t is string => typeof t === 'string').map((t) => slugify(t)).filter(Boolean))];
    } finally {
      await conversation?.delete().catch(() => {});
    }
  }

  // Retag existing wiki pages to the current vocabulary. Organizing the
  // vocabulary only affects FUTURE ingests, so after narrowing it (espresso ->
  // coffee) the already-written pages still carry the old tags — and the same
  // subject splits into two clusters that can each miss the concept threshold.
  // This is the catch-up move: map each off-vocabulary tag to its closest
  // vocabulary tag (one strict-JSON call for the whole set), show every
  // per-page change, and only write after Approve. Wiki pages only — raw
  // notes are never touched.
  async retagPagesToVocabulary() {
    const schema = await readSchema(this.app.vault);
    const rejected = new Set(schema.rejected.map((t) => slugify(t)));
    // Never map INTO a banned tag, even if a stale hand-edit left it in both lists.
    const vocab = [...new Set(schema.tags.map((t) => slugify(t)).filter((t) => t && !rejected.has(t)))];
    if (!vocab.length) {
      notify('warn', 'No vocabulary in schema.md yet — rebuild it first: run "Tidy the wiki" and tick the vocabulary repair, or add tags to schema.md by hand.');
      return;
    }
    const STRUCTURAL = new Set(['concept', 'answer', 'chat']);
    const vocabSet = new Set(vocab);
    // Collect each page's tags and the set of off-vocabulary ones.
    const pages: { file: TFile; tags: string[] }[] = [];
    const offVocab = new Set<string>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!isWikiPage(f)) continue;
      const fm = fmOf(this.app, f);
      if (fm?.kind === 'concept') continue; // concept pages are named BY their tag
      const raw = fm?.tags;
      const tags = Array.isArray(raw)
        ? raw.map((t) => String(t))
        : typeof raw === 'string'
          ? raw.split(/[,\s]+/).filter(Boolean)
          : [];
      if (!tags.length) continue;
      pages.push({ file: f, tags });
      for (const t of tags) {
        const s = slugify(t);
        if (s && !vocabSet.has(s) && !STRUCTURAL.has(s)) offVocab.add(s);
      }
    }
    if (!offVocab.size) {
      notify('noop', 'All page tags already match the vocabulary — nothing to retag.');
      return;
    }

    this.status(`Mapping ${offVocab.size} old tag${offVocab.size === 1 ? '' : 's'} to the vocabulary…`);
    let mapping: Map<string, string>;
    try {
      mapping = await this.mapTagsToVocabulary(vocab, [...offVocab]);
      this.statusEnd();
    } catch (err) {
      console.error('[gemma-litert-wiki] retag mapping failed', err);
      this.statusFail('Retag', err);
      return;
    }

    // Compute per-page changes. A tag with no confident mapping is KEPT —
    // losing information silently is worse than leaving a stray tag.
    const changes: { file: TFile; from: string[]; to: string[] }[] = [];
    for (const p of pages) {
      const to = [
        ...new Set(
          p.tags.map((t) => {
            const s = slugify(t);
            if (STRUCTURAL.has(s) || vocabSet.has(s)) return s;
            return mapping.get(s) ?? s;
          })
        ),
      ];
      const from = p.tags.map((t) => slugify(t));
      if (JSON.stringify(from) !== JSON.stringify(to)) changes.push({ file: p.file, from, to });
    }
    if (!changes.length) {
      notify('noop', 'The model kept every old tag as-is — nothing to retag.');
      return;
    }

    const summary = changes
      .map((c) => `${c.file.basename}:  ${c.from.join(', ')}  →  ${c.to.join(', ')}`)
      .join('\n');
    new ConfirmModal(this.app, {
      title: `Retag ${changes.length} page${changes.length === 1 ? '' : 's'} to the vocabulary`,
      body:
        `Old tags are rewritten to their vocabulary equivalents so past and future pages cluster ` +
        `together. Wiki pages only — your raw notes are not touched.\n\n${summary}`,
      confirmText: 'Retag pages',
      onResult: (ok) => {
        if (!ok) return;
        this.runApproved('Retag', async () => {
          for (const c of changes) {
            await this.app.fileManager.processFrontMatter(c.file, (fm: Record<string, unknown>) => {
              fm.tags = c.to;
            });
          }
          // Keep the mapping instead of discarding it. Deciding that
          // `llm-eval` means `evals` is the whole of an alias, the user has
          // just approved exactly that judgment on the screen above, and it
          // costs no model call to write down. Without it the knowledge lives
          // only in the rewritten pages, so a page that was not retagged —
          // one added later, one the user reverted — reads as unrelated to
          // its own subject forever.
          await this.rememberTagAliases(mapping);
          await appendLog(this.app.vault, 'retag', `${changes.length} pages to vocabulary`);
          notify('done', `Retagged ${changes.length} page${changes.length === 1 ? '' : 's'}.`);
        });
      },
    }).open();
  }

  /**
   * Write an approved retag mapping into schema.md's `## Aliases`.
   *
   * Additive and never destructive: an alias the user edited or deleted by
   * hand is theirs, so an existing entry is left alone rather than rewritten.
   * A mapping onto a tag the user has since banned is dropped, because
   * `## Rejected` outranks everything.
   */
  private async rememberTagAliases(mapping: Map<string, string>) {
    const schema = await readSchema(this.app.vault);
    const rejected = new Set(schema.rejected.map((t) => slugify(t)));
    const aliases = { ...schema.aliases };
    let added = 0;
    for (const [from, to] of mapping) {
      const a = slugify(from);
      const b = slugify(to);
      if (!a || !b || a === b || rejected.has(b)) continue;
      if (aliases[a]) continue;
      aliases[a] = b;
      added++;
    }
    if (!added) return;
    await writeWikiPage(this.app.vault, schemaPath(), buildSchemaFile({ ...schema, aliases }));
  }

  // One strict-JSON call: old tag -> closest vocabulary tag. Flat object in,
  // flat object out (the nested-schema lesson). Tolerant validation: a value
  // that isn't in the vocabulary means "keep the original tag".
  async mapTagsToVocabulary(vocab: string[], oldTags: string[]): Promise<Map<string, string>> {
    const engine = await this.ensureEngine((t) => this.status(t));
    const { SamplerType } = await import('@litert-lm/core');
    let conversation: import('@litert-lm/core').Conversation | undefined;
    try {
      conversation = await engine.createConversation({
        preface: {
          messages: [
            {
              role: 'system',
              content:
                'You map old wiki tags onto a controlled vocabulary. Respond with ONLY a JSON ' +
                'object, no fences: {"mapping": {"old-tag": "vocabulary-tag", ...}}. For each old ' +
                'tag pick the vocabulary tag that covers it (espresso -> coffee). If NO vocabulary ' +
                'tag fits, map the tag to itself to keep it. Values must come from the vocabulary ' +
                'or repeat the old tag — never invent new tags.',
            },
          ],
        },
        sessionConfig: { samplerParams: { type: SamplerType.GREEDY }, maxOutputTokens: 512 },
      });
      const message = await conversation.sendMessage(
        `Vocabulary:\n${vocab.map((v) => `- ${v}`).join('\n')}\n\nOld tags:\n${oldTags.map((t) => `- ${t}`).join('\n')}`
      );
      const raw = textOf(message.content);
      const read = parseModelJson<{ mapping?: Record<string, unknown> }>(raw);
      if (!read.ok) {
        // Named, because the three failures want three different responses:
        // a run that was cut off is worth repeating, a reply with no JSON in
        // it is not.
        console.error(`[gemma-litert-wiki] mapTagsToVocabulary: ${read.reason}`, raw);
        throw new Error(
          read.reason === 'cut-off'
            ? 'The model ran out of room before it finished — try again, or retag fewer tags at once.'
            : 'The model did not return usable JSON.'
        );
      }
      const parsed = read.value;
      const out = new Map<string, string>();
      const vocabSet = new Set(vocab);
      for (const t of oldTags) {
        const v = parsed.mapping?.[t];
        const slug = typeof v === 'string' ? slugify(v) : '';
        // Only accept a mapping into the vocabulary; anything else keeps the tag.
        if (slug && vocabSet.has(slug)) out.set(t, slug);
      }
      log('retag mapping', Object.fromEntries(out));
      return out;
    } finally {
      await conversation?.delete().catch(() => {});
    }
  }

  // Concept pages (issue #19): cluster pages by shared tag, write a short
  // overview of the cluster in one structured call, link to the members, and
  // gate it behind the same preview as everything else. Convergent (given a
  // fixed member list, write one overview) rather than open multi-step
  // generation.
  /**
   * The one command for the shape of the wiki, replacing five that were each
   * half of the job: Lint said what was wrong, Relink and Reconcile fixed two
   * of those things, and Organize/Retag were the two halves of a third. You
   * had to know all five names, and which order they went in — Retag even
   * printed "run Organize tags first", the plugin routing the user by hand.
   *
   * So: scan first, model-free and instant, then offer the repairs for what
   * the scan actually found. Each repair keeps its own preview; nothing here
   * writes without the gate it always had.
   */
  async tidyWiki() {
    this.status('Checking the wiki…');
    const report = await runLint(this.app);
    const tags = await this.tagHealth();
    // Capped for the same reason the contradiction sweep caps: a list longer
    // than a dialog can show is a list nobody reads, and the count says how
    // many were left out.
    const schemaNow = await readSchema(this.app.vault);
    const sameSubject = await findSameSubject(this.app, schemaNow.aliases, 12);
    this.statusEnd();
    new TidyModal(this.app, report, tags, sameSubject, async (chosen) => {
      // Free repairs first: they change the link graph the model would
      // otherwise be asked about, so running them first is fewer calls.
      if (chosen.has('reconcile')) await this.reconcileWiki();
      if (chosen.has('relink')) await this.relinkWikiPages();
      if (chosen.has('dedupe')) await this.linkSameSubjectPairs(sameSubject.pairs);
      // Two independent boxes: rebuild, apply, or both. Chaining them was the
      // merge quietly deleting the "I edited schema.md by hand" path.
      //
      // Strictly sequential, because each repair ends in a dialog and two
      // dialogs at once is not a review, it is a pile. Retag in particular
      // reads schema.md, so starting it before the new vocabulary is approved
      // and written meant applying the old one.
      let vocabularyWritten = true;
      if (chosen.has('organize')) vocabularyWritten = await this.suggestTagVocabulary();
      if (chosen.has('retag')) {
        if (vocabularyWritten) await this.retagPagesToVocabulary();
        else notify('noop', 'Vocabulary was not written, so pages were left alone.');
      }
    }).open();
  }

  /**
   * Model-free read of the tag vocabulary's state. The signal that matters is
   * not how many tags are pending but whether ingest has a vocabulary to reuse
   * at all: with `## Tags` empty every note coins its own, and near-duplicates
   * accumulate — seven coffee pages had grown twelve tags between them.
   *
   * Duplicate detection is by shared stem, deliberately: it is a string fact,
   * cheap and checkable, and it is only ever used to suggest running the pass
   * that does the real work.
   */
  private async tagHealth(): Promise<TagHealth> {
    const schema = await readSchema(this.app.vault);
    const inUse = new Map<string, number>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!isWikiPage(f)) continue;
      const raw = fmOf(this.app, f)?.tags;
      if (!Array.isArray(raw)) continue;
      for (const t of raw) {
        const s = slugify(String(t));
        if (s) inUse.set(s, (inUse.get(s) ?? 0) + 1);
      }
    }
    const stems = new Map<string, string[]>();
    for (const t of inUse.keys()) {
      const stem = t.split('-')[0];
      if (stem.length < 4) continue;
      stems.set(stem, [...(stems.get(stem) ?? []), t]);
    }
    const vocabSet = new Set(schema.tags.map((t) => slugify(t)));
    return {
      vocabulary: schema.tags.length,
      pending: schema.pending.length,
      inUse: inUse.size,
      offVocabulary: [...inUse.keys()].filter((t) => !vocabSet.has(t)).length,
      clusters: [...stems.values()].filter((g) => g.length > 1).map((g) => g.sort()),
    };
  }

  private async relinkWikiPages() {
      const entries = await this.liveIndexEntries();
      if (entries.length < 2) {
        notify('warn', 'Need at least two indexed pages to relink.');
        return;
      }
      const titleOf = new Map(entries.map((e) => [e.linkPath, e.title]));

      // The link graph as it stands. Related is written on the NEW page when
      // a page is ingested and never on the page it points at, so every link
      // was one-way: whatever was ingested first collected inbound links and
      // everything else stayed an orphan. Ten pages here, five of them
      // pointing at the same hub, six with no inbound link at all — and
      // relink could not fix it, because it skipped any page whose Related
      // section was merely healthy.
      const out = new Map<string, Set<string>>();
      const asWritten = new Map<string, string[]>();
      for (const e of entries) {
        const file = this.app.vault.getAbstractFileByPath(`${e.linkPath}.md`);
        if (!(file instanceof TFile)) continue;
        const content = await this.app.vault.read(file);
        const links = this.readRelatedLinksOn(content);
        asWritten.set(e.linkPath, links);
        // Links to pages that no longer exist are dropped here, which is
        // also how a stale section gets repaired: the desired set differs
        // from what is on disk, so the page ends up in the proposals.
        out.set(e.linkPath, new Set(links.filter((lp) => titleOf.has(lp))));
      }

      // Ask the model only where there is nothing to reciprocate. A page
      // with links already has the relationships it needs; what it lacks is
      // the other half of them.
      let i = 0;
      const empty = entries.filter((e) => !(out.get(e.linkPath)?.size));
      for (const entry of empty) {
        i++;
        this.status(`Relinking ${i}/${empty.length} — ${entry.title}…`);
        const candidates = entries.filter((e) => e.linkPath !== entry.linkPath);
        const related = await this.pickRelatedPages(entry.summary, candidates);
        const set = out.get(entry.linkPath);
        for (const r of related) if (titleOf.has(r.linkPath)) set?.add(r.linkPath);
      }
      this.statusEnd();

      // Mirror every link. Nothing is invented: a page only gains a link to
      // a page that already chose to link to it, so an orphan that genuinely
      // relates to nothing stays an orphan — which is the honest answer, and
      // the one that keeps this from being a way to flatter the lint report.
      for (const [from, targets] of [...out]) {
        for (const to of targets) out.get(to)?.add(from);
      }

      const proposals: RelinkProposal[] = [];
      for (const e of entries) {
        const now = [...(out.get(e.linkPath) ?? [])].sort();
        // Compared against the file, not against a count: a page carrying
        // two links of which one has gone stale keeps its count when the
        // dead one is dropped, and would otherwise never be rewritten.
        const same =
          now.length === (asWritten.get(e.linkPath)?.length ?? 0) &&
          now.every((lp, i) => asWritten.get(e.linkPath)?.[i] === lp);
        if (!now.length || same) continue;
        proposals.push({
          pagePath: `${e.linkPath}.md`,
          title: e.title,
          // Sorted so a rerun that changes nothing produces no diff.
          related: now.map((lp) => ({ linkPath: lp, title: titleOf.get(lp) ?? lp })),
        });
      }

      if (!proposals.length) {
        notify('noop', 'Nothing to relink — every link is already mutual, and no new matches were found.');
        return;
      }
      new RelinkPreviewModal(this.app, proposals, () => {
        this.runApproved('Relink', async () => {
          await this.writeRelatedSections(proposals, 'relink');
          notify('done', `Related sections updated on ${proposals.length} page${proposals.length === 1 ? '' : 's'}.`);
        });
      }).open();
  }

  /**
   * Record the relationship between pages that look like one subject.
   *
   * Deliberately the smallest possible repair. It adds each page of a flagged
   * pair to the other's Related section and stops there: nothing is merged,
   * nothing is deleted, and no page is rewritten beyond that one section. Two
   * notes about a subject are two pieces of writing and which of them to keep
   * — if either — is not a decision a tag-similarity check has any standing to
   * make. The plugin's job here is to stop the pair being invisible.
   *
   * Free: the pairs were found without a model and linking them needs none.
   */
  private async linkSameSubjectPairs(pairs: DuplicatePair[]) {
    if (!pairs.length) {
      notify('noop', 'No same-subject pairs to link.');
      return;
    }
    const entries = await this.liveIndexEntries();
    const titleOf = new Map(entries.map((e) => [e.linkPath, e.title]));

    // Accumulate per page: one page can be in several pairs, and writing its
    // Related section twice would drop the first edit.
    const wanted = new Map<string, Set<string>>();
    const add = (from: string, to: string) => {
      if (!wanted.has(from)) wanted.set(from, new Set());
      wanted.get(from)!.add(to);
    };
    for (const p of pairs) {
      add(p.a.linkPath, p.b.linkPath);
      add(p.b.linkPath, p.a.linkPath);
    }

    const proposals: RelinkProposal[] = [];
    for (const [linkPath, targets] of wanted) {
      const file = this.app.vault.getAbstractFileByPath(`${linkPath}.md`);
      if (!(file instanceof TFile)) continue;
      const existing = this.readRelatedLinksOn(await this.app.vault.read(file));
      // Keep what the page already says, drop links to pages that are gone,
      // and add the partner. A repair that quietly removed a link the user
      // had would not be the smallest possible repair.
      const now = [...new Set([...existing.filter((lp) => titleOf.has(lp)), ...targets])].sort();
      if (now.length === existing.length && now.every((lp, i) => existing[i] === lp)) continue;
      proposals.push({
        pagePath: `${linkPath}.md`,
        title: titleOf.get(linkPath) ?? file.basename,
        related: now.map((lp) => ({ linkPath: lp, title: titleOf.get(lp) ?? lp })),
      });
    }

    if (!proposals.length) {
      notify('noop', 'Those pages already link to each other.');
      return;
    }
    new RelinkPreviewModal(this.app, proposals, () => {
      this.runApproved('Link same-subject pages', async () => {
        await this.writeRelatedSections(proposals, 'dedupe');
        notify(
          'done',
          `Linked ${pairs.length} pair${pairs.length === 1 ? '' : 's'} across ${proposals.length} page${proposals.length === 1 ? '' : 's'}.`
        );
      });
    }).open();
  }

  /** Replace the Related section on each proposed page. Shared by relink and dedupe. */
  private async writeRelatedSections(proposals: RelinkProposal[], action: string) {
    for (const prop of proposals) {
      const file = this.app.vault.getAbstractFileByPath(prop.pagePath);
      if (!(file instanceof TFile)) continue;
      const content = await this.app.vault.read(file);
      const section =
        `\n## Related\n\n` +
        prop.related.map((r) => `- [[${r.linkPath}|${r.title}]]`).join('\n') +
        `\n`;
      // Replace rather than append: Related is the last section a generated
      // page carries, so truncating at it is safe, and a plain append would
      // leave two headings.
      const cut = content.indexOf('\n## Related');
      const head = cut === -1 ? content : content.slice(0, cut);
      await this.app.vault.modify(file, head.trimEnd() + '\n' + section);
      await appendLog(this.app.vault, action, prop.title);
    }
  }

  private async reconcileWiki() {
      const before = (await readIndexEntries(this.app.vault)).length;
      await this.pruneIndex();
      await this.pruneDeadRelatedLinks();
      const after = (await readIndexEntries(this.app.vault)).length;
      if (before === after) {
        notify('noop', 'Wiki is already consistent — no links to deleted pages.');
      } else {
        notify(
          'done',
          `Removed ${before - after} deleted page${before - after === 1 ? '' : 's'} from the index, ` +
            'and any related links pointing at them.'
        );
      }
  }

  async createConceptPage() {
    // Concept threshold (issue #39): a tag only becomes a concept-page
    // candidate once at least this many pages share it. Read from schema.md
    // ("config as a note") instead of a hardcoded number, so editing the
    // threshold there actually changes what is offered.
    const { conceptThreshold } = await readSchema(this.app.vault);
    const minMembers = Math.max(2, conceptThreshold);
    // Cluster pages by shared tag AND by shared mention (#48). Mentions are
    // the entities ingest already extracts — "the things several pages talk
    // about" is exactly what a concept page is for, so they are a second,
    // finer-grained source of candidates. It also gives the mentions field a
    // real consumer instead of being write-only. Grouped case-insensitively;
    // the first spelling seen names the cluster.
    const entries = await readIndexEntries(this.app.vault);
    const byLinkPath = new Map(entries.map((e) => [e.linkPath, e]));
    const clusters = new Map<string, IndexEntry[]>();
    const clusterLabel = new Map<string, string>();
    const SKIP = new Set(['concept', 'answer', 'chat']);
    const addTo = (key: string, label: string, entry: IndexEntry) => {
      if (!clusterLabel.has(key)) clusterLabel.set(key, label);
      const list = clusters.get(key) ?? [];
      // A page can carry the same subject as both a tag and a mention.
      if (!list.some((e) => e.linkPath === entry.linkPath)) list.push(entry);
      clusters.set(key, list);
    };
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!isWikiPage(f)) continue;
      const entry = byLinkPath.get(f.path.replace(/\.md$/, ''));
      if (!entry) continue;
      const fm = fmOf(this.app, f);
      // A concept page is never a MEMBER of a cluster — it carries its own
      // subject as a tag ([concept, coffee]), so on every rebuild the coffee
      // concept landed in the coffee cluster and listed itself under
      // ## Pages. Skipping the 'concept' cluster KEY was not enough (#62).
      if (fm?.kind === 'concept') continue;
      const raw = fm?.tags;
      const tags = Array.isArray(raw)
        ? raw.map((t) => String(t))
        : typeof raw === 'string'
          ? raw.split(/[,\s]+/).filter(Boolean)
          : [];
      for (const t of tags) {
        if (SKIP.has(t)) continue;
        addTo(slugify(t), t, entry);
      }
      const rawMentions = fm?.mentions;
      const mentions = Array.isArray(rawMentions)
        ? rawMentions.map((m) => String(m)).filter((m) => m.trim())
        : [];
      for (const m of mentions) {
        const key = slugify(m);
        if (!key || SKIP.has(key)) continue;
        addTo(key, m.trim(), entry);
      }
    }
    const candidates = [...clusters.entries()]
      .filter(([, members]) => members.length >= minMembers)
      .map(([key, members]) => ({ tag: clusterLabel.get(key) ?? key, members }))
      .sort((a, b) => b.members.length - a.members.length);

    if (!candidates.length) {
      notify(
        'noop',
        `No tag or mention is shared by ${minMembers}+ pages yet (concept threshold = ${minMembers}). ` +
          'Ingest more notes, or lower the threshold in schema.md.',
        DURATION.NORMAL
      );
      return;
    }

    new ConceptTagModal(this.app, candidates, (cluster) => {
      this.runApproved('Concept page', async () => {
        this.status(`Writing a concept overview for "${cluster.tag}"…`);
        let overview: string;
        try {
          overview = await this.summarizeConcept(cluster.tag, cluster.members);
          this.statusEnd();
        } catch (err) {
          console.error('[gemma-litert-wiki] concept overview failed', err);
          this.statusFail('Concept page', err);
          return;
        }
        const members = cluster.members.map((e) => ({ title: e.title, linkPath: e.linkPath }));
        const pagePath = conceptPagePath(cluster.tag);
        const pageContent = buildConceptPage(cluster.tag, overview, members);
        const overwriting = !!this.app.vault.getAbstractFileByPath(pagePath);
        new IngestPreviewModal(this.app, pagePath, pageContent, overwriting, () => {
          this.runApproved('Concept page', async () => {
            await ensureWikiScaffold(this.app.vault);
            await writeWikiPage(this.app.vault, pagePath, pageContent);
            await upsertIndexEntry(this.app.vault, pagePath, `${cluster.tag} (concept)`, overview.slice(0, 140));
            await appendLog(this.app.vault, 'concept', cluster.tag);
            this.statusEnd(`Concept page written: ${pagePath}`);
            this.refreshIngestBadges();
          });
          },
        undefined,
        {
          overwriteWarning:
            'Anything edited by hand in that file will be replaced. Generated pages are rebuilt ' +
            'from their source each time — to keep a correction, put it in the note instead.',
        }
        ).open();
      });
    }).open();
  }

  // One structured call: given a tag and its member page summaries, write a
  // short overview of what ties them together. Plain text out, not JSON —
  // it's prose, and the member list is fixed by the caller.
  async summarizeConcept(tag: string, members: IndexEntry[]): Promise<string> {
    const engine = await this.ensureEngine((t) => this.status(t));
    const { SamplerType } = await import('@litert-lm/core');
    let conversation: import('@litert-lm/core').Conversation | undefined;
    try {
      conversation = await engine.createConversation({
        preface: {
          messages: [
            {
              role: 'system',
              content:
                'You write a short concept overview for a personal wiki. Given a concept tag and ' +
                'one-line summaries of the pages tagged with it, write 2 to 4 sentences on what ties ' +
                'them together and what the concept is about. Respond with ONLY the overview prose — ' +
                'no title, no headings, no bullet list, no preamble.',
            },
          ],
        },
        sessionConfig: { samplerParams: { type: SamplerType.GREEDY }, maxOutputTokens: 400 },
      });
      const list = members.map((m) => `- ${m.title}: ${m.summary}`).join('\n');
      const message = await conversation.sendMessage(`Concept: ${tag}\n\nPages:\n${list}`);
      const raw = textOf(message.content);
      const text = raw.trim().replace(/^#+\s.*$/gm, '').trim();
      if (!text) throw new Error('Model returned an empty overview.');
      return text;
    } finally {
      await conversation?.delete().catch(() => {});
    }
  }

  // One strict-JSON judgment per page pair (single fill-in, not a tool loop).
  // Compares one-line summaries — cheap, and enough for a candidate flag the
  // human then verifies against the full pages.
  async judgeContradiction(
    titleA: string,
    summaryA: string,
    titleB: string,
    summaryB: string
  ): Promise<{ contradict: boolean; reason: string } | null> {
    const engine = await this.ensureEngine((t) => this.status(t));
    const { SamplerType } = await import('@litert-lm/core');
    let conversation: import('@litert-lm/core').Conversation | undefined;
    try {
      conversation = await engine.createConversation({
        preface: {
          messages: [
            {
              role: 'system',
              content:
                'You compare two knowledge-base entries and decide whether they CONTRADICT each ' +
                'other. Respond with ONLY a JSON object, no fences: ' +
                '{"contradict": "yes" or "no", "reason": "one short sentence"}. ' +
                'They contradict when they make OPPOSING claims about the same thing — one says a ' +
                'method works and the other says it does not, one says a quantity is enough and the ' +
                'other says it is not, one recommends an approach the other warns against. Both ' +
                'cannot be true at once. ' +
                'They do not contradict when they are simply about different topics, or cover the ' +
                'same topic without disagreeing. Judge the claims as written.',
            },
          ],
        },
        sessionConfig: { samplerParams: { type: SamplerType.GREEDY }, maxOutputTokens: 128 },
      });
      const message = await conversation.sendMessage(
        `Entry A — ${titleA}: ${summaryA}\n\nEntry B — ${titleB}: ${summaryB}`
      );
      const raw = textOf(message.content);
      const read = parseModelJson<{ contradict?: unknown; reason?: unknown }>(raw);
      if (!read.ok) {
        // `null` here means "these two pages agree", so an unreadable reply
        // must not quietly become one.
        console.error(`[gemma-litert-wiki] checkContradiction: ${read.reason}`, raw);
        return null;
      }
      const parsed = read.value;
      // Accept every reasonable spelling of yes. The field is named
      // "contradict", which reads boolean, so a model very naturally answers
      // `true` — and matching only the exact string "yes" turned that into a
      // silent NO. Same brittleness that made the related picker drop every
      // pick when the model tidied a title.
      const v = parsed.contradict;
      const contradict =
        v === true || (typeof v === 'string' && ['yes', 'true', 'y'].includes(v.trim().toLowerCase()));
      const verdict = { contradict, reason: typeof parsed.reason === 'string' ? parsed.reason : '' };
      log('contradiction verdict', {
        a: titleA,
        b: titleB,
        raw: v,
        contradict,
        reason: verdict.reason,
      });
      return verdict;
    } catch (err) {
      console.error('[gemma-litert-wiki] judgeContradiction parse/gen failed', err);
      return null; // a bad judgment just drops the pair; never blocks the sweep
    } finally {
      await conversation?.delete().catch(() => {});
    }
  }

  // One strict-JSON judgment per page: which claims does the source not
  // support? Validated against the actual key-point list (the model can only
  // flag points that were really there).
  //
  // This used to return `[]` on a bad parse, a failed generation or a thrown
  // error — the same value it returns when every key point traced cleanly. So
  // a run that never finished reported the page as verified, which is the
  // worst direction for this check to fail in. The caller now gets a result it
  // has to look at, and the report says how many pages could not be checked.
  async checkProvenance(sourceText: string, keyPoints: string[]): Promise<ProvenanceCheck> {
    const engine = await this.ensureEngine((t) => this.status(t));
    const { SamplerType } = await import('@litert-lm/core');
    let conversation: import('@litert-lm/core').Conversation | undefined;
    try {
      conversation = await engine.createConversation({
        preface: {
          messages: [
            {
              role: 'system',
              content:
                'You verify provenance. Given a SOURCE note and CLAIMS said to come from it, respond ' +
                'with ONLY a JSON object, no fences: {"unsupported": ["<claim>", ...]} listing the ' +
                'claims the source does NOT state or clearly imply. Copy unsupported claims verbatim. ' +
                'If every claim is supported, return {"unsupported": []}. Be fair — a claim the note ' +
                'clearly implies counts as supported.',
            },
          ],
        },
        sessionConfig: { samplerParams: { type: SamplerType.GREEDY }, maxOutputTokens: 256 },
      });
      const claimsBlock = keyPoints.map((p) => `- ${p}`).join('\n');
      const message = await conversation.sendMessage(`Source:\n${sourceText}\n\nClaims:\n${claimsBlock}`);
      const raw = textOf(message.content);
      const read = parseModelJson<{ unsupported?: unknown }>(raw);
      if (!read.ok) {
        console.error(`[gemma-litert-wiki] checkProvenance: ${read.reason}`, raw);
        return { ok: false, reason: read.reason };
      }
      if (!Array.isArray(read.value.unsupported)) {
        return { ok: false, reason: 'invalid-json' };
      }
      const valid = new Set(keyPoints);
      return {
        ok: true,
        unsupported: read.value.unsupported.filter(
          (u): u is string => typeof u === 'string' && valid.has(u)
        ),
      };
    } catch (err) {
      console.error('[gemma-litert-wiki] checkProvenance parse/gen failed', err);
      return { ok: false, reason: 'error' };
    } finally {
      await conversation?.delete().catch(() => {});
    }
  }

  // Background "to review" count (issue #2). Turns the setting on/off and
  // (re)arms the interval. Called on layout-ready and whenever the setting
  // changes. Counting is model-free, so it's safe to run unattended; only a
  // click on the chip spends GPU (via scanAndReviewIngest).
  rescheduleAutoScan() {
    if (this.autoScanIntervalId !== null) {
      window.clearInterval(this.autoScanIntervalId);
      this.autoScanIntervalId = null;
    }
    if (!this.settings.autoScanEnabled) {
      this.reviewCount = 0;
      this.renderStatusBar();
      return;
    }
    void this.refreshScanBadge();
    const ms = Math.max(1, this.settings.autoScanIntervalHours) * 3_600_000;
    this.autoScanIntervalId = window.setInterval(() => void this.refreshScanBadge(), ms);
    this.registerInterval(this.autoScanIntervalId);
  }

  // Deterministic count only — no engine, no GPU. Updates the status-bar
  // chip with how many notes are new or changed and worth reviewing.
  async refreshScanBadge() {
    if (!this.scanStatusEl || !this.settings.autoScanEnabled) return;
    try {
      // The count MUST use the same scope a scan would. It did not: this call
      // passed no includePrefixes, so the chip counted the entire vault while
      // a scan only ever looked at the configured folders. With "testing-cases"
      // configured, the chip could read "40 to review" and the scan it starts
      // would find three — a number that was wrong about the only thing it
      // existed to say.
      const result = await findIngestCandidates(this.app, {
        quietHours: this.settings.scanQuietHours,
        maxPerRun: NO_SCAN_CAP,
        includePrefixes: this.settings.scanInclude.split(',').map((s) => s.trim()).filter(Boolean),
        excludePrefixes: this.settings.scanExclude.split(',').map((s) => s.trim()).filter(Boolean),
      });
      this.reviewCount = result.eligible.length + result.cappedOut;
      this.renderStatusBar();
    } catch (err) {
      console.error('[gemma-litert-wiki] scan badge refresh failed', err);
      this.reviewCount = 0;
      this.renderStatusBar();
    }
  }

  // Semi-automatic ingest: scan (deterministic) → draft each candidate
  // (one model call apiece, same as manual ingest) → batch review gate.
  // The scan and the review modal live in auto-ingest.ts; the model calls
  // stay here because they need the engine. Drafting is only ever triggered
  // by the user (command or status-bar chip) — the background timer only
  // ever counts, never runs the model.
  //
  // Scan run-state: a scan drafts with the model for tens of seconds, so the
  // UI needs to know it is running (button shows "Stop scan") and be able to
  // cancel it. Cancel keeps the drafts already made — the GPU time is spent,
  // the user still reviews them — and stops before the next one.
  private scanRunning = false;
  private scanCancelled = false;
  // Set by the settings tab so the Scan button can follow the real state
  // instead of a label set once at click time — which lost track whenever the
  // pane re-rendered, leaving a running scan showing "Scan now".
  // A set, not a single slot. It was one callback, and the settings pane
  // cleared it on hide() — which was correct while the pane was the only thing
  // that set it, and became a way to silently kill someone else's updates the
  // moment a second consumer appeared. A chip frozen on "Stop scan" forever,
  // because a settings pane was opened and closed.
  private busyListeners = new Set<() => void>();

  /** Watch whether the plugin is running something. Returns the unsubscribe. */
  onScanState(fn: () => void): () => void {
    this.busyListeners.add(fn);
    return () => this.busyListeners.delete(fn);
  }

  private notifyBusyChange(): void {
    for (const fn of this.busyListeners) fn();
  }

  private setScanRunning(running: boolean): void {
    this.scanRunning = running;
    this.notifyBusyChange();
  }

  isScanning(): boolean {
    return this.scanRunning;
  }

  cancelScan(): void {
    if (!this.scanRunning) return;
    this.scanCancelled = true;
    // Say so immediately. A model call cannot be interrupted, so the note in
    // flight runs to completion — up to forty seconds — and nothing fires a
    // progress callback during generation, so the status sat on "Drafting
    // 7/30" the whole time. You pressed Stop and watched something claim to
    // still be drafting.
    this.status('Stopping — the note being drafted right now will finish first');
  }

  // File one open note as a wiki page. Extracted from the command callback
  // so the chat panel's empty state can offer it too — the moment a user is
  // looking straight at an empty wiki is the moment to hand them the way to
  // fill it, and a method is reachable where a command body is not.
  async ingestActiveNote() {
      if (this.refuseIfBusy()) return;
      const file = this.app.workspace.getActiveFile();
      if (!file) {
        notify('warn', 'Open a note first.');
        return;
      }
      const content = await this.app.vault.read(file);
      // Precheck gate (deterministic, no model call): skip empty,
      // frontmatter-only, and unchanged notes before the 20-40s model
      // call. "Unchanged" compares a content hash against the existing
      // page's source_hash.
      const pagePathForCheck = cardPathFor(this.app, file);
      const existingHash = getIngestedSourceHashes(this.app).get(file.path);
      const skip = precheckNote(content, existingHash);
      if (skip === 'empty' || skip === 'frontmatter-only') {
        notify(
          'noop',
          skip === 'empty' ? 'Note is empty — nothing to ingest.' : 'Note is only frontmatter — nothing to ingest.'
        );
        return;
      }
      if (skip === 'unchanged') {
        // Not silently skipped: the note is already ingested and unchanged,
        // but the user may want to re-ingest anyway — e.g. to regenerate its
        // related links after the index changed, or just to refresh the page.
        const proceed = await new Promise<boolean>((resolve) => {
          new ConfirmModal(this.app, {
            title: 'Already in the wiki',
            body:
              `"${file.basename}" is already ingested and unchanged. Re-ingest anyway? ` +
              'This regenerates its wiki page (summary, tags, related links) and overwrites the existing one — you still review before it is written.',
            confirmText: 'Re-ingest',
            onResult: resolve,
          }).open();
        });
        if (!proceed) return;
      }
      void pagePathForCheck;

      // Strip web-clip boilerplate (nav menus, footers, subscribe blocks)
      // before spending context on it — critical with a 4096-token model.
      const cleaned = cleanClippedMarkdown(content);
      // Clamp to the engine context (token-estimated, CJK-aware) rather
      // than rejecting on a char count — a summary card of the first
      // part beats nothing, and the marker tells the model the tail is
      // missing.
      const clamped = clampToTokens(cleaned, this.budget('ingest'));
      if (clamped.truncated) {
        // Same event as the chat panel's truncation message, so it says the
        // same thing: whose limit it is, and what you can do about it. The
        // old wording ("fits the local model context") blamed the model for
        // a cap this plugin chose.
        notify(
          'warn',
          `Only the first ~${Math.round(this.budget('ingest') / 1000)}k tokens of "${file.basename}" were ` +
            'read — the page below is based on that much. Raise Context window in settings to read more.'
        );
      }
      this.status(`Ingesting "${file.basename}"…`);
      try {
        const extraction = await this.extractNoteMetadata(clamped.text, (t) =>
          this.status(`Ingesting "${file.basename}" — ${t}`)
        );
        this.statusEnd();

        const sourceHash = contentHash(content);
        const pagePath = cardPathFor(this.app, file);
        const selfLink = pagePath.replace(/\.md$/, '');
        const candidates = (await this.liveIndexEntries()).filter(
          (e) => e.linkPath !== selfLink
        );
        let related: { title: string; linkPath: string }[] = [];
        if (candidates.length) {
          this.status(`Ingesting "${file.basename}" — finding related pages…`);
          related = await this.pickRelatedPages(extraction.summary, candidates);
          this.statusEnd();
        }
        const pageContent = buildWikiPage(file.basename, file.path, extraction, related, sourceHash);
        const overwriting = !!this.app.vault.getAbstractFileByPath(pagePath);

        const previewModal = new IngestPreviewModal(this.app, pagePath, pageContent, overwriting, () => {
          this.runApproved('Ingest', async () => {
            await ensureWikiScaffold(this.app.vault);
            await writeWikiPage(this.app.vault, pagePath, pageContent);
            await upsertIndexEntry(this.app.vault, pagePath, file.basename, extraction.summary);
            const pending = await queuePendingTags(this.app.vault, extraction.tags);
            this.notePendingGrowth(pending.before, pending.after);
            await this.rippleConceptPages(pagePath, [...extraction.tags, ...(extraction.mentions ?? [])]);
            await this.pruneIndex();
            await appendLog(this.app.vault, 'ingest', file.basename);
            this.statusEnd(`Wiki page written: ${pagePath}`);
            this.refreshIngestBadges();
          });
          },
        undefined,
        {
          overwriteWarning:
            'Anything edited by hand in that file will be replaced. Generated pages are rebuilt ' +
            'from their source each time — to keep a correction, put it in the note instead.',
        }
        );
        previewModal.open();
      } catch (err) {
        this.statusFail('Ingest', err);
      }
  }

  /**
   * Ask which folders, then scan them.
   *
   * This used to read a settings field and refuse when it was blank, which
   * made a command called "Scan a folder into the wiki" the one command that
   * would not let you pick a folder. The dialog does the asking now; the
   * settings field is only what it opens pre-ticked.
   *
   * Pass prefixes to skip the dialog — the background chip already knows what
   * it counted.
   */
  async scanAndReviewIngest(prefixes?: string[]) {
    if (this.scanRunning) {
      notify('warn', 'A scan is already running — run "Stop the running scan" to cancel it.');
      return;
    }
    if (this.refuseIfBusy()) return;
    const includePrefixes = prefixes ?? (await this.askScanFolders());
    if (!includePrefixes) return;
    if (!includePrefixes.length) return;
    this.setScanRunning(true);
    this.scanCancelled = false;
    try {
      await this.runScanAndReview(includePrefixes);
    } finally {
      this.setScanRunning(false);
      this.scanCancelled = false;
    }
  }

  /**
   * Build the folder list for the scan dialog, with an exact count per folder.
   *
   * One deterministic sweep over the whole vault, then bucket the results by
   * folder — rather than a sweep per folder, which would be the same work
   * multiplied by however many folders you have. No model runs here, so the
   * numbers are free and exact.
   *
   * Returns null if the user cancelled.
   */
  private async askScanFolders(): Promise<string[] | null> {
    const configured = this.settings.scanInclude.split(',').map((v) => v.trim()).filter(Boolean);
    const all = await findIngestCandidates(this.app, {
      quietHours: 0,
      maxPerRun: NO_SCAN_CAP,
      excludePrefixes: this.settings.scanExclude.split(',').map((v) => v.trim()).filter(Boolean),
    });

    // Bucket by the note's immediate parent folder. Notes at the vault root
    // are offered as one entry so they are reachable rather than invisible.
    const counts = new Map<string, number>();
    for (const c of all.eligible) {
      const slash = c.file.path.lastIndexOf('/');
      const folder = slash === -1 ? '/' : c.file.path.slice(0, slash);
      counts.set(folder, (counts.get(folder) ?? 0) + 1);
    }
    // A folder already in settings stays on the list even at zero, so an
    // existing choice never silently disappears from under the user.
    for (const c of configured) if (!counts.has(c)) counts.set(c, 0);

    const folders = [...counts.entries()]
      .map(([path, count]) => ({ path, count }))
      .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));

    return new Promise((resolve) => {
      new ScanFolderModal(this.app, {
        folders,
        preselected: configured.filter((c) => counts.has(c)),
        onCancel: () => resolve(null),
        onConfirm: (chosen) => {
          this.runApproved('Scan', async () => {
            // Remembered automatically, not behind a tick. You expect a dialog
            // to open where you left it, and the background count should watch
            // the folders you actually care about — which is the ones you last
            // scanned, not a field you filled in once and forgot.
            this.settings.scanInclude = chosen.join(', ');
            await this.saveSettings();
            resolve(chosen);
          });
        },
      }).open();
    });
  }

  private async runScanAndReview(includePrefixes: string[]) {
    this.status('Scanning for new or changed notes…');
    const result = await findIngestCandidates(this.app, {
      // Manual scan ignores the quiet period (issue #42): starting a scan
      // is an explicit ask — skipping the notes you just wrote is the opposite
      // of the intent. The quiet period only guards the background count,
      // where a timer could grab a half-written draft mid-edit.
      quietHours: 0,
      maxPerRun: NO_SCAN_CAP,
      includePrefixes,
      excludePrefixes: this.settings.scanExclude.split(',').map((s) => s.trim()).filter(Boolean),
    });
    let eligible = result.eligible;
    if (!eligible.length) {
      const quietNote = result.skippedQuiet
        ? ` (${result.skippedQuiet} skipped — edited within the quiet period)`
        : '';
      this.statusEnd();
      // Nothing new or changed — but if the scope holds already-ingested,
      // unchanged notes, offer to re-ingest them instead of dead-ending
      // (same gate the single-note command has). The point of re-ingesting
      // unchanged notes is regeneration: new vocabulary, new prompts.
      if (result.unchanged.length) {
        const n = result.unchanged.length;
        const proceed = await new Promise<boolean>((resolve) => {
          new ConfirmModal(this.app, {
            title: 'Everything here is already in the wiki',
            body:
              `No new or changed notes${quietNote} — but ${n} note${n === 1 ? ' is' : 's are'} already ` +
              'ingested and unchanged. Re-ingest to regenerate their pages (summary, tags, related) ' +
              'with the current vocabulary and prompts? You still review every draft before writing.',
            confirmText: `Re-ingest ${n} note${n === 1 ? '' : 's'}`,
            onResult: resolve,
          }).open();
        });
        if (!proceed) return;
        eligible = result.unchanged.map((file) => ({ file, reason: 'refresh' as const }));
      } else {
        notify(
          'noop',
          result.scanned
            ? `Scanned ${result.scanned} notes — nothing new or changed to ingest.${quietNote}`
            : 'No notes in scope to scan.',
          DURATION.NORMAL
        );
        return;
      }
    }

    // Draft each candidate through the same pipeline as manual ingest.
    // Failures are collected and skipped, never block the batch.
    const drafts: IngestDraft[] = [];
    let failed = 0;
    let cancelled = false;
    const n = eligible.length;
    // Drafting is one model call per note — minutes for a batch. Say so up
    // front, and say the settings pane is not holding it: users sat watching
    // a dialog they could have closed, unsure whether closing would cancel.
    notify(
      'progress',
      `Scanning ${n} note${n === 1 ? '' : 's'} — about one model call each, so this takes a while. ` +
        'Close Settings and keep working: progress runs in the status bar, and the review dialog ' +
        'waits for you there rather than interrupting. (To stop early, run "Stop the running scan".)',
      DURATION.LONG
    );
    // Pages drafted earlier in THIS batch are valid link targets for later
    // ones: they are about to be written together. Without this, scanning a
    // set of related notes into a fresh wiki gives every page an empty
    // Related section, because the index still holds only pre-batch pages.
    // (A draft the user then unticks can leave a link to a page that was
    // never written — the post-write prune below clears exactly that.)
    const batchEntries: IndexEntry[] = [];
    // Card paths minted so far in this run. Drafting happens before any write,
    // so without this two new notes with the same basename both see the name
    // free and the second replaces the first between the review list and disk —
    // the user approves four pages and gets three, with nothing saying which.
    const reservedPaths = new Set<string>();
    for (let i = 0; i < n; i++) {
      if (this.scanCancelled) {
        cancelled = true;
        break;
      }
      const { file, reason } = eligible[i];
      try {
        const content = await this.app.vault.read(file);
        const clamped = clampToTokens(cleanClippedMarkdown(content), this.budget('ingest'));
        const extraction = await this.extractNoteMetadata(clamped.text, (t) => {
          if (this.scanCancelled) return;
          this.status(`Drafting ${i + 1}/${n} — ${file.basename} · ${t}`);
        });
        const sourceHash = contentHash(content);
        const pagePath = cardPathFor(this.app, file, reservedPaths);
        const selfLink = pagePath.replace(/\.md$/, '');
        const candidates = [...(await this.liveIndexEntries()), ...batchEntries].filter(
          (e) => e.linkPath !== selfLink
        );
        let related: { title: string; linkPath: string }[] = [];
        if (candidates.length) {
          if (!this.scanCancelled) {
            this.status(`Drafting ${i + 1}/${n} — ${file.basename} · finding related pages…`);
          }
          related = await this.pickRelatedPages(extraction.summary, candidates);
        }
        batchEntries.push({ linkPath: selfLink, title: file.basename, summary: extraction.summary });
        drafts.push({
          file,
          reason,
          pagePath,
          overwriting: !!this.app.vault.getAbstractFileByPath(pagePath),
          pageContent: buildWikiPage(file.basename, file.path, extraction, related, sourceHash),
          summary: extraction.summary,
          tags: extraction.tags,
          confidence: extraction.confidence,
        });
      } catch (err) {
        console.error('[gemma-litert-wiki] draft failed', file.path, err);
        failed++;
      }
    }
    this.statusEnd();

    if (!drafts.length) {
      if (cancelled) notify('noop', 'Scan stopped — no drafts were finished.', DURATION.NORMAL);
      else notifyAndLog(this.app.vault, 'error', 'Every draft failed to generate — nothing to review.');
      return;
    }

    // The label this used to ride on is gone with the parking mechanism, but
    // the fact is not: a stopped scan leaves notes undrafted, and you should
    // hear that once rather than infer it from a shorter list than you expected.
    if (cancelled) {
      notify('info', 'You stopped the scan — the notes it had not reached are offered again next time.');
    }
    const reviewModal = new AutoIngestReviewModal(this.app, drafts, failed, async (approved) => {
      if (!approved.length) return;
      await ensureWikiScaffold(this.app.vault);
      // Track Pending across the whole batch so the nudge fires once for the
      // run, not once per approved page.
      let pendingBefore: number | null = null;
      let pendingAfter = 0;
      for (const d of approved) {
        await writeWikiPage(this.app.vault, d.pagePath, d.pageContent);
        await upsertIndexEntry(this.app.vault, d.pagePath, d.file.basename, d.summary);
        const pending = await queuePendingTags(this.app.vault, d.tags);
        if (pendingBefore === null) pendingBefore = pending.before;
        pendingAfter = pending.after;
        await this.rippleConceptPages(d.pagePath, d.tags);
        await appendLog(this.app.vault, 'ingest', d.file.basename);
      }
      if (pendingBefore !== null) this.notePendingGrowth(pendingBefore, pendingAfter);
      await this.pruneIndex();
      // Drafts could link to each other; if the user approved only some, the
      // survivors may point at a page that was never written. Clear those.
      await this.pruneDeadRelatedLinks();
      this.refreshIngestBadges();
      void this.refreshScanBadge();
      // Say what comes next, but only when this batch is why it is needed:
      // ingest coins tags page by page, so a batch that queued new ones has
      // just fragmented the vocabulary a little, and Tidy is the tool for
      // that. A batch that reused the vocabulary throughout gets the short
      // sentence — advice that fires every time is furniture.
      const coined = pendingBefore !== null && pendingAfter > pendingBefore;
      notify(
        'done',
        `Wrote ${approved.length} page${approved.length === 1 ? '' : 's'} to the wiki.` +
          (coined
            ? ' Their tags were coined page by page — "Tidy the wiki" folds near-duplicates into one vocabulary.'
            : '')
      );
    });
    // Drafting a batch takes minutes, and this dialog opens wherever you are
    // when it finishes. It used to park on the status bar if you had switched
    // notes or typed while it ran — which asked you to sit and watch a
    // multi-minute run to get the ordinary behaviour, and hid the result of
    // exactly the run you were least likely to go looking for.
    reviewModal.open();
  }

  // The one write operation that touches a raw note — and therefore the
  // most tightly constrained call in the plugin: structure, formatting,
  // and typos only, wording and voice preserved, full result shown in the
  // preview gate before a single byte is written. The per-pass input cap is
  // token-estimated per script, not a flat char count: English runs
  // ~4 chars/token but CJK runs ~1-1.5 tokens/char, so the old flat
  // 5000-char cap (calibrated on English ≈ 1250 tokens) overflowed the
  // context window on Chinese notes and guaranteed a 2048-token
  // output truncation — the same failure mode that bit the V1 grammar
  // tests twice.
  //
  // A note over that cap is no longer a dead end. It used to stop at "select
  // a section and run Improve again" — i.e. do the splitting by hand. Now it
  // is split on heading and blank-line boundaries into passes that each fit,
  // rewritten one pass at a time with a fresh conversation, and stitched back
  // together before the preview gate.
  async improveActiveNote() {
    if (this.refuseIfBusy()) return;
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      notify('warn', 'Open a note first.');
      return;
    }
    // With a selection active, improve just the selection — still the way to
    // aim Improve at one section instead of the whole note.
    const mdView = this.app.workspace
      .getLeavesOfType('markdown')
      .map((l) => l.view)
      .find((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === file.path);
    const editor = mdView?.editor;
    const selection = editor?.getSelection() ?? '';
    const usingSelection = !!selection.trim();
    // A multi-pass run takes minutes and the cursor will have moved by the
    // time the user approves — pin the range now, not at approval time.
    const selFrom = usingSelection ? editor?.getCursor('from') : undefined;
    const selTo = usingSelection ? editor?.getCursor('to') : undefined;
    const content = usingSelection ? selection : await this.app.vault.read(file);
    if (!content.trim()) {
      notify('noop', 'Note is empty — nothing to improve.');
      return;
    }

    // Frontmatter is metadata, not prose: hand it back untouched rather than
    // ask the model to retype it, and keep a chunk boundary from landing
    // inside it.
    let frontmatter = '';
    let body = content;
    if (!usingSelection) {
      const fm = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
      if (fm) {
        frontmatter = fm[0];
        body = content.slice(fm[0].length);
      }
    }
    if (!body.trim()) {
      notify('noop', 'Note is only frontmatter — nothing to improve.');
      return;
    }

    // Budget per pass, derived from the configured context window: the input
    // plus a same-sized rewrite plus the system prompt all have to fit.
    const MAX_INPUT_TOKENS = this.budget('improve');
    const chunks = chunkForImprove(body, MAX_INPUT_TOKENS);
    const passes = chunks.filter((c) => !c.verbatim && c.raw.trim()).length;
    if (passes === 0) {
      notify('noop', 'Nothing to improve — this note is one oversized code block, which is preserved as-is.');
      return;
    }
    // Each pass is roughly half a minute of GPU time. Past a couple of them
    // the user should get to decide before it starts, not discover it after.
    if (passes >= 3) {
      const proceed = await new Promise<boolean>((resolve) => {
        new ConfirmModal(this.app, {
          title: 'Improve a long note',
          body:
            `${usingSelection ? 'The selection' : `"${file.basename}"`} is ~${estimateImproveTokens(body)} tokens — ` +
            "more than one pass fits in the model's context window, so Improve will work through it in " +
            `${passes} passes, split on headings and blank lines, and stitch the result back together.\n\n` +
            'Budget roughly half a minute per pass. You still review the whole result before anything is written.',
          confirmText: `Run ${passes} passes`,
          onResult: resolve,
        }).open();
      });
      if (!proceed) return;
    }

    const systemPrompt =
      'You are a careful copy editor for Obsidian markdown notes. Improve ONLY ' +
      'structure and formatting: headings, list markers, blank-line spacing, and ' +
      'obvious spelling mistakes.\n\n' +
      'PRESERVE exactly, character for character:\n' +
      "- The author's wording, voice, ideas, and language (never translate)\n" +
      '- YAML frontmatter\n' +
      '- [[wikilinks]], ![[embeds]], #tags, > [!callouts]\n' +
      '- Code blocks, tables, and any ASCII/box-drawing diagrams\n\n' +
      'Never add, remove, summarize, or rephrase content. When unsure whether ' +
      'something is a typo, leave it as written. If the note is already well ' +
      'formatted, return it unchanged.\n\n' +
      (passes > 1
        ? 'You are given ONE SECTION of a longer note, not the whole note. Return that ' +
          'section only — never add a title, an introduction, a conclusion, or a remark ' +
          'that text appears to be missing. Do not renumber headings.\n\n'
        : '') +
      'Return ONLY the markdown, no explanation.';
    this.status(`Improving "${file.basename}"…`);
    const pieces: string[] = [];
    let failed = 0;
    try {
      const engine = await this.ensureEngine((t) => this.status(`Improving "${file.basename}" — ${t}`));
      const { SamplerType } = await import('@litert-lm/core');
      let pass = 0;
      for (const chunk of chunks) {
        // Chunks carry their own surrounding whitespace so that rejoining is
        // a plain concatenation; the model only ever sees the text between.
        // It matters down to the single space: an English paragraph cut at a
        // sentence boundary leaves the following space on the next chunk, and
        // the model's answer comes back trimmed.
        const leading = /^\s*/.exec(chunk.raw)![0];
        const trailing = /\s*$/.exec(chunk.raw)![0];
        const text = chunk.raw.slice(leading.length, chunk.raw.length - trailing.length);
        if (chunk.verbatim || !text.trim()) {
          pieces.push(chunk.raw);
          continue;
        }
        pass++;
        const label = passes > 1 ? ` — pass ${pass}/${passes}` : '';
        this.status(`Improving "${file.basename}"${label}…`);
        // A fresh conversation per pass: the previous section must not sit in
        // context, or the budget the chunking just enforced means nothing.
        // Output is a same-sized rewrite of the input; cap it just above the
        // input estimate instead of a flat 2048 so short passes can't run away
        // and long CJK passes aren't silently truncated.
        const budget = Math.min(2048, estimateImproveTokens(text) + 300);
        let conversation: import('@litert-lm/core').Conversation | undefined;
        try {
          conversation = await engine.createConversation({
            preface: { messages: [{ role: 'system', content: systemPrompt }] },
            sessionConfig: {
              samplerParams: { type: SamplerType.GREEDY },
              maxOutputTokens: budget,
            },
          });
          const message = await conversation.sendMessage(text);
          const raw = textOf(message.content);
          const improved = raw
            .trim()
            .replace(/^```(?:markdown|md)?\s*/i, '')
            .replace(/```\s*$/i, '')
            .trim();
          if (!improved) throw new Error('Model returned an empty result.');
          // Improve overwrites the user's own note, so a pass that did not
          // finish is worse than a pass that did nothing. Both checks below
          // fail the pass into the path that already exists for that: keep
          // the author's text for this section and say so at the end.
          //
          // A chunk cut out of the middle of a long paragraph legitimately
          // ends mid-sentence, and its rewrite will too — so the output only
          // counts as cut off when the input it was given did not end that
          // way.
          if (looksCutOff(improved, budget).cutOff && !looksCutOff(text).midSentence) {
            throw new Error('Model output stopped mid-sentence at the token budget.');
          }
          if (looksRepetitive(improved).repetitive && !looksRepetitive(text).repetitive) {
            throw new Error('Model output collapsed into a repetition loop.');
          }
          pieces.push(leading + improved + trailing);
        } catch (err) {
          // One bad pass must not cost the user the other twenty: keep the
          // author's text for that section and say so at the end.
          console.error(`[gemma-litert-wiki] improve pass ${pass}/${passes} failed`, err);
          failed++;
          pieces.push(chunk.raw);
        } finally {
          await conversation?.delete().catch(() => {});
        }
      }
      this.statusEnd();
      if (failed === passes) {
        throw new Error(`all ${passes} pass${passes === 1 ? '' : 'es'} failed — see the console`);
      }
      const improved = frontmatter + pieces.join('');

      const source =
        (usingSelection ? `${file.path} (selected text only)` : file.path) +
        (passes > 1 ? ` — ${passes} passes` : '') +
        (failed > 0 ? `, ${failed} left unchanged (failed)` : '');
      if (failed > 0) {
        notify(
          'warn',
          `${failed} of ${passes} passes failed; those sections are unchanged in the preview. ` +
            'Press Cmd/Ctrl+Opt+I for the full error.'
        );
      }
      const previewModal = new IngestPreviewModal(this.app, source, improved, true, () => {
        this.runApproved('Improve', async () => {
          // The note is read before the run and written after approval, and a
          // multi-pass run is minutes of GPU time with the preview then open
          // for as long as the user likes. Anything typed in that window is
          // not in `improved`, so writing it back would silently delete their
          // edit — in the one feature that rewrites a note they wrote.
          //
          // Same test the review board uses for drift, against the same hash.
          // Refuse rather than merge: the two versions are a stitched rewrite
          // and a hand edit, and picking between them is the author's call.
          // For a selection the range was pinned before the run, so the test
          // has to be positional, not "is that text still somewhere in the
          // note": typing ABOVE the selection leaves the text present and the
          // coordinates stale, and replaceRange would then splice the rewrite
          // over whatever now sits at those lines.
          const changed =
            usingSelection && editor && selFrom && selTo
              ? editor.getRange(selFrom, selTo) !== selection
              : (await this.app.vault.read(file)) !== content;
          if (changed) {
            notify(
              'warn',
              `"${file.basename}" changed while Improve was running, so nothing was written — ` +
                'your edit is intact. Run Improve again to work from the current text.'
            );
            return;
          }
          if (usingSelection && editor && selFrom && selTo) {
            editor.replaceRange(improved, selFrom, selTo);
          } else {
            await this.app.vault.modify(file, improved);
          }
          await appendLog(this.app.vault, 'improve', file.basename);
          notify('done', `Note updated: ${file.basename}`);
        });
      }, 'Review your note before it is rewritten');
      // A multi-pass rewrite is minutes of GPU time. Same rule as scan: if you
      // walked away, the preview waits on the status bar instead of taking the
      // window back.
      previewModal.open();
    } catch (err) {
      this.statusFail('Improve', err);
    }
  }

  // Second single-schema call in the ingest flow: given the new page's
  // summary and the index catalog, pick up to 3 genuinely related existing
  // pages. A convergent multiple-choice task, not open generation — the
  // model can only answer with titles from the provided list, and anything
  // else is dropped in validation. Failure returns [] and never blocks
  // ingest; related links are an enhancement, not a requirement.
  //
  // Prompt design (deliberate, and corrected once):
  // - The model's only evidence is the summaries, so the criterion is
  //   anchored there: a SPECIFIC subject (concept / entity / method /
  //   question) that appears in BOTH summaries — not "feels related",
  //   which a one-line summary cannot support, and not a shared broad
  //   field, which over-links everything in a small single-topic wiki.
  // - The OUTPUT stays a flat list of titles. An earlier version demanded
  //   {"title","shared"} objects so each pick had to justify itself; that
  //   read well but broke in practice — nested JSON is a much harder
  //   generation task for a 4B, the per-pick explanations bloated the
  //   response into truncation, and any imperfection was silently dropped,
  //   so pages came out with NO related links at all. Reliability wins:
  //   keep the strict criterion in prose, keep the schema trivial.
  // - The empty case is stated neutrally ("when no page qualifies"), not
  //   praised — praising it makes a small model lazily return [] and
  //   starves the wiki of the real cross-links it exists for.
  async pickRelatedPages(
    summary: string,
    candidates: IndexEntry[]
  ): Promise<{ title: string; linkPath: string }[]> {
    try {
      const engine = await this.ensureEngine(() => {});
      const { SamplerType } = await import('@litert-lm/core');
      // Only ~30 pages fit in the catalog prompt (4B context). Taking the
      // FIRST 30 by index order meant pages 31+ could never be linked
      // (issue #15). Instead rank by lexical overlap with the new summary so
      // the 30 shown are the most relevant, falling back to index order to
      // fill any remaining slots (keeps CJK/low-overlap pages reachable).
      const RELATED_POOL = 30;
      let pool = candidates;
      if (candidates.length > RELATED_POOL) {
        const terms = summary.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
        pool = candidates
          .map((e, i) => {
            const hay = `${e.title} ${e.summary}`.toLowerCase();
            const score = terms.reduce((a, t) => a + (hay.includes(t) ? 1 : 0), 0);
            return { e, score, i };
          })
          .sort((a, b) => b.score - a.score || a.i - b.i)
          .slice(0, RELATED_POOL)
          .map((s) => s.e);
      }
      const catalog = pool.map((e) => `- ${e.title}: ${e.summary}`).join('\n');
      let conversation: import('@litert-lm/core').Conversation | undefined;
      try {
        conversation = await engine.createConversation({
          preface: {
            messages: [
              {
                role: 'system',
                content:
                  'You cross-link pages in a personal wiki. The user gives you a new page summary ' +
                  'and a catalog of existing pages (title: summary). Respond with ONLY a JSON ' +
                  'object, no fences, no explanation: {"related": ["Exact Title", ...]}. ' +
                  'Include a page only if a SPECIFIC concept, entity, method, or question appears ' +
                  'in BOTH its summary and the new page summary. Belonging to the same general ' +
                  'field is not enough. At most 3, strongest first; titles must match the catalog ' +
                  'EXACTLY. Return {"related": []} when no page qualifies.',
              },
            ],
          },
          sessionConfig: {
            samplerParams: { type: SamplerType.GREEDY },
            maxOutputTokens: 256,
          },
        });
        const message = await conversation.sendMessage(
          `New page summary: ${summary}\n\nCatalog:\n${catalog}`
        );
        const raw = textOf(message.content);
        const read = parseModelJson<{ related?: unknown }>(raw);
        if (!read.ok) {
          console.error(`[gemma-litert-wiki] pickRelated: ${read.reason}`, raw);
          return [];
        }
        const parsed = read.value;
        if (!Array.isArray(parsed.related)) return [];
        const byTitle = new Map(candidates.map((e) => [e.title, e]));
        // Entries are titles. An object with a `title` is still accepted —
        // if the model volunteers a richer shape we take the title rather
        // than dropping the pick, since a dropped pick is indistinguishable
        // from "nothing qualified" to the user.
        const titles = parsed.related
          .map((r) => {
            if (typeof r === 'string') return r;
            if (r && typeof r === 'object' && typeof (r as { title?: unknown }).title === 'string') {
              return (r as { title: string }).title;
            }
            return null;
          })
          .filter((t): t is string => !!t);
        // Resolve titles tolerantly. The model has to echo a catalog title
        // verbatim, and these are often slugs ("llm-inference-optimization");
        // a 4B that tidies one into "LLM Inference Optimization" would have
        // every pick dropped by an exact lookup, producing an empty Related
        // section indistinguishable from "nothing qualified". Match on a
        // normalized key (case, spacing and punctuation folded), then fall
        // back to the page's slug.
        const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
        const byNorm = new Map<string, IndexEntry>();
        for (const e of candidates) {
          byNorm.set(norm(e.title), e);
          const slug = e.linkPath.split('/').pop();
          if (slug) byNorm.set(norm(slug), e);
        }
        const resolved = titles
          .map((t) => byTitle.get(t) ?? byNorm.get(norm(t)))
          .filter((e): e is IndexEntry => !!e);
        if (titles.length && !resolved.length) {
          // The model answered but nothing matched the catalog — a distinct
          // failure from "no page qualified", and one the user cannot see.
          console.warn(
            '[gemma-litert-wiki] related-pages: model returned titles that match no catalog entry',
            { returned: titles, catalog: candidates.map((c) => c.title) }
          );
        }
        // De-dupe: two spellings can resolve to the same page.
        const seen = new Set<string>();
        return resolved
          .filter((e) => (seen.has(e.linkPath) ? false : (seen.add(e.linkPath), true)))
          .slice(0, 3)
          .map((e) => ({ title: e.title, linkPath: e.linkPath }));
      } finally {
        await conversation?.delete().catch(() => {});
      }
    } catch (err) {
      // Non-blocking: ingest proceeds without related links. Logged loudly
      // because an empty Related section otherwise looks identical to
      // "nothing qualified" — this is how a broken picker stayed invisible.
      console.error('[gemma-litert-wiki] related-pages pick FAILED — page will have no Related section', err);
      return [];
    }
  }

  // One strict JSON fill-in per operation — no tool loops, no multi-step
  // planning. Validated shape, one retry on parse failure. This is the
  // engineering rule the whole MVP is built on: small local models are
  // unreliable at chaining steps and reliable at filling one schema.
  async extractNoteMetadata(
    noteContent: string,
    onProgress: (text: string) => void
  ): Promise<NoteExtraction> {
    const engine = await this.ensureEngine(onProgress);
    const { SamplerType } = await import('@litert-lm/core');

    // Schema layer (issues #3, #38, #47): reuse existing tags instead of
    // inventing a fresh synonym every time ("llm-eval" vs "llm-evaluation" vs
    // "evals"). This is a UNION of every tag the wiki already knows, in
    // descending authority: the curated schema.md vocabulary, then Pending
    // (used but not yet approved), then anything else in use, frequency-ranked.
    //
    // It used to be a binary either/or — schema tags IF ANY, else the tags in
    // use. That collapsed on a young wiki: a single curated tag is "truthy",
    // so a vocabulary of one irrelevant tag suppressed the fallback entirely
    // and every note coined fresh tags. Worse, Pending was never shown at all,
    // so a tag sitting there ("espresso") did nothing to stop the next note
    // coining "espresso-basics" — the cluster fragmented and never reached the
    // concept-page threshold. Capped so the list never crowds the context.
    const VOCAB_CAP = 40;
    const schema = await readSchema(this.app.vault);
    const rejectedTags = new Set(schema.rejected.map((t) => slugify(t)));
    const vocab: string[] = [];
    const seenTag = new Set<string>();
    for (const t of [...schema.tags, ...schema.pending, ...this.wikiTagCounts().map(([tag]) => tag)]) {
      const tag = slugify(t);
      if (!tag || seenTag.has(tag) || rejectedTags.has(tag)) continue;
      seenTag.add(tag);
      vocab.push(tag);
      if (vocab.length >= VOCAB_CAP) break;
    }
    const vocabLine = vocab.length
      ? ` Prefer tags from this list when one fits, reusing the exact spelling: ${vocab.join(', ')}. Only coin a new tag if none of these apply.`
      : '';
    // Naming rule (issue #40): the schema.md "Naming" section's `concept:` rule
    // actually shapes new tag names by guiding the model — so editing that line
    // changes output, instead of being a dead descriptive note. (kebab-case is
    // still enforced mechanically by slugify; this covers the rest, e.g.
    // "singular noun", and works for any language the model handles.)
    const namingLine = schema.naming.concept
      ? ` When you must coin a new tag, name it following this convention: ${schema.naming.concept}.`
      : '';

    // The second attempt used to run with exactly the same parameters as the
    // first: try again and hope. It now knows why the first one failed, which
    // is enough to widen the output budget in the one case where more room is
    // the actual fix — and, more importantly, to NOT widen in the case that
    // looks identical from the outside. See nextOutputCap.
    let cap = INGEST_OUTPUT_TOKENS;
    let failure: { reason: ParseFailure | null; repetitive: boolean } | null = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      onProgress(attempt === 1 ? 'Extracting…' : 'Extracting (retry)…');
      let conversation: import('@litert-lm/core').Conversation | undefined;
      failure = null;
      try {
        conversation = await engine.createConversation({
          preface: {
            messages: [
              {
                role: 'system',
                content:
                  'You extract structured metadata from a note. Respond with ONLY a single JSON object, ' +
                  'no markdown fences, no explanation: ' +
                  '{"summary": "one sentence", "tags": ["a", "b", "c"], "key_points": ["...", "...", "..."], ' +
                  '"confidence": "high", "mentions": ["Name or Concept", "..."]}. ' +
                  '1 to 3 tags. A tag names the note\'s TOPIC — a subject several notes could ' +
                  'share — using domain terminology, NOT the note\'s fine details and NOT a generic ' +
                  'process word (extraction, editing, motion) that means different things in ' +
                  'different fields. One good topic tag beats three narrow ones. 3 to 5 key_points, each ONE short ' +
                  'self-contained sentence stating concrete content from the note. confidence is ' +
                  '"high", "med", or "low": how faithfully your summary and key_points represent the ' +
                  'note (use "low" for dense, ambiguous, or heavily technical notes you may have ' +
                  'misread). mentions: 0 to 6 salient named entities or concepts the note actually ' +
                  "refers to (proper nouns, technologies, specific concepts), in the note's own " +
                  'language; [] if none stand out.' +
                  vocabLine +
                  namingLine,
              },
            ],
          },
          sessionConfig: {
            samplerParams: { type: SamplerType.GREEDY },
            maxOutputTokens: cap,
          },
        });

        const message = await conversation.sendMessage(noteContent);
        const raw = textOf(message.content);
        const read = parseModelJson<NoteExtraction>(raw);
        if (!read.ok) {
          // Recorded before it is thrown, because the retry has to know
          // whether this was a run out of room or a run off the rails.
          failure = { reason: read.reason, repetitive: looksRepetitive(raw).repetitive };
          throw new Error(`Model output unusable (${read.reason}).`);
        }
        const parsed = read.value;
        const valid =
          typeof parsed?.summary === 'string' &&
          Array.isArray(parsed.tags) &&
          parsed.tags.length >= 1 &&
          parsed.tags.every((t) => typeof t === 'string') &&
          Array.isArray(parsed.key_points) &&
          parsed.key_points.length >= 1 &&
          parsed.key_points.every((p) => typeof p === 'string');
        if (valid) {
          // A repetition loop lands INSIDE a valid JSON string, so every check
          // above passes it: `summary` is a string and `tags` has three
          // entries whether the summary says something or says one phrase
          // forty times. Greedy decoding at 768 output tokens is well inside
          // the range where such a loop completes rather than truncating, so
          // nothing else here would notice. Throwing spends the one retry this
          // function already has.
          if (
            looksRepetitive(parsed.summary).repetitive ||
            parsed.key_points.some((k) => looksRepetitive(k).repetitive)
          ) {
            // Parsed cleanly and is still a loop, so more room is certainly
            // not the fix. Recorded so the retry does not go looking for one.
            failure = { reason: null, repetitive: true };
            throw new Error('Model output collapsed into a repetition loop.');
          }
          // Tolerate a missing/invalid confidence rather than failing the
          // whole extraction — default to 'med'.
          if (!['high', 'med', 'low'].includes(parsed.confidence)) parsed.confidence = 'med';
          // mentions is optional (issue #18) — default to [] and cap at 6 so
          // a model that omits or over-produces it never fails the extraction.
          // Trimmed and de-duped case-insensitively (#48): the model emits
          // "Espresso" on one page and "espresso" on the next, which would
          // otherwise read as two different entities everywhere mentions are
          // grouped. First spelling seen wins, so the display keeps the
          // model's own capitalisation for proper nouns.
          const seenMention = new Set<string>();
          parsed.mentions = Array.isArray(parsed.mentions)
            ? parsed.mentions
                .filter((m): m is string => typeof m === 'string' && !!m.trim())
                .map((m) => m.trim())
                .filter((m) => {
                  const key = m.toLowerCase();
                  if (seenMention.has(key)) return false;
                  seenMention.add(key);
                  return true;
                })
                .slice(0, 6)
            : [];
          // A banned tag never lands on a page, no matter what the model says.
          parsed.tags = parsed.tags.filter((t) => !rejectedTags.has(slugify(t)));
          // Force the summary to a single line: index.md is one-entry-per-line,
          // so a multi-line summary would break across lines and pollute the
          // index with non-entry junk.
          parsed.summary = parsed.summary.replace(/\s*\n\s*/g, ' ').trim();
          return parsed;
        }
        throw new Error('Model returned JSON with the wrong shape.');
      } catch (err) {
        if (attempt === 2) throw err;
        const decision = nextOutputCap({
          current: cap,
          // The window the engine granted, not the one in settings — those
          // differ, which is the whole reason the granted value is kept.
          granted: this.effectiveContextTokens ?? this.settings.contextTokens ?? 4096,
          inputTokens: estimateImproveTokens(noteContent),
          reason: failure?.reason ?? null,
          repetitive: failure?.repetitive ?? false,
        });
        if (decision.widen) {
          console.warn(
            `[gemma-litert-wiki] extraction was cut off at ${cap} tokens; retrying at ${decision.cap}`
          );
          cap = decision.cap;
        } else {
          console.warn(`[gemma-litert-wiki] retrying at the same cap (${decision.why})`);
        }
      } finally {
        await conversation?.delete().catch(() => {});
      }
    }
    throw new Error('unreachable');
  }

  async loadSettings() {
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...((await this.loadData()) as Partial<GemmaWikiSettings> | null),
    };
    setDebugLogging(this.settings.devCommands);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // Follows the toggle immediately: turning Developer commands on to
    // investigate something and then having to reload to see any output would
    // make the setting useless for the one thing it is for.
    setDebugLogging(this.settings.devCommands);
  }

  // Rename the wiki folder and rewrite the internal links that name it.
  // source: frontmatter points at raw notes (untouched); only the layer's
  // own paths (index links, Related links, path-prefixed wikilinks) move.
  async renameWikiDir(prev: string, next: string) {
    const p = new Progress(`Renaming ${prev} → ${next}…`);
    let skipped = 0;
    try {
      const prevFolder = this.app.vault.getAbstractFileByPath(prev);
      if (prevFolder instanceof TFolder) {
        // Rewrite internal references inside every markdown file first, so
        // links stay valid after the move.
        for (const file of this.app.vault.getMarkdownFiles()) {
          if (!file.path.startsWith(`${prev}/`)) continue;
          const body = await this.app.vault.read(file);
          const rewritten = body
            .split(`[[${prev}/`).join(`[[${next}/`)
            .split(`](${prev}/`).join(`](${next}/`);
          if (rewritten !== body) await this.app.vault.modify(file, rewritten);
        }
        const target = this.app.vault.getAbstractFileByPath(next);
        if (target instanceof TFolder) {
          // Merge into an existing target folder file by file.
          for (const child of this.app.vault.getMarkdownFiles()) {
            if (!child.path.startsWith(`${prev}/`)) continue;
            const dest = next + child.path.slice(prev.length);
            const destDir = dest.slice(0, dest.lastIndexOf('/'));
            if (!this.app.vault.getAbstractFileByPath(destDir)) {
              await this.app.vault.createFolder(destDir).catch(() => {});
            }
            // Merging into a folder that already has a file of this name:
            // renameFile would throw and leave the move half-finished. Keep
            // what is already there — the destination is the wiki the user is
            // moving *to*, so its copy is the one they meant to keep.
            if (this.app.vault.getAbstractFileByPath(dest)) {
              skipped++;
              continue;
            }
            await this.app.fileManager.renameFile(child, dest);
          }
        } else {
          await this.app.fileManager.renameFile(prevFolder, next);
        }
      }
      this.settings.wikiDir = next;
      await this.saveSettings();
      setWikiDir(next);
      // Build the scaffold at the new name before returning. Without this the
      // setting could point at a location that does not exist — most visibly
      // when the old folder had already been deleted, so there was nothing to
      // move: the folder map then read "8 of 8 missing" until the next restart,
      // because the scaffold otherwise only runs on layout-ready.
      await ensureWikiScaffold(this.app.vault);
      await ensureSkillsScaffold(this.app.vault);
      this.refreshIngestBadges();
      if (skipped) {
        void logNotice(
          this.app.vault,
          'warn',
          `Renamed "${prev}" to "${next}"; ${skipped} file(s) already existed there and were left behind.`
        );
        p.warn(
          `Wiki folder is now "${next}". ${skipped} file${skipped === 1 ? '' : 's'} already existed there ` +
            `and were left as they were — the originals are still in "${prev}/".`
        );
      } else {
        p.done(`Wiki folder is now "${next}".`);
      }
    } catch (err) {
      p.fail('Renaming the wiki folder', err, this.app.vault);
    }
  }

  // Model status for the settings page: downloaded?, on-disk size, or the
  // size of a resumable partial.
  modelStatus(): { downloaded: boolean; sizeGB: string; partialGB: string } {
    try {
      const dir = this.pluginAbsDir();
      if (isModelDownloaded(dir)) {
        const bytes = fs.statSync(`${dir}/gemma-4-E4B-it-web.litertlm`).size;
        return { downloaded: true, sizeGB: (bytes / 1e9).toFixed(2), partialGB: '' };
      }
      const partial = partialBytes(dir);
      return { downloaded: false, sizeGB: '', partialGB: partial ? (partial / 1e9).toFixed(2) : '' };
    } catch {
      return { downloaded: false, sizeGB: '', partialGB: '' };
    }
  }

  // Trigger the (resumable) download from the settings page — same gated
  // path used on first use, so re-download and resume both work here.
  async downloadModelFromSettings() {
    this.status('Preparing model download…');
    try {
      const blob = await this.ensureModelBlob((t) => this.status(t));
      this.statusEnd(`Model ready — ${(blob.size / 1e9).toFixed(2)} GB, cached. It never downloads again.`);
    } catch (err) {
      this.statusFail('Downloading the model', err);
    }
  }

  private pluginAbsDir(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error('Desktop only — model download needs the filesystem adapter.');
    }
    return path.join(adapter.getBasePath(), this.manifest.dir ?? '');
  }

  // Resolve the model as a Blob: on disk → load it; first run → show the
  // onboarding gate, then resumable-download on explicit consent. Rejects
  // with a friendly message if the user declines, so callers surface it.
  private async ensureModelBlob(onProgress: (text: string) => void): Promise<Blob> {
    const dir = this.pluginAbsDir();
    const report = (p: { receivedBytes: number; totalBytes: number; resumed: boolean }) => {
      const mb = (p.receivedBytes / 1e6).toFixed(0);
      // `total` already carries its own unit; appending another produced
      // "1240 / 2970 MB MB" in the download notice.
      const total = p.totalBytes ? ` / ${(p.totalBytes / 1e6).toFixed(0)}` : '';
      onProgress(`${p.resumed ? 'Resuming' : 'Downloading'} model… ${mb}${total} MB`);
    };
    // Users who already downloaded under the old Cache-API scheme: move it
    // to disk silently so they never see the onboarding/download prompt.
    if (!isModelDownloaded(dir)) {
      onProgress('Checking for an existing model…');
      await tryMigrateLegacyCache(dir, MODEL_URL);
    }
    if (isModelDownloaded(dir)) {
      onProgress('Loading model…');
      return getModelBlob(dir, MODEL_URL, report);
    }
    // First run (or incomplete): gate behind explicit consent.
    const confirmed = await new Promise<boolean>((resolve) => {
      new OnboardingModal(this.app, partialBytes(dir), resolve).open();
    });
    if (!confirmed) throw new Error('Model download declined.');
    onProgress('Downloading model (first run, ~3GB)…');
    return getModelBlob(dir, MODEL_URL, report);
  }

  // Per-feature input budgets derived from the configured context window.
  // Floors are the old 4096-context values, so a small window behaves exactly
  // as before.
  //
  // The ceilings exist because prefill is not free — filling 60k tokens takes
  // minutes, not seconds. But they used to be flat numbers, which made the
  // Context window setting lie: it promises "longer notes fit whole", and a
  // 27k-token note was truncated identically at 32k and at 64k because chat
  // stopped at 24k either way. Raising the setting did nothing and the user
  // was told the model could not hold it, which was not true — the plugin
  // would not give it to the model. The ceilings now scale with the window, so
  // the setting does what it says while still keeping a single call bounded.
  budget(kind: 'chat' | 'ingest' | 'improve' | 'provenance'): number {
    const ctx = this.effectiveContextTokens ?? this.settings.contextTokens ?? 4096;
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    switch (kind) {
      case 'chat':
        // Grounding for one answer: context minus output + instructions.
        return clamp(ctx - 2000, 2400, Math.max(24000, Math.floor(ctx * 0.75)));
      case 'ingest':
        // One note being summarized into a card.
        return clamp(Math.floor(ctx / 3), 2600, Math.max(16000, Math.floor(ctx * 0.4)));
      case 'improve':
        // Input cap where input PLUS a same-sized rewrite must fit.
        return clamp(Math.floor((ctx - 1000) / 2.2), 1750, 24000);
      case 'provenance':
        // Source note fed to the claims check.
        return clamp(Math.floor(ctx / 5), 2200, Math.max(12000, Math.floor(ctx * 0.25)));
    }
  }

  // Not private: ChatView (a separate class, same session) reuses the
  // single warm Engine instance rather than loading its own.
  ensureEngine(onProgress: (text: string) => void): Promise<Engine> {
    if (!this.enginePromise) {
      this.enginePromise = (async () => {
        await this.ensureWasmLoaded();
        const { Engine } = await import('@litert-lm/core');
        const modelBlob = await this.ensureModelBlob(onProgress);
        onProgress('Moving model onto the GPU…');
        // benchmarkEnabled surfaces real prefill/decode tok/s + time-to-
        // first-token via conversation.getBenchmarkInfo() after generation,
        // instead of a chunk-count proxy.
        // Context window from settings (mainExecutorSettings.maxNumTokens is
        // the documented knob; the official example uses 8192, community
        // reports run Gemma E4B at 64k). Applied only here, at creation — a
        // changed setting needs a plugin reload.
        const engine = await Engine.create({
          model: modelBlob,
          benchmarkEnabled: true,
          mainExecutorSettings: { maxNumTokens: this.settings.contextTokens || 4096 },
        });
        // Read the window back out of the engine instead of trusting the
        // request. LiteRT-LM is free to clamp maxNumTokens to what the model
        // and the GPU can actually hold, and if it does, every budget derived
        // from the setting would overshoot and the call would fail deep inside
        // generation with nothing the user could act on.
        const granted = engine.settings?.mainExecutorSettings?.maxNumTokens;
        if (typeof granted === 'number' && granted > 0) {
          this.effectiveContextTokens = granted;
          const asked = this.settings.contextTokens || 4096;
          log('context window:', { asked, granted });
          if (granted < asked) {
            notify(
              'info',
              `Context window: asked for ${asked.toLocaleString()} tokens, the model granted ` +
                `${granted.toLocaleString()}. Gemma Wiki is using the real number.`
            );
          }
        }
        onProgress('Ready.');
        return engine;
      })().catch((err) => {
        this.enginePromise = null;
        throw err;
      });
    }
    return this.enginePromise;
  }

  private async ensureLocalServer(): Promise<string> {
    if (this.serverBaseUrl) return this.serverBaseUrl;

    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error('Not running on desktop FileSystemAdapter — cannot resolve a local wasm path.');
    }
    const wasmDir = path.join(adapter.getBasePath(), this.manifest.dir ?? '', 'wasm');
    this.wasmDir = wasmDir;
    log('Serving wasm dir:', wasmDir);

    this.server = http.createServer((req, res) => {
      const reqPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
      const filePath = path.join(wasmDir, path.normalize(reqPath));
      if (!filePath.startsWith(wasmDir)) {
        res.writeHead(403).end();
        return;
      }
      const serve = (data: Bytes) => {
        const ext = path.extname(filePath);
        res.writeHead(200, {
          'Content-Type': MIME[ext] ?? 'application/octet-stream',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(data);
      };

      fs.readFile(filePath, (err, data) => {
        if (!err) {
          serve(data);
          return;
        }
        // Not on disk yet. The community store installs only main.js,
        // manifest.json and styles.css, so on a fresh install the runtime is
        // simply not here — fetch the one file the library just asked for,
        // cache it next to the model, and answer with it. Whichever of the
        // four variants that is stays the library's decision.
        const fileName = path.basename(filePath);
        if (!isRuntimeFile(fileName)) {
          res.writeHead(404).end();
          return;
        }
        this.status(`Fetching the local runtime — ${fileName}…`);
        void ensureRuntimeFile(wasmDir, fileName, (p) => {
          const mb = (p.receivedBytes / 1e6).toFixed(0);
          const total = p.totalBytes ? ` / ${(p.totalBytes / 1e6).toFixed(0)}` : '';
          this.status(`Fetching the local runtime… ${mb}${total} MB`);
        })
          .then((finalPath) => {
            this.statusEnd();
            fs.readFile(finalPath, (readErr, fetched) => {
              if (readErr) {
                res.writeHead(500).end();
                return;
              }
              serve(fetched);
            });
          })
          .catch((fetchErr: unknown) => {
            const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
            console.error('[gemma-litert-wiki] runtime fetch failed', fetchErr);
            this.statusEnd(`Runtime download failed — ${message}`, 'error');
            res.writeHead(502).end();
          });
      });
    });

    const port = await new Promise<number>((resolve, reject) => {
      this.server!.on('error', reject);
      this.server!.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') resolve(addr.port);
        else reject(new Error('Failed to determine server port.'));
      });
    });

    this.serverBaseUrl = `http://127.0.0.1:${port}/`;
    return this.serverBaseUrl;
  }
}
