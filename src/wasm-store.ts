import * as fs from 'node:fs';
import * as path from 'node:path';

// On-demand store for the LiteRT-LM WebAssembly runtime.
//
// The runtime ships as four variants totalling ~101 MB, and exactly one of
// them is ever loaded: @litert-lm/core picks between them at load time from
// two feature probes (relaxed SIMD, and JSPI), so a machine fetches either
// litertlm_wasm_internal (~20 MB) or litertlm_wasm_asyncify_internal (~31 MB),
// with the two `compat` variants reserved for engines without relaxed SIMD.
//
// The build used to vendor all four into the plugin folder, which worked only
// because the plugin folder was a symlink to this repo during development.
// Obsidian's community store installs exactly three files — main.js,
// manifest.json, styles.css — so a store install had no wasm/ at all and 404ed
// on the first question.
//
// Rather than predict which variant is needed and ship or fetch that one, this
// fetches whatever the library actually asks for, the first time it asks, and
// keeps it on disk next to the model. The selection rule stays where it
// belongs — inside the library — so it cannot drift out of sync with a copy of
// the probe kept here. Nothing is fetched after the first run.

// Injected by build.js from the installed @litert-lm/core, so the CDN version
// can never drift from the version the bundled JS glue expects. Unversioned
// jsDelivr paths 404, so this must always be pinned.
declare const __LITERT_VERSION__: string;
const CDN_BASE = `https://cdn.jsdelivr.net/npm/@litert-lm/core@${__LITERT_VERSION__}/wasm/`;

// Only the runtime's own files are fetchable. Without this, any 404 inside the
// served directory would turn the loopback server into an open proxy for
// arbitrary jsDelivr paths.
const ALLOWED = /^litertlm_wasm_[a-z_]*internal\.(js|wasm)$/;

export function isRuntimeFile(fileName: string): boolean {
  return ALLOWED.test(fileName);
}

const PARTIAL_SUFFIX = '.partial';

// How long the stream may go silent before the download is treated as dead.
// Generous on purpose: this is not a deadline for the whole transfer, only for
// the gap between two chunks.
const STALL_MS = 60_000;

// The glue .js and its .wasm are requested back to back, and a reload can ask
// again while the first fetch is still running. One promise per file keeps a
// slow 31 MB download from being started twice.
const inFlight = new Map<string, Promise<string>>();

export interface WasmProgress {
  fileName: string;
  receivedBytes: number;
  totalBytes: number;
}

/**
 * Resolve `fileName` inside `wasmDir`, downloading it from the pinned CDN if it
 * is not already on disk. Returns the absolute path of the finished file.
 */
export function ensureRuntimeFile(
  wasmDir: string,
  fileName: string,
  onProgress?: (p: WasmProgress) => void
): Promise<string> {
  if (!isRuntimeFile(fileName)) {
    return Promise.reject(new Error(`Not a LiteRT-LM runtime file: ${fileName}`));
  }
  const final = path.join(wasmDir, fileName);
  if (fs.existsSync(final)) return Promise.resolve(final);

  const running = inFlight.get(final);
  if (running) return running;

  const job = download(wasmDir, fileName, final, onProgress).finally(() => {
    inFlight.delete(final);
  });
  inFlight.set(final, job);
  return job;
}

async function download(
  wasmDir: string,
  fileName: string,
  final: string,
  onProgress?: (p: WasmProgress) => void
): Promise<string> {
  fs.mkdirSync(wasmDir, { recursive: true });

  // Written under a .partial name and renamed only once the body is complete:
  // a download interrupted halfway must not leave a truncated file that
  // existsSync() would then treat as cached forever.
  const partial = final + PARTIAL_SUFFIX;
  const url = CDN_BASE + fileName;

  // A stall is the failure this has to survive, not a refusal. A CDN that
  // accepts the connection and then sends nothing leaves `reader.read()`
  // pending forever, and because the caller marks the plugin busy for the
  // duration, every other command refuses with "Busy" until Obsidian is
  // restarted — with nothing on screen saying why. The timer is reset by
  // arriving bytes rather than set once, so a slow but live 31 MB download
  // is never cut off; only a genuinely silent one is.
  const controller = new AbortController();
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(), STALL_MS);
  };

  armStall();
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (err) {
    clearTimeout(stallTimer);
    throw controller.signal.aborted
      ? new Error(`${fileName} stopped responding after ${STALL_MS / 1000}s — check your network and try again.`)
      : err;
  }
  if (!response.ok || !response.body) {
    clearTimeout(stallTimer);
    throw new Error(`Could not fetch ${fileName} (HTTP ${response.status}) from ${url}`);
  }

  // The CDN compresses these, so content-length is the size on the wire while
  // the stream hands back decompressed bytes — comparing the two rejected
  // every download as "incomplete". It is only a usable total when nothing was
  // encoded; otherwise the transfer is indeterminate and progress says so with
  // a zero total.
  const encoded = !!response.headers.get('content-encoding');
  const totalBytes = encoded ? 0 : Number(response.headers.get('content-length') ?? 0);
  let receivedBytes = 0;
  let lastReport = 0;

  // Integrity comes from the rename, not from a byte count: the file only
  // takes its real name once the stream has ended without throwing, so an
  // interrupted download leaves a .partial that nothing will ever read.
  try {
    const handle = fs.openSync(partial, 'w');
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        armStall();
        // writeSync is allowed to write fewer bytes than it was given, and
        // does not loop. receivedBytes counts what was READ, so a short write
        // would pass the completeness check below, get renamed to its final
        // name, and be cached as a valid-looking truncated runtime forever.
        for (let off = 0; off < value.byteLength; ) {
          off += fs.writeSync(handle, value, off, value.byteLength - off);
        }
        receivedBytes += value.byteLength;
        // ~1 report/second, matching the model download's cadence.
        const now = Date.now();
        if (onProgress && now - lastReport > 1000) {
          lastReport = now;
          onProgress({ fileName, receivedBytes, totalBytes });
        }
      }
    } finally {
      fs.closeSync(handle);
    }

    if (totalBytes && receivedBytes !== totalBytes) {
      throw new Error(
        `${fileName} arrived incomplete (${receivedBytes} of ${totalBytes} bytes) — run it again to retry.`
      );
    }
    if (receivedBytes === 0) {
      throw new Error(`${fileName} arrived empty — run it again to retry.`);
    }
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw controller.signal.aborted
      ? new Error(
          `${fileName} stopped arriving after ${STALL_MS / 1000}s of silence — nothing was kept, so run it again to retry.`
        )
      : err;
  } finally {
    clearTimeout(stallTimer);
  }

  fs.renameSync(partial, final);
  onProgress?.({ fileName, receivedBytes, totalBytes: totalBytes || receivedBytes });
  return final;
}

/** Bytes of runtime already on disk — used by the settings pane. */
export function runtimeBytesOnDisk(wasmDir: string): number {
  let total = 0;
  try {
    for (const name of fs.readdirSync(wasmDir)) {
      if (!isRuntimeFile(name)) continue;
      total += fs.statSync(path.join(wasmDir, name)).size;
    }
  } catch {
    return 0;
  }
  return total;
}
