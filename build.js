import { build } from 'esbuild';
import { cpSync, existsSync, rmSync } from 'node:fs';

// Stamped into the bundle so the console can say which build Obsidian is
// actually running. Obsidian caches main.js until the plugin is toggled off
// and on, so "I rebuilt it" and "the app is running it" are different facts.
const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

await build({
  define: { BUILD_STAMP: JSON.stringify(stamp) },
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

console.log(`Build done — stamp ${stamp}`);
