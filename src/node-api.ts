/**
 * The Node surface this plugin uses, declared rather than inferred.
 *
 * The plugin runs in a Node-integrated Electron renderer, so `node:fs`,
 * `node:path` and `node:http` are available — but their types are not always.
 * The community directory's scanner type-checks the source without
 * `@types/node` installed, which turns every one of those modules into `any`
 * and every call into a `no-unsafe-call` finding: a hundred and fifty of them
 * in one report, all describing the same missing dependency rather than
 * anything about this code.
 *
 * So the boundary is crossed exactly once, here, through interfaces naming the
 * fourteen functions we actually call. Every call site downstream is typed
 * whether or not the checker can find Node's own definitions — and the reader
 * gets a list of what this plugin does to a filesystem, which the wildcard
 * imports never gave them.
 */

export interface Stats {
  size: number;
  mtimeMs: number;
}

/**
 * A chunk of bytes crossing this boundary. Node hands over Buffers, which are
 * Uint8Arrays with extra methods this plugin never calls — so the name says
 * what travels, and the type says only what is relied on.
 */
export type Bytes = Uint8Array;

export interface BufferApi {
  from(data: ArrayBufferLike | Uint8Array | string): Bytes;
  concat(list: Bytes[]): Bytes;
  alloc(size: number): Bytes;
}

export interface WriteStream {
  write(chunk: Bytes, cb: (err: Error | null | undefined) => void): boolean;
  end(cb?: () => void): void;
  destroy(): void;
}

export interface ReadStream {
  on(event: 'data', cb: (chunk: string | Bytes) => void): ReadStream;
  on(event: 'end', cb: () => void): ReadStream;
  on(event: 'error', cb: (err: Error) => void): ReadStream;
  destroy(): void;
}

export interface FsApi {
  existsSync(p: string): boolean;
  mkdirSync(p: string, opts?: { recursive?: boolean }): void;
  readdirSync(p: string): string[];
  statSync(p: string): Stats;
  renameSync(from: string, to: string): void;
  rmSync(p: string, opts?: { force?: boolean }): void;
  writeFileSync(p: string, data: string): void;
  openSync(p: string, flags: string): number;
  writeSync(fd: number, data: Bytes, offset?: number, length?: number): number;
  closeSync(fd: number): void;
  readFile(p: string, cb: (err: Error | null, data: Bytes) => void): void;
  createWriteStream(p: string, opts?: { flags?: string }): WriteStream;
  createReadStream(p: string, opts?: { highWaterMark?: number }): ReadStream;
  promises: {
    stat(p: string): Promise<Stats>;
    unlink(p: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    rm(p: string, opts?: { force?: boolean }): Promise<void>;
  };
}

export interface PathApi {
  join(...parts: string[]): string;
  basename(p: string, ext?: string): string;
  extname(p: string): string;
  normalize(p: string): string;
  resolve(...parts: string[]): string;
  readonly sep: string;
}

export interface HttpRequest {
  url?: string;
}

export interface HttpResponse {
  writeHead(status: number, headers?: Record<string, string>): HttpResponse;
  end(data?: Bytes | string): void;
}

export interface HttpServer {
  listen(port: number, host: string, cb: () => void): void;
  address(): { port: number } | string | null;
  on(event: 'error', cb: (err: Error) => void): void;
  close(): void;
}

export interface HttpApi {
  createServer(handler: (req: HttpRequest, res: HttpResponse) => void): HttpServer;
}

// The one place an untyped module becomes a typed one. `as unknown as` rather
// than a direct assertion: when the checker has no Node types the import is
// `any`, and going through `unknown` is what stops that `any` from flowing on
// into everything it touches.
import { Buffer as nodeBuffer } from 'node:buffer';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import * as nodeHttp from 'node:http';

const rawFs = nodeFs as unknown as FsApi;
export const path = nodePath as unknown as PathApi;
export const http = nodeHttp as unknown as HttpApi;
export const bytes = nodeBuffer as unknown as BufferApi;

// ---------------------------------------------------------------------------
// Confinement
// ---------------------------------------------------------------------------

/**
 * The one directory this plugin's filesystem calls may touch.
 *
 * Everything written outside the vault API is the model file, the WebGPU
 * runtime that runs it, and the partial downloads of both: gigabytes that
 * cannot be buffered into `vault.adapter.writeBinary` without an
 * out-of-memory crash, and that must resume from a byte offset when a
 * download drops. All of it lives in this plugin's own folder under
 * `.obsidian/plugins/`.
 *
 * "Uses the Node fs module" is true, and the honest reading of it is "can
 * read and write any file on the system" — unless something stops it. This
 * is that something: `confineFilesystemTo` is called once, at load, with
 * the plugin's own directory, and every call below refuses a path outside
 * it. A reviewer does not have to trace fourteen call sites to know what
 * this plugin can reach; they have to read one function.
 */
let root: string | null = null;

/** Called once at plugin load. Later calls are ignored, so nothing can widen it. */
export function confineFilesystemTo(dir: string): void {
  if (root === null) root = path.resolve(dir);
}

/** For tests and for the settings page, which shows where the model lives. */
export function filesystemRoot(): string | null {
  return root;
}

/**
 * Resolve a path and prove it is inside the root. `path.resolve` collapses
 * `..` first, so a traversal is compared after it has been spent rather than
 * before. The separator on the end is what stops the root's name from being
 * a prefix of a sibling: `/plugins/gemma-litert-wiki` must not admit
 * `/plugins/gemma-litert-wiki-evil`.
 */
function inside(p: string): string {
  if (root === null) throw new Error('Filesystem used before confineFilesystemTo()');
  const abs = path.resolve(p);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Refused: ${abs} is outside this plugin's folder`);
  }
  return abs;
}

/**
 * The same fourteen functions, each with its path arguments checked. Written
 * out rather than proxied: a list a reader can audit is the point.
 */
export const fs: FsApi = {
  existsSync: (p) => rawFs.existsSync(inside(p)),
  mkdirSync: (p, opts) => rawFs.mkdirSync(inside(p), opts),
  readdirSync: (p) => rawFs.readdirSync(inside(p)),
  statSync: (p) => rawFs.statSync(inside(p)),
  renameSync: (from, to) => rawFs.renameSync(inside(from), inside(to)),
  rmSync: (p, opts) => rawFs.rmSync(inside(p), opts),
  writeFileSync: (p, data) => rawFs.writeFileSync(inside(p), data),
  openSync: (p, flags) => rawFs.openSync(inside(p), flags),
  // A descriptor, not a path: it can only have come from openSync above.
  writeSync: (fd, data, offset, length) => rawFs.writeSync(fd, data, offset, length),
  closeSync: (fd) => rawFs.closeSync(fd),
  readFile: (p, cb) => {
    let abs: string;
    try {
      abs = inside(p);
    } catch (err) {
      // The callback is this function's only way to report, so a refusal
      // travels the same road an ENOENT would.
      cb(err as Error, bytes.alloc(0));
      return;
    }
    rawFs.readFile(abs, cb);
  },
  createWriteStream: (p, opts) => rawFs.createWriteStream(inside(p), opts),
  createReadStream: (p, opts) => rawFs.createReadStream(inside(p), opts),
  promises: {
    stat: async (p) => rawFs.promises.stat(inside(p)),
    unlink: async (p) => rawFs.promises.unlink(inside(p)),
    rename: async (from, to) => rawFs.promises.rename(inside(from), inside(to)),
    rm: async (p, opts) => rawFs.promises.rm(inside(p), opts),
  },
};
