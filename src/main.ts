import { FileSystemAdapter, Notice, Plugin } from 'obsidian';
import * as http from 'node:http';
import type { Server } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Engine } from '@litert-lm/core';

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
const CACHE_NAME = 'litert-spike-model-v1';

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

// Same pattern as skim-recap's offscreen.ts fetchModelWithCache: stream the
// download straight into the Cache API rather than buffering a 3 GB
// response in JS memory, reporting progress as chunks arrive.
async function fetchModelWithCache(onProgress: (text: string) => void): Promise<Blob> {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(MODEL_URL);
  if (cached) {
    onProgress('Loading cached model…');
    return cached.blob();
  }

  onProgress('Downloading model (first run only, ~3GB)…');
  const response = await fetch(MODEL_URL);
  if (!response.ok || !response.body) {
    throw new Error(`Model download failed: HTTP ${response.status}`);
  }
  const total = Number(response.headers.get('content-length') ?? 0);

  let received = 0;
  let lastLog = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      const now = Date.now();
      if (now - lastLog > 1000) {
        lastLog = now;
        const mb = (received / 1e6).toFixed(0);
        onProgress(
          total > 0 ? `Downloading… ${mb} / ${(total / 1e6).toFixed(0)} MB` : `Downloading… ${mb} MB`
        );
      }
      controller.enqueue(chunk);
    },
  });

  await cache.put(
    MODEL_URL,
    new Response(response.body.pipeThrough(counter), {
      headers: { 'content-type': 'application/octet-stream' },
    })
  );

  const stored = await cache.match(MODEL_URL);
  if (!stored) {
    throw new Error('Model downloaded but could not be cached — free up disk space and retry.');
  }
  return stored.blob();
}

export default class LiteRtSpikePlugin extends Plugin {
  private server: Server | null = null;
  private serverBaseUrl: string | null = null;
  private wasmLoadPromise: Promise<void> | null = null;
  private enginePromise: Promise<Engine> | null = null;

  async onload() {
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
        const notice = new Notice('Starting model download…', 0);
        try {
          await this.ensureWasmLoaded();
          const blob = await fetchModelWithCache((text) => {
            log(text);
            notice.setMessage(text);
          });
          log('Model cached. Size bytes:', blob.size);
          notice.setMessage(`Model cached. Size: ${(blob.size / 1e9).toFixed(2)} GB`);
          setTimeout(() => notice.hide(), 5000);
        } catch (err) {
          console.error('[litert-spike] model download failed', err);
          notice.setMessage(`Download FAILED — see console. ${err instanceof Error ? err.message : String(err)}`);
          setTimeout(() => notice.hide(), 12000);
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
  }

  onunload() {
    this.server?.close();
    this.server = null;
    this.serverBaseUrl = null;
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

  private ensureEngine(onProgress: (text: string) => void): Promise<Engine> {
    if (!this.enginePromise) {
      this.enginePromise = (async () => {
        await this.ensureWasmLoaded();
        const { Engine } = await import('@litert-lm/core');
        const modelBlob = await fetchModelWithCache(onProgress);
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
