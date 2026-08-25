import { addIcon, FileSystemAdapter, MarkdownView, Notice, Plugin, setIcon, WorkspaceLeaf } from 'obsidian';
import * as http from 'node:http';
import type { Server } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Engine } from '@litert-lm/core';
import { ChatView, VIEW_TYPE_CHAT } from './chat-view';
import { IngestPreviewModal, OnboardingModal, RelinkPreviewModal, type RelinkProposal } from './ingest-modal';
import { getModelBlob, isModelDownloaded, partialBytes } from './model-store';
import {
  appendLog,
  buildWikiPage,
  ensureWikiScaffold,
  upsertIndexEntry,
  clampToTokens,
  contentHash,
  getIngestedSourceHashes,
  getIngestedSourcePaths,
  precheckNote,
  readIndexEntries,
  wikiPagePath,
  writeWikiPage,
  type IndexEntry,
  type NoteExtraction,
} from './wiki-store';
import { LintReportModal, runLint } from './lint';
import { TFile } from 'obsidian';

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

export default class LiteRtSpikePlugin extends Plugin {
  private server: Server | null = null;
  private serverBaseUrl: string | null = null;
  private wasmLoadPromise: Promise<void> | null = null;
  private enginePromise: Promise<Engine> | null = null;
  private statusNotice: Notice | null = null;

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
          new Notice(`"${file.basename}" is already in the wiki and unchanged — skipped.`, 5000);
          return;
        }
        void pagePathForCheck;

        // Clamp to the engine context (token-estimated, CJK-aware) rather
        // than rejecting on a char count — a summary card of the first
        // part beats nothing, and the marker tells the model the tail is
        // missing.
        const clamped = clampToTokens(content, 2600);
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
          const candidates = (await readIndexEntries(this.app.vault)).filter(
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
        const entries = await readIndexEntries(this.app.vault);
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
      id: 'litert-lint-wiki',
      name: 'Lint wiki (orphans and index health)',
      callback: async () => {
        new LintReportModal(this.app, await runLint(this.app)).open();
      },
    });

    this.addCommand({
      id: 'litert-check-webgpu',
      name: 'LiteRT spike: check WebGPU',
      callback: async () => {
        const result = await checkWebGPU();
        log('WebGPU check:', result);
        new Notice(result.ok ? `WebGPU OK — ${result.detail}` : `WebGPU FAILED — ${result.detail}`, 10000);
      },
    });

    this.addCommand({
      id: 'litert-load-wasm',
      name: 'LiteRT spike: load WASM runtime (no model download)',
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
      name: 'LiteRT spike: download Gemma 4 E4B model (one-time, ~3GB)',
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
      name: 'LiteRT spike: fix grammar of selection',
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
      name: 'LiteRT spike: JSON reliability test (5 runs)',
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
                  'misread).',
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
