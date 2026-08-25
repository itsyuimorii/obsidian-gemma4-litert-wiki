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
    await downloadResumable(final, partial, modelUrl, onProgress, signal);
  }

  const buf = await fs.promises.readFile(final);
  // Copy into a fresh ArrayBuffer so the Blob doesn't alias Node's Buffer pool.
  return new Blob([new Uint8Array(buf)], { type: 'application/octet-stream' });
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
