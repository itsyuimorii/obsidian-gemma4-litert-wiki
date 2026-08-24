import { build } from 'esbuild';
import { cpSync, existsSync, rmSync } from 'node:fs';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'main.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2020',
  external: ['obsidian', 'electron'],
  sourcemap: true,
  logLevel: 'info',
});

// Vendor the LiteRT-LM wasm runtime locally, same approach as skim-recap:
// the JS glue is bundled into main.js, but the .wasm binaries are fetched
// at runtime from a URL we control, so they stay unbundled on disk.
const wasmSrc = 'node_modules/@litert-lm/core/wasm';
if (existsSync(wasmSrc)) {
  rmSync('wasm', { recursive: true, force: true });
  cpSync(wasmSrc, 'wasm', { recursive: true });
  console.log('Copied LiteRT-LM wasm runtime -> ./wasm');
} else {
  console.warn('WARNING: @litert-lm/core wasm/ folder not found — run npm install first.');
}

console.log('Build done.');
