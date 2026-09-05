import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

// Stamped into the bundle so the console can say which build Obsidian is
// actually running. Obsidian caches main.js until the plugin is toggled off
// and on, so "I rebuilt it" and "the app is running it" are different facts.
//
// Deterministic by default, so that `npm run build` on this commit produces
// the byte-identical main.js that the release carries. The store's automated
// review rebuilds from source and diffs against the released asset; a
// wall-clock default failed that check for a reason that had nothing to do
// with the code — the timestamp differed, so the bundle differed.
//
// The stamp still answers the question it exists for. Obsidian caches main.js
// until the plugin is toggled off and on, so "I rebuilt it" and "the app is
// running it" are different facts; the version plus the working-tree state is
// enough to tell them apart, and unlike a clock it is the same for everyone
// who builds this commit. BUILD_STAMP overrides it for a CI build that wants
// to record the exact SHA.
const version = JSON.parse(readFileSync('manifest.json', 'utf8')).version;
const stamp = process.env.BUILD_STAMP?.trim() || version;

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
  // The vendor's WASM loader creates a <script> element to load the Emscripten
  // glue. Obsidian's automated review reports that as dynamic script injection
  // and an Error there blocks installation — and because the check is static,
  // it fires on the string being in the bundle, not on the branch running. Our
  // replacement requires the file off disk instead, so the string is never
  // compiled in. See src/wasm-loader.ts.
  alias: { '@litertjs/wasm-utils': './src/wasm-loader.ts' },
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
