import * as fs from 'node:fs';
import * as path from 'node:path';

// Resumable, on-disk model store. The 2.97 GB first download is the single
// biggest activation risk (see the commercialization notes), and a plain
// streamed fetch to the Cache API restarts from zero on any network blip
// or app restart. This downloads with HTTP Range requests into a .partial
// file on disk, so an interrupted download resumes from the last byte on
// the next attempt — desktop-only, so Node fs is available.

const MODEL_FILENAME = 'gemma-4-E4B-it-web.litertlm';
const PARTIAL_SUFFIX = '.partial';

export interface DownloadProgress {
  receivedBytes: number;
  totalBytes: number;
  resumed: boolean;
}

function modelPaths(pluginDir: string) {
  const final = path.join(pluginDir, MODEL_FILENAME);
  return { final, partial: final + PARTIAL_SUFFIX };
}

export function isModelDownloaded(pluginDir: string): boolean {
  return fs.existsSync(modelPaths(pluginDir).final);
}

export function partialBytes(pluginDir: string): number {
  const { partial } = modelPaths(pluginDir);
  try {
    return fs.statSync(partial).size;
  } catch {
    return 0;
  }
}

// Returns the finished model as a Blob, downloading it (resumably) first if
// it isn't already on disk. onProgress fires ~1/s during download.
export async function getModelBlob(
  pluginDir: string,
  modelUrl: string,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<Blob> {
  const { final, partial } = modelPaths(pluginDir);

  if (!fs.existsSync(final)) {
    const migrated = await migrateFromLegacyCache(final, modelUrl, onProgress);
    if (!migrated) {
      await downloadResumable(final, partial, modelUrl, onProgress, signal);
    }
  }

  return fileToBlob(final);
}

// fs.readFile throws "File size ... is greater than 2 GiB" on files past
// 2^31-1 bytes, and the model is ~2.97 GB. Stream it in chunks into an
// array of Uint8Array and build one Blob from the parts — a Blob's total
// size is not capped at 2 GiB, only a single Node Buffer is.
async function fileToBlob(filePath: string): Promise<Blob> {
  const parts: BlobPart[] = [];
  await new Promise<void>((resolve, reject) => {
    const rs = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 * 1024 });
    rs.on('data', (chunk: string | Buffer) => {
      const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      // Slice out a standalone ArrayBuffer so the part is a plain
      // ArrayBuffer, not ArrayBufferLike (BlobPart typing).
      parts.push(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    });
    rs.on('end', resolve);
    rs.on('error', reject);
  });
  return new Blob(parts, { type: 'application/octet-stream' });
}

async function downloadResumable(
  final: string,
  partial: string,
  modelUrl: string,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  let startByte = 0;
  try {
    startByte = fs.statSync(partial).size;
  } catch {
    startByte = 0;
  }

  const headers: Record<string, string> = {};
  if (startByte > 0) headers['Range'] = `bytes=${startByte}-`;

  // fetch, not Obsidian's requestUrl, and the store's linter flags it. The
  // reason is the size: requestUrl resolves once with the whole body in
  // memory, and this body is ~3 GB. Streaming is not a preference here — it is
  // the difference between a progress bar and an out-of-memory crash, and it
  // is what lets a cancelled or dropped download resume from a byte offset
  // (the Range header above) instead of starting over.
  const response = await fetch(modelUrl, { headers, signal });

  // 206 = server honored the range and we resume; 200 = it ignored the
  // range (or this is a fresh start), so we must restart from zero.
  const resuming = response.status === 206;
  if (!response.ok || !response.body) {
    throw new Error(`Model download failed: HTTP ${response.status}`);
  }
  if (startByte > 0 && !resuming) {
    // Server can't resume — discard the stale partial and start over.
    await fs.promises.rm(partial, { force: true });
    startByte = 0;
  }

  // total = full file size. With 206 the Content-Range tail is the total;
  // with 200 it's the Content-Length.
  let total = 0;
  const contentRange = response.headers.get('content-range');
  if (resuming && contentRange) {
    total = Number(contentRange.split('/')[1]) || 0;
  } else {
    total = startByte + Number(response.headers.get('content-length') ?? 0);
  }

  const out = fs.createWriteStream(partial, { flags: startByte > 0 ? 'a' : 'w' });
  let received = startByte;
  let lastReport = 0;
  onProgress({ receivedBytes: received, totalBytes: total, resumed: startByte > 0 });

  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        await new Promise<void>((resolve, reject) =>
          out.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()))
        );
        received += value.byteLength;
        const now = Date.now();
        if (now - lastReport > 800) {
          lastReport = now;
          onProgress({ receivedBytes: received, totalBytes: total, resumed: startByte > 0 });
        }
      }
    }
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }

  if (total > 0 && received < total) {
    // Stream ended early (dropped connection): keep the .partial so the
    // next call resumes; surface as an error so the caller can retry.
    throw new Error(`Download interrupted at ${received} of ${total} bytes — run download again to resume.`);
  }

  await fs.promises.rename(partial, final);
  onProgress({ receivedBytes: total || received, totalBytes: total || received, resumed: startByte > 0 });
}

const LEGACY_CACHE_NAME = 'litert-spike-model-v1';

export async function migrateFromLegacyCache(
  final: string,
  modelUrl: string,
  onProgress: (p: DownloadProgress) => void
): Promise<boolean> {
  try {
    if (typeof caches === 'undefined') return false;
    const cache = await caches.open(LEGACY_CACHE_NAME);
    const hit = await cache.match(modelUrl);
    if (!hit) return false;
    if (!hit.body) return false;
    onProgress({ receivedBytes: 0, totalBytes: 0, resumed: true });
    const tmp = final + PARTIAL_SUFFIX;
    const out = fs.createWriteStream(tmp, { flags: 'w' });
    const reader = hit.body.getReader();
    let written = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        await new Promise<void>((resolve, reject) =>
          out.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()))
        );
        written += value.byteLength;
      }
    }
    await new Promise<void>((resolve) => out.end(resolve));
    await fs.promises.rename(tmp, final);
    await cache.delete(modelUrl).catch(() => {});
    onProgress({ receivedBytes: written, totalBytes: written, resumed: true });
    return true;
  } catch {
    return false;
  }
}

// Pre-gate helper for callers that only have the plugin dir: silently move
// a legacy Cache-API model to disk if present. Returns true if migrated.
export async function tryMigrateLegacyCache(
  pluginDir: string,
  modelUrl: string
): Promise<boolean> {
  const { final } = modelPaths(pluginDir);
  if (fs.existsSync(final)) return true;
  return migrateFromLegacyCache(final, modelUrl, () => {});
}
