import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

// Stamped into the bundle so the console can say which build Obsidian is
// actually running. Obsidian caches main.js until the plugin is toggled off
// and on, so "I rebuilt it" and "the app is running it" are different facts.
const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

// Pin the CDN to exactly the version whose JS glue is bundled into main.js.
// Unversioned jsDelivr paths 404, so this must never be left open-ended.
const litertVersion = JSON.parse(
  readFileSync('node_modules/@litert-lm/core/package.json', 'utf8')
).version;

await build({
  define: {
    BUILD_STAMP: JSON.stringify(stamp),
    __LITERT_VERSION__: JSON.stringify(litertVersion),
  },
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

// The wasm runtime is NOT vendored here any more. Copying all four variants
// (~101 MB) into the plugin folder only ever worked because that folder is a
// symlink to this repo in development; Obsidian's community store installs
// main.js, manifest.json and styles.css and nothing else, so a real install
// had no runtime at all. It is fetched on first use from a pinned CDN and
// cached on disk beside the model — see src/wasm-store.ts.

console.log(`LiteRT-LM runtime pinned to @litert-lm/core@${litertVersion}, fetched on first use.`);
console.log(`Build done — stamp ${stamp}`);
