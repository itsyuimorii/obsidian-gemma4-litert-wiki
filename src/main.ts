import { addIcon, App, FileSystemAdapter, FuzzySuggestModal, MarkdownView, Notice, Plugin, setIcon, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import * as http from 'node:http';
import type { Server } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Engine } from '@litert-lm/core';
import { ChatView, VIEW_TYPE_CHAT } from './chat-view';
import { ConfirmModal, IngestPreviewModal, ScaffoldCreatedModal, OnboardingModal, RelinkPreviewModal, SuggestTagsLinksModal, type RelinkProposal } from './ingest-modal';
import { getModelBlob, isModelDownloaded, partialBytes, tryMigrateLegacyCache } from './model-store';
import {
  appendLog,
  buildConceptPage,
  buildSchemaFile,
  buildWikiPage,
  conceptPagePath,
  ensureSkillsScaffold,
  ensureWikiScaffold,
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
  wikiDir,
  wikiPagePath,
  writeWikiPage,
  type IndexEntry,
  type NoteExtraction,
} from './wiki-store';
import { LintReportModal, runLint } from './lint';
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
import { AutoIngestReviewModal, findIngestCandidates, type IngestDraft } from './auto-ingest';
import { GemmaWikiSettingTab, DEFAULT_SETTINGS, type GemmaWikiSettings } from './settings';

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

function log(...args: unknown[]) {
  console.log('[litert-spike]', ...args);
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

// Rough token cost per script: CJK (Han/kana/Hangul/fullwidth) runs ~1.5
// tokens per character, everything else ~4 characters per token. Deliberately
// pessimistic — overshooting the context window truncates the rewrite
// silently, which is the worst failure mode we have.
const CJK_RE = /[　-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/g;
function estimateTokens(text: string): number {
  const cjk = (text.match(CJK_RE) ?? []).length;
  return Math.ceil(cjk * 1.5 + (text.length - cjk) / 4);
}

// One unit of work for Improve. `raw` keeps its own trailing newlines so that
// concatenating every chunk's raw text reproduces the source byte for byte —
// that is what lets us stitch the rewritten pieces back together without
// inventing or eating blank lines. `verbatim` chunks are passed through
// untouched (an over-budget fenced code block: it must be preserved exactly
// anyway, so there is nothing for the copy editor to do).
interface ImproveChunk {
  raw: string;
  verbatim: boolean;
}

// Split markdown into blocks that are safe to send separately: fenced code
// blocks stay whole, headings start a new block, and blank lines end one.
// Every block carries its trailing newlines, so blocks.join('') === src.
function splitMarkdownBlocks(src: string): string[] {
  const lines = src.split('\n');
  const blocks: string[] = [];
  let buf: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    // Each entry already carries its own line break, so this is a plain
    // concatenation — joining on '\n' here would duplicate every newline.
    if (buf.length) blocks.push(buf.join(''));
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const last = i === lines.length - 1;
    const withNl = last ? line : line + '\n';
    if (fence) {
      buf.push(withNl);
      if (new RegExp(`^\\s{0,3}${fence}\\s*$`).test(line)) {
        fence = null;
        flush();
      }
      continue;
    }
    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (open) {
      flush();
      fence = open[1];
      buf.push(withNl);
      continue;
    }
    if (/^\s{0,3}#{1,6}\s/.test(line)) {
      flush();
      buf.push(withNl);
      continue;
    }
    if (line.trim() === '') {
      // Blank lines belong to the block they close, so the separator
      // survives the round trip.
      if (buf.length) {
        buf.push(withNl);
        // Keep consuming a run of blank lines, then end the block.
        while (i + 1 < lines.length && lines[i + 1].trim() === '') {
          i++;
          buf.push(i === lines.length - 1 ? lines[i] : lines[i] + '\n');
        }
        flush();
      } else {
        blocks.push(withNl);
      }
      continue;
    }
    buf.push(withNl);
  }
  flush();
  return blocks;
}

// Break one over-budget block into pieces that fit. Prefers line boundaries,
// then sentence-ending punctuation (CJK notes routinely hold a 1500-character
// paragraph on a single line), and only then a hard character cut.
function splitOversizedBlock(block: string, budget: number): string[] {
  const out: string[] = [];
  const flushable = (piece: string) => {
    if (piece) out.push(piece);
  };
  let rest = block;
  while (estimateTokens(rest) > budget) {
    // Binary-search the longest prefix that fits, then walk back to the
    // nearest natural boundary inside it.
    let lo = 1;
    let hi = rest.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (estimateTokens(rest.slice(0, mid)) <= budget) lo = mid;
      else hi = mid - 1;
    }
    const head = rest.slice(0, lo);
    const nl = head.lastIndexOf('\n');
    const sentence = Math.max(
      head.lastIndexOf('。'),
      head.lastIndexOf('！'),
      head.lastIndexOf('？'),
      head.lastIndexOf('. '),
      head.lastIndexOf('! '),
      head.lastIndexOf('? ')
    );
    let cut = lo;
    if (nl > lo * 0.4) cut = nl + 1;
    else if (sentence > lo * 0.4) cut = sentence + 1;
    flushable(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  flushable(rest);
  return out;
}

// Pack a note into chunks that each fit the per-pass input budget. Chunk
// boundaries land on headings or blank lines wherever possible, so rejoining
// the rewritten pieces is a plain concatenation.
function chunkForImprove(content: string, budget: number): ImproveChunk[] {
  if (estimateTokens(content) <= budget) return [{ raw: content, verbatim: false }];
  const chunks: ImproveChunk[] = [];
  let buf = '';
  const flush = () => {
    if (buf) chunks.push({ raw: buf, verbatim: false });
    buf = '';
  };
  for (const block of splitMarkdownBlocks(content)) {
    if (estimateTokens(block) > budget) {
      flush();
      // A single fenced block over budget has to be preserved verbatim
      // anyway; cutting it would corrupt the code.
      if (/^\s{0,3}(`{3,}|~{3,})/.test(block)) {
        chunks.push({ raw: block, verbatim: true });
      } else {
        for (const piece of splitOversizedBlock(block, budget)) {
          chunks.push({ raw: piece, verbatim: false });
        }
      }
      continue;
    }
    // Prefer to break in front of a heading once the current chunk is
    // half full: a pass that starts at a section head reads as a section,
    // not as a fragment cut mid-argument.
    if (buf && /^\s{0,3}#{1,6}\s/.test(block) && estimateTokens(buf) >= budget * 0.5) flush();
    if (buf && estimateTokens(buf + block) > budget) flush();
    buf += block;
  }
  flush();
  return chunks;
}

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
  private server: Server | null = null;
  private serverBaseUrl: string | null = null;
  private wasmLoadPromise: Promise<void> | null = null;
  private enginePromise: Promise<Engine> | null = null;
  // What the engine actually granted, read back from LiteRT-LM after
  // Engine.create — not what we asked for. null until the model loads.
  private effectiveContextTokens: number | null = null;
  private statusNotice: Notice | null = null;
  private scanStatusEl: HTMLElement | null = null;
  private autoScanIntervalId: number | null = null;
  settings: GemmaWikiSettings = { ...DEFAULT_SETTINGS };

  // One shared status Notice for the whole plugin: later messages update
  // the same toast instead of stacking a new one per operation — repeated
  // ingests were piling up popups.
  private status(text: string) {
    if (this.statusNotice) {
      this.statusNotice.setMessage(text);
    } else {
      this.statusNotice = new Notice(text, 0);
    }
  }

  private statusEnd(text?: string, timeoutMs = 0) {
    const n = this.statusNotice;
    this.statusNotice = null;
    if (!n) return;
    if (text) n.setMessage(text);
    if (timeoutMs > 0) setTimeout(() => n.hide(), timeoutMs);
    else n.hide();
  }

  async onload() {
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

    // Follow the folder if it is renamed or moved from the file explorer.
    // Without this the setting kept pointing at the old path: every folder read
    // as missing, and "Create missing" built a second, empty knowledge base
    // beside the real one — the plugin fighting the user instead of following.
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (!(file instanceof TFolder) || oldPath !== wikiDir()) return;
        void (async () => {
          this.settings.wikiDir = file.path;
          await this.saveSettings();
          setWikiDir(file.path);
          this.refreshIngestBadges();
          new Notice(`ℹ️ Knowledge folder is now "${file.path}" — Gemma Wiki followed the rename.`, 6000);
        })();
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
    this.scanStatusEl.addEventListener('click', () => void this.scanAndReviewIngest());
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
      void (async () => {
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
                  `This vault already contains "${found}/", which has an index and a sources ` +
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

        // First ever run in this vault: one card explaining what just appeared.
        if (!existedBefore && !this.settings.scaffoldNoticeShown) {
          this.settings.scaffoldNoticeShown = true;
          await this.saveSettings();
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
          new Notice(
            `ℹ️ Restored ${gone.length} missing item${gone.length === 1 ? '' : 's'} in ${wikiDir()}/:\n` +
              gone.join('\n') +
              '\n\nPages that were deleted are not restored — run "Reconcile wiki" to drop their index entries.',
            12000
          );
        }
      })();
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
      name: 'Ingest active note into wiki (local Gemma)',
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice('⚠️ Open a note first.');
          return;
        }
        const content = await this.app.vault.read(file);
        // Precheck gate (deterministic, no model call): skip empty,
        // frontmatter-only, and unchanged notes before the 20-40s model
        // call. "Unchanged" compares a content hash against the existing
        // page's source_hash.
        const pagePathForCheck = wikiPagePath(file.basename);
        const existingHash = getIngestedSourceHashes(this.app).get(file.path);
        const skip = precheckNote(content, existingHash);
        if (skip === 'empty' || skip === 'frontmatter-only') {
          new Notice(
            skip === 'empty' ? 'ℹ️ Note is empty — nothing to ingest.' : 'ℹ️ Note is only frontmatter — nothing to ingest.'
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
          new Notice('ℹ️ Note is long — ingesting a truncated version that fits the local model context.', 6000);
        }

        this.status(`Ingesting "${file.basename}"…`);
        try {
          const extraction = await this.extractNoteMetadata(clamped.text, (t) =>
            this.status(`Ingesting "${file.basename}" — ${t}`)
          );
          this.statusEnd();

          const sourceHash = contentHash(content);
          const pagePath = wikiPagePath(file.basename);
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

          new IngestPreviewModal(this.app, pagePath, pageContent, overwriting, () => {
            void (async () => {
              await ensureWikiScaffold(this.app.vault);
              await writeWikiPage(this.app.vault, pagePath, pageContent);
              await upsertIndexEntry(this.app.vault, pagePath, file.basename, extraction.summary);
              const pending = await queuePendingTags(this.app.vault, extraction.tags);
              this.notePendingGrowth(pending.before, pending.after);
              await this.rippleConceptPages(pagePath, [...extraction.tags, ...(extraction.mentions ?? [])]);
              await this.pruneIndex();
              await appendLog(this.app.vault, 'ingest', file.basename);
              this.status(`Wiki page written: ${pagePath}`);
              this.statusEnd(undefined, 2500);
              this.refreshIngestBadges();
            })();
          }).open();
        } catch (err) {
          console.error('[gemma4-litert-wiki] ingest failed', err);
          this.status(`Ingest FAILED — ${err instanceof Error ? err.message : String(err)}`);
          this.statusEnd(undefined, 8000);
        }
      },
    });

    this.addCommand({
      id: 'litert-scan-ingest',
      name: 'Scan notes for wiki (semi-automatic ingest)',
      callback: () => void this.scanAndReviewIngest(),
    });

    this.addCommand({
      id: 'litert-suggest-tags-links',
      name: 'Suggest tags & links for active note (local Gemma)',
      callback: () => void this.suggestTagsAndLinks(),
    });

    this.addCommand({
      id: 'litert-improve-note',
      name: 'Improve formatting of active note (local Gemma)',
      callback: () => void this.improveActiveNote(),
    });

    this.addCommand({
      id: 'litert-relink-wiki',
      name: 'Relink wiki pages (fill or re-sync Related sections)',
      callback: async () => {
        // Backfill for pages ingested before the related-links feature
        // existed — they have no cross-links and show up as orphans in
        // lint and as disconnected dots in the graph view.
        const entries = await this.liveIndexEntries();
        if (entries.length < 2) {
          new Notice('⚠️ Need at least two indexed pages to relink.');
          return;
        }
        const proposals: RelinkProposal[] = [];
        let i = 0;
        for (const entry of entries) {
          i++;
          const file = this.app.vault.getAbstractFileByPath(`${entry.linkPath}.md`);
          if (!(file instanceof TFile)) continue;
          const content = await this.app.vault.read(file);
          // Re-sync, not backfill-only (issue #44): skip a page only when its
          // Related section is HEALTHY — present, non-empty, and every link
          // resolving. Skipping on mere presence meant a section that was
          // empty or had gone stale could never be repaired.
          if (!content.trim() || this.relatedIsHealthy(content)) continue;
          this.status(`Relinking ${i}/${entries.length} — ${entry.title}…`);
          const candidates = entries.filter((e) => e.linkPath !== entry.linkPath);
          const related = await this.pickRelatedPages(entry.summary, candidates);
          if (related.length) {
            proposals.push({ pagePath: `${entry.linkPath}.md`, title: entry.title, related });
          }
        }
        this.statusEnd();
        if (!proposals.length) {
          new Notice('ℹ️ Nothing to relink — every page has an up-to-date Related section, or no matches were found.');
          return;
        }
        new RelinkPreviewModal(this.app, proposals, () => {
          void (async () => {
            for (const prop of proposals) {
              const file = this.app.vault.getAbstractFileByPath(prop.pagePath);
              if (!(file instanceof TFile)) continue;
              const content = await this.app.vault.read(file);
              const section =
                `\n## Related\n\n` +
                prop.related.map((r) => `- [[${r.linkPath}|${r.title}]]`).join('\n') +
                `\n`;
              // Replace an existing Related section rather than appending a
              // second one — now that relink re-syncs stale sections, a plain
              // append would duplicate the heading. Related is the last section
              // generated pages carry, so truncating at it is safe.
              const cut = content.indexOf('\n## Related');
              const head = cut === -1 ? content : content.slice(0, cut);
              await this.app.vault.modify(file, head.trimEnd() + '\n' + section);
              await appendLog(this.app.vault, 'relink', prop.title);
            }
            new Notice(`✅ Related sections updated on ${proposals.length} page${proposals.length === 1 ? '' : 's'}.`, 4000);
          })();
        }).open();
      },
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
      id: 'litert-lint-wiki',
      name: 'Lint wiki (orphans and index health)',
      callback: async () => {
        new LintReportModal(this.app, await runLint(this.app)).open();
      },
    });

    this.addCommand({
      id: 'litert-reconcile-index',
      name: 'Reconcile wiki (drop links to deleted pages)',
      callback: async () => {
        const before = (await readIndexEntries(this.app.vault)).length;
        await this.pruneIndex();
        await this.pruneDeadRelatedLinks();
        const after = (await readIndexEntries(this.app.vault)).length;
        new Notice(
          before === after
            ? 'ℹ️ Wiki is already consistent — no links to deleted pages.'
            : `Removed ${before - after} deleted page${before - after === 1 ? '' : 's'} from the index, ` +
              'and any related links pointing at them.',
          5000
        );
      },
    });

    this.addCommand({
      id: 'litert-concept-page',
      name: 'Build a concept page from a tag or mention (local Gemma)',
      callback: () => void this.createConceptPage(),
    });

    this.addCommand({
      id: 'litert-suggest-vocab',
      name: 'Organize tags (schema.md, local Gemma)',
      callback: () => void this.suggestTagVocabulary(),
    });

    this.addCommand({
      id: 'litert-retag-pages',
      name: 'Retag wiki pages to vocabulary (local Gemma)',
      callback: () => void this.retagPagesToVocabulary(),
    });

    this.addCommand({
      id: 'litert-find-contradictions',
      name: 'Find contradictions in wiki (local Gemma)',
      callback: () => void this.findContradictions(),
    });

    this.addCommand({
      id: 'litert-provenance-check',
      name: 'Provenance spot-check (local Gemma)',
      callback: () => void this.spotCheckProvenance(),
    });

    this.addCommand({
      id: 'litert-create-skills-folder',
      name: 'Create skills folder with examples',
      callback: () => void this.createSkillsFolder(),
    });

    this.addCommand({
      id: 'litert-check-webgpu',
      name: '[Test] Check WebGPU',
      callback: async () => {
        const result = await checkWebGPU();
        log('WebGPU check:', result);
        new Notice(result.ok ? `✅ WebGPU OK — ${result.detail}` : `❌ WebGPU FAILED — ${result.detail}`, 10000);
      },
    });

    this.addCommand({
      id: 'litert-load-wasm',
      name: '[Test] Load WASM runtime (no model download)',
      callback: async () => {
        new Notice('⏳ Loading LiteRT-LM WASM runtime… check the developer console (Cmd+Opt+I) for detail.', 5000);
        try {
          await this.ensureWasmLoaded();
          new Notice('✅ LiteRT-LM WASM runtime loaded successfully.', 8000);
        } catch (err) {
          console.error('[litert-spike] wasm load failed', err);
          new Notice(
            `❌ WASM load FAILED — see console for stack. ${err instanceof Error ? err.message : String(err)}`,
            12000
          );
        }
      },
    });

    this.addCommand({
      id: 'litert-download-model',
      name: 'Download model (one-time, ~3GB)',
      callback: async () => {
        const notice = new Notice('⏳ Preparing model download…', 0);
        try {
          const blob = await this.ensureModelBlob((text) => {
            log(text);
            notice.setMessage(text);
          });
          notice.setMessage(`Model ready. Size: ${(blob.size / 1e9).toFixed(2)} GB`);
          setTimeout(() => notice.hide(), 5000);
        } catch (err) {
          console.error('[gemma4-litert-wiki] model download failed', err);
          notice.setMessage(`Download: ${err instanceof Error ? err.message : String(err)}`);
          setTimeout(() => notice.hide(), 10000);
        }
      },
    });

    this.addCommand({
      id: 'litert-fix-grammar',
      name: '[Test] Fix grammar of selection',
      editorCallback: async (editor) => {
        const selection = editor.getSelection();
        if (!selection.trim()) {
          new Notice('⚠️ Select some text first, then run this command.');
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
          new Notice(
            `ℹ️ Selection is ${selection.length} chars — over the ${MAX_INPUT_CHARS} limit for this spike. ` +
              'Select a shorter passage (a paragraph, not a whole note).',
            8000
          );
          return;
        }
        // Rough token estimate (chars/3, generous for mixed CJK/English) so
        // the output budget scales with input instead of being a fixed
        // guess that either truncates long inputs or wastes tokens on
        // short ones.
        const estimatedInputTokens = Math.ceil(selection.length / 3);
        const maxOutputTokens = Math.min(4096, Math.max(256, Math.ceil(estimatedInputTokens * 1.5)));

        const notice = new Notice('⏳ Loading model (first run downloads ~3GB)…', 0);
        let conversation: import('@litert-lm/core').Conversation | undefined;
        try {
          const engine = await this.ensureEngine((text) => {
            log(text);
            notice.setMessage(text);
          });
          notice.setMessage('Generating…');

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

          notice.setMessage(
            `Done in ${(wallMs / 1000).toFixed(1)}s — decode ${bench.lastDecodeTokensPerSecond.toFixed(1)} tok/s, ` +
              `TTFT ${bench.timeToFirstTokenInSecond.toFixed(2)}s. Replaced selection; see console for full numbers.`
          );
          editor.replaceSelection(result.trim());
          setTimeout(() => notice.hide(), 10000);
        } catch (err) {
          console.error('[litert-spike] grammar fix failed', err);
          notice.setMessage(`FAILED — see console. ${err instanceof Error ? err.message : String(err)}`);
          setTimeout(() => notice.hide(), 12000);
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
          new Notice('⚠️ Select a short paragraph first, then run this command.');
          return;
        }
        if (selection.length > 3000) {
          new Notice('⚠️ Keep it under 3000 chars for this test — pick a single paragraph.', 6000);
          return;
        }

        const RUNS = 5;
        const notice = new Notice(`ℹ️ JSON reliability test: loading model…`, 0);
        try {
          const engine = await this.ensureEngine((text) => {
            log(text);
            notice.setMessage(text);
          });

          const { SamplerType } = await import('@litert-lm/core');
          let successCount = 0;
          const outcomes: string[] = [];

          for (let i = 1; i <= RUNS; i++) {
            notice.setMessage(`JSON reliability test: run ${i}/${RUNS}…`);
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
                  maxOutputTokens: 512,
                },
              });

              let raw = '';
              const stream = conversation.sendMessageStreaming(selection);
              const reader = stream.getReader();
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                const content = value?.content;
                if (typeof content === 'string') raw += content;
                else if (Array.isArray(content)) {
                  for (const part of content) {
                    if (part.type === 'text' && part.text) raw += part.text;
                  }
                }
              }

              // Small models often wrap JSON in ```json ... ``` despite
              // being told not to — strip that before parsing rather than
              // counting it as a hard failure.
              const cleaned = raw
                .trim()
                .replace(/^```(?:json)?\s*/i, '')
                .replace(/```\s*$/i, '')
                .trim();

              try {
                const parsed = JSON.parse(cleaned);
                const valid =
                  typeof parsed === 'object' &&
                  parsed !== null &&
                  typeof parsed.summary === 'string' &&
                  Array.isArray(parsed.tags) &&
                  parsed.tags.length === 3 &&
                  parsed.tags.every((t: unknown) => typeof t === 'string');
                if (valid) {
                  successCount++;
                  log(`Run ${i}: OK`, parsed);
                  outcomes.push(`Run ${i}: OK — ${JSON.stringify(parsed)}`);
                } else {
                  log(`Run ${i}: parsed but wrong shape`, parsed, 'raw:', raw);
                  outcomes.push(`Run ${i}: WRONG SHAPE — ${cleaned}`);
                }
              } catch (parseErr) {
                log(`Run ${i}: JSON.parse failed`, parseErr, 'raw:', raw);
                outcomes.push(`Run ${i}: PARSE FAILED — raw: ${raw}`);
              }
            } finally {
              await conversation?.delete().catch(() => {});
            }
          }

          log('JSON reliability test summary:', `${successCount}/${RUNS} valid`, outcomes);
          notice.setMessage(
            `JSON reliability: ${successCount}/${RUNS} valid. Full detail in console (search "JSON reliability").`
          );
          setTimeout(() => notice.hide(), 12000);
        } catch (err) {
          console.error('[litert-spike] JSON reliability test failed', err);
          notice.setMessage(`FAILED — see console. ${err instanceof Error ? err.message : String(err)}`);
          setTimeout(() => notice.hide(), 12000);
        }
      },
    });

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
        void (async () => {
          await this.pruneIndex();
          await this.pruneDeadRelatedLinks();
        })();
      })
    );
  }

  // Small file-explorer badge on raw notes that already have a wiki page.
  // Purely decorative DOM on the explorer item — the note file itself is
  // never modified, per the raw-sources-are-read-only rule.
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
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHAT);
    this.server?.close();
    this.server = null;
    this.serverBaseUrl = null;
  }

  private async activateChatView() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
    if (existing) {
      workspace.revealLeaf(existing);
      return;
    }
    const leaf: WorkspaceLeaf | null = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
    workspace.revealLeaf(leaf);
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
      new Notice('⚠️ Open a note first.');
      return;
    }
    const content = await this.app.vault.read(file);
    if (precheckNote(content, undefined) !== null) {
      new Notice('ℹ️ Note is empty — nothing to suggest.');
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
      const rawTags = this.app.metadataCache.getFileCache(file)?.frontmatter?.tags;
      if (Array.isArray(rawTags)) rawTags.forEach((t) => existing.add(slugify(String(t))));
      else if (typeof rawTags === 'string') rawTags.split(/[,\s]+/).forEach((t) => t && existing.add(slugify(t)));
      const newTags = extraction.tags.map((t) => slugify(t)).filter((t) => t && !existing.has(t));

      const selfLink = wikiPagePath(file.basename).replace(/\.md$/, '');
      const candidates = (await this.liveIndexEntries()).filter((e) => e.linkPath !== selfLink);
      const related = candidates.length ? await this.pickRelatedPages(extraction.summary, candidates) : [];
      this.statusEnd();

      new SuggestTagsLinksModal(this.app, file.path, newTags, related, () => {
        void (async () => {
          if (newTags.length) {
            await this.app.fileManager.processFrontMatter(file, (fm) => {
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
          new Notice(`ℹ️ Updated "${file.basename}" — tags & links added.`, 3000);
          this.refreshIngestBadges();
        })();
      }).open();
    } catch (err) {
      console.error('[gemma4-litert-wiki] suggest tags/links failed', err);
      this.status(`Suggest FAILED — ${err instanceof Error ? err.message : String(err)}`);
      this.statusEnd(undefined, 8000);
    }
  }

  // Schema layer (issue #3): generate the controlled tag vocabulary instead
  // of making the user hand-write it. Tally the tags already on wiki pages,
  // ask the model to merge near-synonyms into a clean canonical list, and
  // write it into schema.md (config-as-note) behind the preview gate. The
  // Naming and Concept-threshold sections are preserved if the file exists.
  // Open schema.md so the user can read/edit the config-as-a-note directly.
  // Seeds a default (empty-vocab) schema first if the file does not exist yet,
  // so the button always lands on a real, self-documenting file.

  // Seed <wiki>/skills/ with a README and two example skills, then open the
  // README. Shared by the command and the settings button.
  // A folder counts as a knowledge base if it holds both an index and a
  // sources/ subfolder — specific enough not to match someone's own notes.
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
          !!this.app.vault.getAbstractFileByPath(`${f.path}/sources`)
      )
      .map((f) => f.path);
    return hits.length === 1 ? hits[0] : null;
  }

  // The first-run card, on demand. Shown automatically once; this is how you
  // get it back. Repeating it on every launch would be nagging — after the
  // first time there is nothing new in it, and Obsidian restores the panel with
  // the rest of the workspace anyway.
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
      new Notice(`✅ Everything is already in place under ${wikiDir()}/.`, 4000);
      return;
    }
    new Notice(`✅ Created ${missing.length} missing item${missing.length === 1 ? '' : 's'}:\n${missing.join('\n')}`, 8000);
  }

  async createSkillsFolder() {
    await ensureSkillsScaffold(this.app.vault);
    const path = `${wikiDir()}/skills`;
    new Notice(`✅ Skills folder ready at ${path}. Open its README, then add a .md file per skill.`, 6000);
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
      const raw = this.app.metadataCache.getFileCache(f)?.frontmatter?.tags;
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

  async suggestTagVocabulary() {
    const counts = this.wikiTagCounts();
    if (!counts.length) {
      new Notice(
        '⚠️ No tags yet — the vocabulary is built from the tags your ingested notes already produced. ' +
          'Ingest a few notes first, then run "Organize tags".',
        7000
      );
      return;
    }

    this.status('Organizing the tag vocabulary…');
    let vocab: string[];
    try {
      vocab = await this.cleanTagVocabulary(counts);
      this.statusEnd('Vocabulary ready — review it below.', 2500);
    } catch (err) {
      console.error('[gemma4-litert-wiki] vocab suggest failed', err);
      this.statusEnd(`Suggest FAILED — ${err instanceof Error ? err.message : String(err)}`, 8000);
      return;
    }
    if (!vocab.length) {
      new Notice('ℹ️ The model returned an empty vocabulary — nothing to write.', 5000);
      return;
    }

    // Preserve any Naming / Concept-threshold the user has set, and enforce
    // the Rejected list: a banned tag never re-enters the vocabulary, no
    // matter how many pages still carry it — the ban is the user's veto and
    // outranks usage (mechanical filter, not a prompt hope).
    const existing = await readSchema(this.app.vault);
    const rejectedSet = new Set(existing.rejected.map((t) => slugify(t)));
    vocab = vocab.filter((t) => !rejectedSet.has(t));
    if (!vocab.length) {
      new Notice('ℹ️ Every proposed tag is on the Rejected list — nothing to write.', 6000);
      return;
    }
    const content = buildSchemaFile(vocab, existing.naming, existing.conceptThreshold, [], existing.rejected);
    const path = schemaPath();
    const overwriting = !!this.app.vault.getAbstractFileByPath(path);
    new IngestPreviewModal(this.app, path, content, overwriting, () => {
      void (async () => {
        await ensureWikiScaffold(this.app.vault);
        await writeWikiPage(this.app.vault, path, content);
        await appendLog(this.app.vault, 'schema', `tag vocabulary (${vocab.length} tags)`);
        this.status(`Schema written: ${path}`);
        this.statusEnd(undefined, 2500);
      })();
    }).open();
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
      new Notice(
        `⚠️ ${after} tags are waiting in schema.md's Pending list. Run "Organize tags" to fold them ` +
          'into the vocabulary — until then, similar notes keep coining near-duplicate tags.',
        9000
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
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
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
      await this.app.fileManager.processFrontMatter(f, (cfm) => {
        cfm.stale = true;
      });
      await appendLog(this.app.vault, 'ripple', `${newTitle} -> ${f.basename} (concept)`);
    }
  }

  // A page's Related section is "healthy" when it exists, lists at least one
  // link, and every link still resolves. Anything else — no section, an empty
  // one, or one holding a dead link — is a candidate for re-syncing (#44).
  private relatedIsHealthy(content: string): boolean {
    const cut = content.indexOf('\n## Related');
    if (cut === -1) return false;
    const RELATED_LINK = /^- \[\[([^\]|]+)\|/;
    const links = content
      .slice(cut)
      .split('\n')
      .map((l) => l.match(RELATED_LINK))
      .filter((m): m is RegExpMatchArray => !!m);
    if (!links.length) return false;
    return links.every(
      (m) => this.app.vault.getAbstractFileByPath(`${m[1]}.md`) instanceof TFile
    );
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
      if (touchedConceptMembers && this.app.metadataCache.getFileCache(f)?.frontmatter?.kind === 'concept') {
        await this.app.fileManager.processFrontMatter(f, (cfm) => {
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
        5000
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
      console.error('[gemma4-litert-wiki] contradiction scan failed', err);
      this.statusEnd(`Contradiction scan FAILED — ${err instanceof Error ? err.message : String(err)}`, 8000);
      return;
    }
    // The pair cap is also silent otherwise: "0 flagged" reads as "your wiki is
    // consistent" when pairs were never looked at.
    const notChecked = uncappedPairs - pairs.length;
    if (unjudged || notChecked) {
      new Notice(
        '⚠️ ' + [
          unjudged ? `${unjudged} of ${pairs.length} pairs could not be judged (see console)` : '',
          notChecked ? `${notChecked} more pair${notChecked === 1 ? '' : 's'} not checked this run (cap ${MAX_PAIRS})` : '',
        ]
          .filter(Boolean)
          .join('; ') + '.',
        8000
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
      this.statusEnd('No ingested pages with key points to check.', 5000);
      return;
    }
    const flags: ProvenanceFlag[] = [];
    try {
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        this.status(`Checking ${i + 1}/${samples.length} — ${s.title}…`);
        const srcFile = this.app.vault.getAbstractFileByPath(s.sourcePath);
        if (!(srcFile instanceof TFile)) continue; // source note gone
        const srcText = clampToTokens(cleanClippedMarkdown(await this.app.vault.read(srcFile)), this.budget('provenance')).text;
        const unsupported = await this.checkProvenance(srcText, s.keyPoints);
        if (unsupported.length) {
          flags.push({ linkPath: s.linkPath, title: s.title, sourcePath: s.sourcePath, unsupported });
        }
      }
      this.statusEnd();
    } catch (err) {
      console.error('[gemma4-litert-wiki] provenance check failed', err);
      this.statusEnd(`Provenance check FAILED — ${err instanceof Error ? err.message : String(err)}`, 8000);
      return;
    }
    new ProvenanceReportModal(this.app, flags, samples.length).open();
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
      let raw = '';
      const c = message.content;
      if (typeof c === 'string') raw = c;
      else if (Array.isArray(c)) for (const part of c) if (part.type === 'text' && part.text) raw += part.text;
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return [];
      const parsed = JSON.parse(match[0]) as { vocabulary?: unknown };
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
      new Notice('⚠️ No vocabulary in schema.md yet — run "Organize tags" first.', 6000);
      return;
    }
    const STRUCTURAL = new Set(['concept', 'answer', 'chat']);
    const vocabSet = new Set(vocab);
    // Collect each page's tags and the set of off-vocabulary ones.
    const pages: { file: TFile; tags: string[] }[] = [];
    const offVocab = new Set<string>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!isWikiPage(f)) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
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
      new Notice('ℹ️ All page tags already match the vocabulary — nothing to retag.', 5000);
      return;
    }

    this.status(`Mapping ${offVocab.size} old tag${offVocab.size === 1 ? '' : 's'} to the vocabulary…`);
    let mapping: Map<string, string>;
    try {
      mapping = await this.mapTagsToVocabulary(vocab, [...offVocab]);
      this.statusEnd();
    } catch (err) {
      console.error('[gemma4-litert-wiki] retag mapping failed', err);
      this.statusEnd(`Retag FAILED — ${err instanceof Error ? err.message : String(err)}`, 8000);
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
      new Notice('ℹ️ The model kept every old tag as-is — nothing to retag.', 6000);
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
        void (async () => {
          for (const c of changes) {
            await this.app.fileManager.processFrontMatter(c.file, (fm) => {
              fm.tags = c.to;
            });
          }
          await appendLog(this.app.vault, 'retag', `${changes.length} pages to vocabulary`);
          new Notice(`✅ Retagged ${changes.length} page${changes.length === 1 ? '' : 's'}.`, 4000);
        })();
      },
    }).open();
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
      let raw = '';
      const c = message.content;
      if (typeof c === 'string') raw = c;
      else if (Array.isArray(c)) for (const part of c) if (part.type === 'text' && part.text) raw += part.text;
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('Model returned no JSON.');
      const parsed = JSON.parse(match[0]) as { mapping?: Record<string, unknown> };
      const out = new Map<string, string>();
      const vocabSet = new Set(vocab);
      for (const t of oldTags) {
        const v = parsed.mapping?.[t];
        const slug = typeof v === 'string' ? slugify(v) : '';
        // Only accept a mapping into the vocabulary; anything else keeps the tag.
        if (slug && vocabSet.has(slug)) out.set(t, slug);
      }
      console.log('[gemma4-litert-wiki] retag mapping', Object.fromEntries(out));
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
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
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
      new Notice(
        `ℹ️ No tag or mention is shared by ${minMembers}+ pages yet (concept threshold = ${minMembers}). ` +
          'Ingest more notes, or lower the threshold in schema.md.',
        7000
      );
      return;
    }

    new ConceptTagModal(this.app, candidates, (cluster) => {
      void (async () => {
        this.status(`Writing a concept overview for "${cluster.tag}"…`);
        let overview: string;
        try {
          overview = await this.summarizeConcept(cluster.tag, cluster.members);
          this.statusEnd();
        } catch (err) {
          console.error('[gemma4-litert-wiki] concept overview failed', err);
          this.statusEnd(`Concept page FAILED — ${err instanceof Error ? err.message : String(err)}`, 8000);
          return;
        }
        const members = cluster.members.map((e) => ({ title: e.title, linkPath: e.linkPath }));
        const pagePath = conceptPagePath(cluster.tag);
        const pageContent = buildConceptPage(cluster.tag, overview, members);
        const overwriting = !!this.app.vault.getAbstractFileByPath(pagePath);
        new IngestPreviewModal(this.app, pagePath, pageContent, overwriting, () => {
          void (async () => {
            await ensureWikiScaffold(this.app.vault);
            await writeWikiPage(this.app.vault, pagePath, pageContent);
            await upsertIndexEntry(this.app.vault, pagePath, `${cluster.tag} (concept)`, overview.slice(0, 140));
            await appendLog(this.app.vault, 'concept', cluster.tag);
            this.status(`Concept page written: ${pagePath}`);
            this.statusEnd(undefined, 2500);
            this.refreshIngestBadges();
          })();
        }).open();
      })();
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
      let raw = '';
      const c = message.content;
      if (typeof c === 'string') raw = c;
      else if (Array.isArray(c)) for (const part of c) if (part.type === 'text' && part.text) raw += part.text;
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
      let raw = '';
      const c = message.content;
      if (typeof c === 'string') raw = c;
      else if (Array.isArray(c)) for (const part of c) if (part.type === 'text' && part.text) raw += part.text;
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]) as { contradict?: unknown; reason?: unknown };
      // Accept every reasonable spelling of yes. The field is named
      // "contradict", which reads boolean, so a model very naturally answers
      // `true` — and matching only the exact string "yes" turned that into a
      // silent NO. Same brittleness that made the related picker drop every
      // pick when the model tidied a title.
      const v = parsed.contradict;
      const contradict =
        v === true || (typeof v === 'string' && ['yes', 'true', 'y'].includes(v.trim().toLowerCase()));
      const verdict = { contradict, reason: typeof parsed.reason === 'string' ? parsed.reason : '' };
      console.log('[gemma4-litert-wiki] contradiction verdict', {
        a: titleA,
        b: titleB,
        raw: v,
        contradict,
        reason: verdict.reason,
      });
      return verdict;
    } catch (err) {
      console.error('[gemma4-litert-wiki] judgeContradiction parse/gen failed', err);
      return null; // a bad judgment just drops the pair; never blocks the sweep
    } finally {
      await conversation?.delete().catch(() => {});
    }
  }

  // One strict-JSON judgment per page: which claims does the source not
  // support? Validated against the actual key-point list (the model can only
  // flag points that were really there); a bad parse drops the page.
  async checkProvenance(sourceText: string, keyPoints: string[]): Promise<string[]> {
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
      let raw = '';
      const c = message.content;
      if (typeof c === 'string') raw = c;
      else if (Array.isArray(c)) for (const part of c) if (part.type === 'text' && part.text) raw += part.text;
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return [];
      const parsed = JSON.parse(match[0]) as { unsupported?: unknown };
      if (!Array.isArray(parsed.unsupported)) return [];
      const valid = new Set(keyPoints);
      return parsed.unsupported.filter((u): u is string => typeof u === 'string' && valid.has(u));
    } catch (err) {
      console.error('[gemma4-litert-wiki] checkProvenance parse/gen failed', err);
      return [];
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
      this.scanStatusEl?.hide();
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
      const result = await findIngestCandidates(this.app, {
        quietHours: this.settings.scanQuietHours,
        maxPerRun: this.settings.scanMaxPerRun,
        excludePrefixes: this.settings.scanExclude.split(',').map((s) => s.trim()).filter(Boolean),
      });
      const total = result.eligible.length + result.cappedOut;
      if (total > 0) {
        this.scanStatusEl.setText(`📥 ${total} to review`);
        this.scanStatusEl.setAttr('aria-label', 'New or changed notes — click to scan and review');
        this.scanStatusEl.show();
      } else {
        this.scanStatusEl.hide();
      }
    } catch (err) {
      console.error('[gemma4-litert-wiki] scan badge refresh failed', err);
      this.scanStatusEl.hide();
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
  onScanStateChange: (() => void) | null = null;

  private setScanRunning(running: boolean): void {
    this.scanRunning = running;
    this.onScanStateChange?.();
  }

  isScanning(): boolean {
    return this.scanRunning;
  }

  cancelScan(): void {
    if (this.scanRunning) this.scanCancelled = true;
  }

  async scanAndReviewIngest() {
    if (this.scanRunning) {
      new Notice('⚠️ A scan is already running — use "Stop scan" in settings to cancel it.', 5000);
      return;
    }
    // Allow-list scope (opt-in): scan only looks at the folders the user named.
    // Blank means nothing to scan — guide them to set it (or ingest one note
    // by hand) rather than silently sweeping the whole vault.
    const includePrefixes = this.settings.scanInclude.split(',').map((s) => s.trim()).filter(Boolean);
    if (!includePrefixes.length) {
      new Notice(
        '⚠️ No scan folders set. In Settings → "Scan these folders", name the folder(s) to scan ' +
          '(e.g. your inbox). To file one specific note instead, use "Ingest active note into wiki".',
        9000
      );
      return;
    }
    this.setScanRunning(true);
    this.scanCancelled = false;
    try {
      await this.runScanAndReview(includePrefixes);
    } finally {
      this.setScanRunning(false);
      this.scanCancelled = false;
    }
  }

  private async runScanAndReview(includePrefixes: string[]) {
    this.status('Scanning for new or changed notes…');
    const result = await findIngestCandidates(this.app, {
      // Manual scan ignores the quiet period (issue #42): clicking "Scan now"
      // is an explicit ask — skipping the notes you just wrote is the opposite
      // of the intent. The quiet period only guards background auto-scan,
      // where a timer could grab a half-written draft mid-edit.
      quietHours: 0,
      maxPerRun: this.settings.scanMaxPerRun,
      includePrefixes,
      excludePrefixes: this.settings.scanExclude.split(',').map((s) => s.trim()).filter(Boolean),
    });
    let eligible = result.eligible;
    let cappedOut = result.cappedOut;
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
        eligible = result.unchanged
          .slice(0, this.settings.scanMaxPerRun)
          .map((file) => ({ file, reason: 'refresh' as const }));
        cappedOut = Math.max(0, result.unchanged.length - this.settings.scanMaxPerRun);
      } else {
        new Notice(
          result.scanned
            ? `ℹ️ Scanned ${result.scanned} notes — nothing new or changed to ingest.${quietNote}`
            : 'ℹ️ No notes in scope to scan.',
          6000
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
    new Notice(
      `⏳ Scanning ${n} note${n === 1 ? '' : 's'} — about one model call each. You can close Settings ` +
        'and keep working; the review dialog opens here when it is done. ' +
        '(To stop early, reopen Settings and click "Stop scan".)',
      9000
    );
    // Pages drafted earlier in THIS batch are valid link targets for later
    // ones: they are about to be written together. Without this, scanning a
    // set of related notes into a fresh wiki gives every page an empty
    // Related section, because the index still holds only pre-batch pages.
    // (A draft the user then unticks can leave a link to a page that was
    // never written — the post-write prune below clears exactly that.)
    const batchEntries: IndexEntry[] = [];
    for (let i = 0; i < n; i++) {
      if (this.scanCancelled) {
        cancelled = true;
        break;
      }
      const { file, reason } = eligible[i];
      try {
        const content = await this.app.vault.read(file);
        const clamped = clampToTokens(cleanClippedMarkdown(content), this.budget('ingest'));
        const extraction = await this.extractNoteMetadata(clamped.text, (t) =>
          this.status(`Drafting ${i + 1}/${n} — ${file.basename} · ${t}`)
        );
        const sourceHash = contentHash(content);
        const pagePath = wikiPagePath(file.basename);
        const selfLink = pagePath.replace(/\.md$/, '');
        const candidates = [...(await this.liveIndexEntries()), ...batchEntries].filter(
          (e) => e.linkPath !== selfLink
        );
        let related: { title: string; linkPath: string }[] = [];
        if (candidates.length) {
          this.status(`Drafting ${i + 1}/${n} — ${file.basename} · finding related pages…`);
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
        console.error('[gemma4-litert-wiki] draft failed', file.path, err);
        failed++;
      }
    }
    this.statusEnd();

    if (!drafts.length) {
      new Notice(
        cancelled ? 'ℹ️ Scan stopped — no drafts were finished.' : '❌ Every draft failed to generate — nothing to review.',
        6000
      );
      return;
    }

    const capNote = cancelled
      ? ' (scan stopped — the rest will be offered next scan)'
      : cappedOut
        ? ` (${cappedOut} more left for the next scan)`
        : '';
    new Notice(`✅ ${drafts.length} draft${drafts.length === 1 ? '' : 's'} ready to review${capNote}.`, 4000);

    new AutoIngestReviewModal(this.app, drafts, failed, async (approved) => {
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
      new Notice(`✅ Wrote ${approved.length} page${approved.length === 1 ? '' : 's'} to the wiki.`, 4000);
    }).open();
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
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice('⚠️ Open a note first.');
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
      new Notice('ℹ️ Note is empty — nothing to improve.');
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
      new Notice('ℹ️ Note is only frontmatter — nothing to improve.');
      return;
    }

    // Budget per pass, derived from the configured context window: the input
    // plus a same-sized rewrite plus the system prompt all have to fit.
    const MAX_INPUT_TOKENS = this.budget('improve');
    const chunks = chunkForImprove(body, MAX_INPUT_TOKENS);
    const passes = chunks.filter((c) => !c.verbatim && c.raw.trim()).length;
    if (passes === 0) {
      new Notice('ℹ️ Nothing to improve — this note is one oversized code block, which is preserved as-is.', 8000);
      return;
    }
    // Each pass is roughly half a minute of GPU time. Past a couple of them
    // the user should get to decide before it starts, not discover it after.
    if (passes >= 3) {
      const proceed = await new Promise<boolean>((resolve) => {
        new ConfirmModal(this.app, {
          title: 'Improve a long note',
          body:
            `${usingSelection ? 'The selection' : `"${file.basename}"`} is ~${estimateTokens(body)} tokens — ` +
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
        let conversation: import('@litert-lm/core').Conversation | undefined;
        try {
          conversation = await engine.createConversation({
            preface: { messages: [{ role: 'system', content: systemPrompt }] },
            sessionConfig: {
              samplerParams: { type: SamplerType.GREEDY },
              // Output is a same-sized rewrite of the input; cap it just above
              // the input estimate instead of a flat 2048 so short passes can't
              // run away and long CJK passes aren't silently truncated.
              maxOutputTokens: Math.min(2048, estimateTokens(text) + 300),
            },
          });
          const message = await conversation.sendMessage(text);
          let raw = '';
          const c = message.content;
          if (typeof c === 'string') raw = c;
          else if (Array.isArray(c)) {
            for (const part of c) {
              if (part.type === 'text' && part.text) raw += part.text;
            }
          }
          const improved = raw
            .trim()
            .replace(/^```(?:markdown|md)?\s*/i, '')
            .replace(/```\s*$/i, '')
            .trim();
          if (!improved) throw new Error('Model returned an empty result.');
          pieces.push(leading + improved + trailing);
        } catch (err) {
          // One bad pass must not cost the user the other twenty: keep the
          // author's text for that section and say so at the end.
          console.error(`[gemma4-litert-wiki] improve pass ${pass}/${passes} failed`, err);
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
        new Notice(
          `⚠️ ${failed} of ${passes} passes failed; those sections are unchanged in the preview. ` +
            'See the console for why.',
          8000
        );
      }
      new IngestPreviewModal(this.app, source, improved, true, () => {
        void (async () => {
          if (usingSelection && editor && selFrom && selTo) {
            editor.replaceRange(improved, selFrom, selTo);
          } else {
            await this.app.vault.modify(file, improved);
          }
          await appendLog(this.app.vault, 'improve', file.basename);
          new Notice(`✅ Note updated: ${file.basename}`, 3000);
        })();
      }).open();
    } catch (err) {
      console.error('[gemma4-litert-wiki] improve failed', err);
      this.status(`Improve FAILED — ${err instanceof Error ? err.message : String(err)}`);
      this.statusEnd(undefined, 8000);
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
        let raw = '';
        const content = message.content;
        if (typeof content === 'string') raw = content;
        else if (Array.isArray(content)) {
          for (const part of content) {
            if (part.type === 'text' && part.text) raw += part.text;
          }
        }
        const cleaned = raw
          .trim()
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/```\s*$/i, '')
          .trim();
        const parsed = JSON.parse(cleaned) as { related?: unknown };
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
            '[gemma4-litert-wiki] related-pages: model returned titles that match no catalog entry',
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
      console.error('[gemma4-litert-wiki] related-pages pick FAILED — page will have no Related section', err);
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

    for (let attempt = 1; attempt <= 2; attempt++) {
      onProgress(attempt === 1 ? 'Extracting…' : 'Extracting (retry)…');
      let conversation: import('@litert-lm/core').Conversation | undefined;
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
            maxOutputTokens: 768,
          },
        });

        const message = await conversation.sendMessage(noteContent);
        let raw = '';
        const content = message.content;
        if (typeof content === 'string') raw = content;
        else if (Array.isArray(content)) {
          for (const part of content) {
            if (part.type === 'text' && part.text) raw += part.text;
          }
        }
        const cleaned = raw
          .trim()
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/```\s*$/i, '')
          .trim();
        const parsed = JSON.parse(cleaned) as NoteExtraction;
        const valid =
          typeof parsed?.summary === 'string' &&
          Array.isArray(parsed.tags) &&
          parsed.tags.length >= 1 &&
          parsed.tags.every((t) => typeof t === 'string') &&
          Array.isArray(parsed.key_points) &&
          parsed.key_points.length >= 1 &&
          parsed.key_points.every((p) => typeof p === 'string');
        if (valid) {
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
      } finally {
        await conversation?.delete().catch(() => {});
      }
    }
    throw new Error('unreachable');
  }

  async loadSettings() {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // Rename the wiki folder and rewrite the internal links that name it.
  // source: frontmatter points at raw notes (untouched); only the layer's
  // own paths (index links, Related links, path-prefixed wikilinks) move.
  async renameWikiDir(prev: string, next: string) {
    const notice = new Notice(`⏳ Renaming ${prev} → ${next}…`, 0);
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
      notice.setMessage(
        skipped
          ? `⚠️ Wiki folder is now "${next}". ${skipped} file${skipped === 1 ? '' : 's'} already existed there ` +
            `and were left as they were — the originals are still in "${prev}/".`
          : `✅ Wiki folder is now "${next}".`
      );
      setTimeout(() => notice.hide(), skipped ? 10000 : 4000);
    } catch (err) {
      console.error('[gemma4-litert-wiki] rename wiki dir failed', err);
      notice.setMessage(`Rename failed — ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(() => notice.hide(), 8000);
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
    const notice = new Notice('⏳ Preparing model download…', 0);
    try {
      const blob = await this.ensureModelBlob((t) => notice.setMessage(t));
      notice.setMessage(`Model ready. Size: ${(blob.size / 1e9).toFixed(2)} GB`);
      setTimeout(() => notice.hide(), 5000);
    } catch (err) {
      console.error('[gemma4-litert-wiki] settings download failed', err);
      notice.setMessage(`Download: ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(() => notice.hide(), 10000);
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
            new Notice(
              `\u2139\uFE0F Context window: asked for ${asked.toLocaleString()} tokens, the model ` +
                `granted ${granted.toLocaleString()}. Gemma Wiki is using the real number.`,
              8000
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
    log('Serving wasm dir:', wasmDir);

    this.server = http.createServer((req, res) => {
      const reqPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
      const filePath = path.join(wasmDir, path.normalize(reqPath));
      if (!filePath.startsWith(wasmDir)) {
        res.writeHead(403).end();
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404).end();
          return;
        }
        const ext = path.extname(filePath);
        res.writeHead(200, {
          'Content-Type': MIME[ext] ?? 'application/octet-stream',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(data);
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
