import { addIcon, App, FileSystemAdapter, FuzzySuggestModal, MarkdownView, Notice, Plugin, setIcon, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import * as http from 'node:http';
import type { Server } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Engine } from '@litert-lm/core';
import { ChatView, VIEW_TYPE_CHAT } from './chat-view';
import { ConfirmModal, IngestPreviewModal, OnboardingModal, RelinkPreviewModal, SuggestTagsLinksModal, type RelinkProposal } from './ingest-modal';
import { getModelBlob, isModelDownloaded, partialBytes, tryMigrateLegacyCache } from './model-store';
import {
  appendLog,
  buildConceptPage,
  buildSchemaFile,
  buildWikiPage,
  conceptPagePath,
  ensureSkillsScaffold,
  ensureWikiScaffold,
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
  private statusNotice: Notice | null = null;
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

    // Brand mark (concept: a note card with a folded corner and a spark —
    // "a note, with local AI inside"), registered as a reusable icon.
    // addIcon expects inner SVG content sized for a 0 0 100 100 viewBox.
    addIcon(
      'gemma-wiki-logo',
      '<path d="M58.3 12.5 H27.1 a10.4 10.4 0 0 0 -10.4 10.4 v54.2 a10.4 10.4 0 0 0 10.4 10.4 h45.8 ' +
        'a10.4 10.4 0 0 0 10.4 -10.4 V37.5 Z" stroke="currentColor" stroke-width="8.3" ' +
        'stroke-linejoin="round" fill="none"/>' +
        '<path d="M58.3 12.5 v25 h25" stroke="currentColor" stroke-width="8.3" stroke-linejoin="round" fill="none"/>' +
        '<path d="M41.7 45.8 l4.8 10.8 10.8 4.8 -10.8 4.8 -4.8 10.8 -4.8 -10.8 -10.8 -4.8 10.8 -4.8 Z" fill="currentColor"/>'
    );

    this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this));

    this.addRibbonIcon('gemma-wiki-logo', 'Chat with note (Gemma, local)', () => {
      void this.activateChatView();
    });

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
          new Notice('Open a note first.');
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
        const clamped = clampToTokens(cleaned, 2600);
        if (clamped.truncated) {
          new Notice('Note is long — ingesting a truncated version that fits the local model context.', 6000);
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
      name: 'Relink wiki pages (fill missing Related sections)',
      callback: async () => {
        // Backfill for pages ingested before the related-links feature
        // existed — they have no cross-links and show up as orphans in
        // lint and as disconnected dots in the graph view.
        const entries = await this.liveIndexEntries();
        if (entries.length < 2) {
          new Notice('Need at least two indexed pages to relink.');
          return;
        }
        const proposals: RelinkProposal[] = [];
        let i = 0;
        for (const entry of entries) {
          i++;
          const file = this.app.vault.getAbstractFileByPath(`${entry.linkPath}.md`);
          if (!(file instanceof TFile)) continue;
          const content = await this.app.vault.read(file);
          if (!content.trim() || content.includes('\n## Related')) continue;
          this.status(`Relinking ${i}/${entries.length} — ${entry.title}…`);
          const candidates = entries.filter((e) => e.linkPath !== entry.linkPath);
          const related = await this.pickRelatedPages(entry.summary, candidates);
          if (related.length) {
            proposals.push({ pagePath: `${entry.linkPath}.md`, title: entry.title, related });
          }
        }
        this.statusEnd();
        if (!proposals.length) {
          new Notice('Nothing to relink — every page already has a Related section or no matches were found.');
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
              await this.app.vault.modify(file, content.trimEnd() + '\n' + section);
              await appendLog(this.app.vault, 'relink', prop.title);
            }
            new Notice(`Related sections added to ${proposals.length} pages.`, 4000);
          })();
        }).open();
      },
    });

    this.addCommand({
      id: 'litert-review-board',
      name: 'Review board (low-confidence and stale pages)',
      callback: () => {
        new ReviewBoardModal(this.app, buildReviewBoard(this.app, this.settings.staleDays), this.settings.staleDays).open();
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
      name: 'Reconcile wiki index (drop deleted pages)',
      callback: async () => {
        const before = (await readIndexEntries(this.app.vault)).length;
        await this.pruneIndex();
        const after = (await readIndexEntries(this.app.vault)).length;
        new Notice(
          before === after
            ? 'Index is already clean — no deleted pages listed.'
            : `Removed ${before - after} deleted page${before - after === 1 ? '' : 's'} from the index.`,
          5000
        );
      },
    });

    this.addCommand({
      id: 'litert-concept-page',
      name: 'Build a concept page from a tag (local Gemma)',
      callback: () => void this.createConceptPage(),
    });

    this.addCommand({
      id: 'litert-suggest-vocab',
      name: 'Organize tags (schema.md, local Gemma)',
      callback: () => void this.suggestTagVocabulary(),
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
        new Notice(result.ok ? `WebGPU OK — ${result.detail}` : `WebGPU FAILED — ${result.detail}`, 10000);
      },
    });

    this.addCommand({
      id: 'litert-load-wasm',
      name: '[Test] Load WASM runtime (no model download)',
      callback: async () => {
        new Notice('Loading LiteRT-LM WASM runtime… check the developer console (Cmd+Opt+I) for detail.', 5000);
        try {
          await this.ensureWasmLoaded();
          new Notice('LiteRT-LM WASM runtime loaded successfully.', 8000);
        } catch (err) {
          console.error('[litert-spike] wasm load failed', err);
          new Notice(
            `WASM load FAILED — see console for stack. ${err instanceof Error ? err.message : String(err)}`,
            12000
          );
        }
      },
    });

    this.addCommand({
      id: 'litert-download-model',
      name: 'Download model (one-time, ~3GB)',
      callback: async () => {
        const notice = new Notice('Preparing model download…', 0);
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
          new Notice('Select some text first, then run this command.');
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
            `Selection is ${selection.length} chars — over the ${MAX_INPUT_CHARS} limit for this spike. ` +
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

        const notice = new Notice('Loading model (first run downloads ~3GB)…', 0);
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
          new Notice('Select a short paragraph first, then run this command.');
          return;
        }
        if (selection.length > 3000) {
          new Notice('Keep it under 3000 chars for this test — pick a single paragraph.', 6000);
          return;
        }

        const RUNS = 5;
        const notice = new Notice(`JSON reliability test: loading model…`, 0);
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
        if (f.path.startsWith(`${wikiDir()}/`)) void this.pruneIndex();
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
      new Notice('Open a note first.');
      return;
    }
    const content = await this.app.vault.read(file);
    if (precheckNote(content, undefined) !== null) {
      new Notice('Note is empty — nothing to suggest.');
      return;
    }

    this.status(`Suggesting tags & links for "${file.basename}"…`);
    try {
      const clamped = clampToTokens(cleanClippedMarkdown(content), 2600);
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
          new Notice(`Updated "${file.basename}" — tags & links added.`, 3000);
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
  async openSchemaFile() {
    await ensureWikiScaffold(this.app.vault);
    const path = schemaPath();
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      await this.app.vault.create(path, buildSchemaFile([]));
      file = this.app.vault.getAbstractFileByPath(path);
    }
    if (file instanceof TFile) await this.app.workspace.getLeaf(true).openFile(file);
  }

  // Seed <wiki>/skills/ with a README and two example skills, then open the
  // README. Shared by the command and the settings button.
  async createSkillsFolder() {
    await ensureSkillsScaffold(this.app.vault);
    const path = `${wikiDir()}/skills`;
    new Notice(`Skills folder ready at ${path}. Open its README, then add a .md file per skill.`, 6000);
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
      if (!f.path.startsWith(`${wikiDir()}/`)) continue;
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
        'No tags yet — the vocabulary is built from the tags your ingested notes already produced. ' +
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
      new Notice('The model returned an empty vocabulary — nothing to write.', 5000);
      return;
    }

    // Preserve any Naming / Concept-threshold the user has set.
    const existing = await readSchema(this.app.vault);
    const content = buildSchemaFile(vocab, existing.naming, existing.conceptThreshold);
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
    // Gather tag -> member pages (from page frontmatter tags + index summaries).
    const entries = await readIndexEntries(this.app.vault);
    const byLinkPath = new Map(entries.map((e) => [e.linkPath, e]));
    const clusters = new Map<string, IndexEntry[]>();
    const SKIP = new Set(['concept', 'answer', 'chat']);
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!f.path.startsWith(`${wikiDir()}/`)) continue;
      const entry = byLinkPath.get(f.path.replace(/\.md$/, ''));
      if (!entry) continue;
      const raw = this.app.metadataCache.getFileCache(f)?.frontmatter?.tags;
      const tags = Array.isArray(raw)
        ? raw.map((t) => String(t))
        : typeof raw === 'string'
          ? raw.split(/[,\s]+/).filter(Boolean)
          : [];
      for (const t of tags) {
        if (SKIP.has(t)) continue;
        const list = clusters.get(t) ?? [];
        list.push(entry);
        clusters.set(t, list);
      }
    }
    const candidates = [...clusters.entries()]
      .filter(([, members]) => members.length >= minMembers)
      .map(([tag, members]) => ({ tag, members }))
      .sort((a, b) => b.members.length - a.members.length);

    if (!candidates.length) {
      new Notice(
        `No tag is shared by ${minMembers}+ pages yet (concept threshold = ${minMembers}). ` +
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

  // Semi-automatic ingest: scan (deterministic) → draft each candidate
  // (one model call apiece, same as manual ingest) → batch review gate.
  // The scan and the review modal live in auto-ingest.ts; the model calls
  // stay here because they need the engine. Manual trigger only — no
  // background timer yet, so nothing runs the GPU while you are away.
  async scanAndReviewIngest() {
    // Allow-list scope (opt-in): scan only looks at the folders the user named.
    // Blank means nothing to scan — guide them to set it (or ingest one note
    // by hand) rather than silently sweeping the whole vault.
    const includePrefixes = this.settings.scanInclude.split(',').map((s) => s.trim()).filter(Boolean);
    if (!includePrefixes.length) {
      new Notice(
        'No scan folders set. In Settings → "Scan these folders", name the folder(s) to scan ' +
          '(e.g. your inbox). To file one specific note instead, use "Ingest active note into wiki".',
        9000
      );
      return;
    }
    this.status('Scanning for new or changed notes…');
    const result = await findIngestCandidates(this.app, {
      quietHours: this.settings.scanQuietHours,
      maxPerRun: this.settings.scanMaxPerRun,
      includePrefixes,
      excludePrefixes: this.settings.scanExclude.split(',').map((s) => s.trim()).filter(Boolean),
    });
    if (!result.eligible.length) {
      this.statusEnd(
        result.scanned
          ? `Scanned ${result.scanned} notes — nothing new or changed to ingest.`
          : 'No notes in scope to scan.',
        5000
      );
      return;
    }

    // Draft each candidate through the same pipeline as manual ingest.
    // Failures are collected and skipped, never block the batch.
    const drafts: IngestDraft[] = [];
    let failed = 0;
    const n = result.eligible.length;
    for (let i = 0; i < n; i++) {
      const { file, reason } = result.eligible[i];
      try {
        const content = await this.app.vault.read(file);
        const clamped = clampToTokens(cleanClippedMarkdown(content), 2600);
        const extraction = await this.extractNoteMetadata(clamped.text, (t) =>
          this.status(`Drafting ${i + 1}/${n} — ${file.basename} · ${t}`)
        );
        const sourceHash = contentHash(content);
        const pagePath = wikiPagePath(file.basename);
        const selfLink = pagePath.replace(/\.md$/, '');
        const candidates = (await this.liveIndexEntries()).filter((e) => e.linkPath !== selfLink);
        let related: { title: string; linkPath: string }[] = [];
        if (candidates.length) {
          this.status(`Drafting ${i + 1}/${n} — ${file.basename} · finding related pages…`);
          related = await this.pickRelatedPages(extraction.summary, candidates);
        }
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
      new Notice('Every draft failed to generate — nothing to review.', 6000);
      return;
    }

    const capNote = result.cappedOut
      ? ` (${result.cappedOut} more left for the next scan)`
      : '';
    new Notice(`${drafts.length} draft${drafts.length === 1 ? '' : 's'} ready to review${capNote}.`, 4000);

    new AutoIngestReviewModal(this.app, drafts, failed, async (approved) => {
      if (!approved.length) return;
      await ensureWikiScaffold(this.app.vault);
      for (const d of approved) {
        await writeWikiPage(this.app.vault, d.pagePath, d.pageContent);
        await upsertIndexEntry(this.app.vault, d.pagePath, d.file.basename, d.summary);
        await this.pruneIndex();
        await appendLog(this.app.vault, 'ingest', d.file.basename);
      }
      this.refreshIngestBadges();
      new Notice(`Wrote ${approved.length} page${approved.length === 1 ? '' : 's'} to the wiki.`, 4000);
    }).open();
  }

  // The one write operation that touches a raw note — and therefore the
  // most tightly constrained call in the plugin: structure, formatting,
  // and typos only, wording and voice preserved, full result shown in the
  // preview gate before a single byte is written. The input cap is
  // token-estimated per script, not a flat char count: English runs
  // ~4 chars/token but CJK runs ~1-1.5 tokens/char, so the old flat
  // 5000-char cap (calibrated on English ≈ 1250 tokens) overflowed the
  // 4096-token context on Chinese notes and guaranteed a 2048-token
  // output truncation — the same failure mode that bit the V1 grammar
  // tests twice.
  async improveActiveNote() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice('Open a note first.');
      return;
    }
    // With a selection active, improve just the selection — the escape
    // hatch for notes over the whole-note cap: work through them piece by
    // piece.
    const mdView = this.app.workspace
      .getLeavesOfType('markdown')
      .map((l) => l.view)
      .find((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === file.path);
    const editor = mdView?.editor;
    const selection = editor?.getSelection() ?? '';
    const usingSelection = !!selection.trim();
    const content = usingSelection ? selection : await this.app.vault.read(file);
    if (!content.trim()) {
      new Notice('Note is empty — nothing to improve.');
      return;
    }
    // Estimate tokens per script: CJK (Han/kana/Hangul/fullwidth) ≈ 1.5
    // tokens per char, everything else ≈ 4 chars per token. Budget:
    // input (≤1750) + same-sized rewrite (≤2048) + system prompt (~150)
    // stays under the 4096-token context.
    const cjkChars = (content.match(
      /[　-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/g
    ) ?? []).length;
    const estTokens = Math.ceil(cjkChars * 1.5 + (content.length - cjkChars) / 4);
    const MAX_INPUT_TOKENS = 1750;
    if (estTokens > MAX_INPUT_TOKENS) {
      new Notice(
        `${usingSelection ? 'Selection' : `"${file.basename}"`} is ~${estTokens} tokens — over the ` +
          `${MAX_INPUT_TOKENS} limit (input plus a same-sized rewrite must fit the model's 4096-token context; ` +
          'CJK text costs ~1.5 tokens per character, so the char budget is smaller for Chinese/Japanese notes). ' +
          (usingSelection
            ? 'Select a smaller passage.'
            : 'Select a section and run Improve again to work through long notes piece by piece.'),
        10000
      );
      return;
    }

    this.status(`Improving "${file.basename}"…`);
    let conversation: import('@litert-lm/core').Conversation | undefined;
    try {
      const engine = await this.ensureEngine((t) => this.status(`Improving "${file.basename}" — ${t}`));
      const { SamplerType } = await import('@litert-lm/core');
      conversation = await engine.createConversation({
        preface: {
          messages: [
            {
              role: 'system',
              content:
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
                'Return ONLY the full note in markdown, no explanation.',
            },
          ],
        },
        sessionConfig: {
          samplerParams: { type: SamplerType.GREEDY },
          // Output is a same-sized rewrite of the input; cap it just above
          // the input estimate instead of a flat 2048 so short notes can't
          // run away and long CJK notes aren't silently truncated.
          maxOutputTokens: Math.min(2048, estTokens + 300),
        },
      });
      const message = await conversation.sendMessage(content);
      let raw = '';
      const c = message.content;
      if (typeof c === 'string') raw = c;
      else if (Array.isArray(c)) {
        for (const part of c) {
          if (part.type === 'text' && part.text) raw += part.text;
        }
      }
      this.statusEnd();
      const improved = raw
        .trim()
        .replace(/^```(?:markdown|md)?\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();
      if (!improved) throw new Error('Model returned an empty result.');

      new IngestPreviewModal(
        this.app,
        usingSelection ? `${file.path} (selected text only)` : file.path,
        improved,
        true,
        () => {
          void (async () => {
            if (usingSelection && editor) {
              editor.replaceSelection(improved);
            } else {
              await this.app.vault.modify(file, improved);
            }
            await appendLog(this.app.vault, 'improve', file.basename);
            new Notice(`Note updated: ${file.basename}`, 3000);
          })();
        }
      ).open();
    } catch (err) {
      console.error('[gemma4-litert-wiki] improve failed', err);
      this.status(`Improve FAILED — ${err instanceof Error ? err.message : String(err)}`);
      this.statusEnd(undefined, 8000);
    } finally {
      await conversation?.delete().catch(() => {});
    }
  }

  // Second single-schema call in the ingest flow: given the new page's
  // summary and the index catalog, pick up to 3 genuinely related existing
  // pages. A convergent multiple-choice task, not open generation — the
  // model can only answer with titles from the provided list, and anything
  // else is dropped in validation. Failure returns [] and never blocks
  // ingest; related links are an enhancement, not a requirement.
  async pickRelatedPages(
    summary: string,
    candidates: IndexEntry[]
  ): Promise<{ title: string; linkPath: string }[]> {
    try {
      const engine = await this.ensureEngine(() => {});
      const { SamplerType } = await import('@litert-lm/core');
      const catalog = candidates
        .slice(0, 30)
        .map((e) => `- ${e.title}: ${e.summary}`)
        .join('\n');
      let conversation: import('@litert-lm/core').Conversation | undefined;
      try {
        conversation = await engine.createConversation({
          preface: {
            messages: [
              {
                role: 'system',
                content:
                  'You link wiki pages. The user gives you a new page summary and a catalog of ' +
                  'existing pages. Respond with ONLY a JSON object, no fences, no explanation: ' +
                  '{"related": ["Exact Title", ...]}. Pick 0 to 3 titles from the catalog that are ' +
                  'genuinely related to the new page. Titles must match the catalog EXACTLY. ' +
                  'If nothing is related, return {"related": []}.',
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
        return parsed.related
          .filter((t): t is string => typeof t === 'string')
          .map((t) => byTitle.get(t))
          .filter((e): e is IndexEntry => !!e)
          .slice(0, 3)
          .map((e) => ({ title: e.title, linkPath: e.linkPath }));
      } finally {
        await conversation?.delete().catch(() => {});
      }
    } catch (err) {
      console.error('[gemma4-litert-wiki] related-pages pick failed (non-blocking)', err);
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

    // Schema layer (issues #3, #38): reuse existing tags instead of inventing a
    // fresh synonym every time ("llm-eval" vs "llm-evaluation" vs "evals"). Two
    // tiers so it works before a vocabulary exists: prefer the curated
    // schema.md vocabulary; if there is none yet, fall back to the tags already
    // in use on the wiki (frequency-ranked). Either way capped so the list
    // never crowds the 4096-token context.
    const VOCAB_CAP = 40;
    const schema = await readSchema(this.app.vault);
    const schemaTags = schema.tags;
    const vocab = (schemaTags.length ? schemaTags : this.wikiTagCounts().map(([t]) => t)).slice(0, VOCAB_CAP);
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
                  '"confidence": "high"}. ' +
                  'Exactly 3 tags (short lowercase noun phrases). 3 to 5 key_points, each ONE short ' +
                  'self-contained sentence stating concrete content from the note. confidence is ' +
                  '"high", "med", or "low": how faithfully your summary and key_points represent the ' +
                  'note (use "low" for dense, ambiguous, or heavily technical notes you may have ' +
                  'misread).' +
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
    const notice = new Notice(`Renaming ${prev} → ${next}…`, 0);
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
            await this.app.fileManager.renameFile(child, dest);
          }
        } else {
          await this.app.fileManager.renameFile(prevFolder, next);
        }
      }
      this.settings.wikiDir = next;
      await this.saveSettings();
      setWikiDir(next);
      this.refreshIngestBadges();
      notice.setMessage(`Wiki folder is now "${next}".`);
      setTimeout(() => notice.hide(), 4000);
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
    const notice = new Notice('Preparing model download…', 0);
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
      const total = p.totalBytes ? ` / ${(p.totalBytes / 1e6).toFixed(0)} MB` : '';
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
        const engine = await Engine.create({ model: modelBlob, benchmarkEnabled: true });
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
