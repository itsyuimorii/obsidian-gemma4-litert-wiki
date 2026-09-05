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

export const fs = nodeFs as unknown as FsApi;
export const path = nodePath as unknown as PathApi;
export const http = nodeHttp as unknown as HttpApi;
export const bytes = nodeBuffer as unknown as BufferApi;
