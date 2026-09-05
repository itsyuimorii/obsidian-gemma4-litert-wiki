/**
 * A replacement for `@litertjs/wasm-utils`, substituted at build time.
 *
 * The vendor module loads the Emscripten glue by creating a `<script>` element
 * and appending it to the document. Obsidian's automated review reports that
 * as "dynamic <script> element creation", and an Error there blocks the plugin
 * from being installable at all — the finding is static, so it fires on the
 * string being present in main.js, whether or not the branch is ever reached.
 *
 * The glue does not need a script tag. It is a UMD bundle whose tail reads
 *
 *   if (typeof exports === 'object' && typeof module === 'object')
 *     module.exports = ModuleFactory;
 *
 * so on a Node-integrated Electron renderer — which is where this plugin runs,
 * and the same reason it can use `fs` and `http` at all — `require()` of the
 * file on disk hands back the factory directly. That is strictly more
 * auditable than a script tag: a pinned local path, read from the plugin's own
 * folder, with no URL and no injection into the page.
 *
 * Everything else here is the vendor's logic, kept as it was.
 */

/** Maps the URL the library asks for onto the file already on disk. */
let resolveToDisk: ((url: string) => string) | null = null;

export function setWasmScriptResolver(fn: (url: string) => string): void {
  resolveToDisk = fn;
}

interface FileLocator {
  locateFile?: (path: string) => string;
  mainScriptUrlOrBlob?: string;
}

type Host = {
  ModuleFactory?: (locator?: unknown) => Promise<unknown>;
  Module?: FileLocator;
};

/**
 * Load the glue and hand back its factory.
 *
 * `require` is read off `window` rather than imported: the path is only known
 * at runtime, so an import would send esbuild looking for a file that does not
 * exist at build time.
 */
function loadGlue(url: string): unknown {
  if (!resolveToDisk) {
    throw new Error(
      'The WASM script resolver was not installed before the runtime was loaded.'
    );
  }
  const diskPath = resolveToDisk(url);
  const req = (window as unknown as { require?: (id: string) => unknown }).require;
  if (typeof req !== 'function') {
    throw new Error('This plugin needs Obsidian on desktop, where require() is available.');
  }
  return req(diskPath);
}

export const createWasmLib = async (
  constructorFcn: new (module: unknown, glCanvas?: unknown) => unknown,
  wasmLoaderScript?: string,
  assetLoaderScript?: string,
  glCanvas?: unknown,
  fileLocator?: FileLocator
): Promise<unknown> => {
  const host = self as unknown as Host;

  if (wasmLoaderScript) {
    const exported = loadGlue(String(wasmLoaderScript));
    // A dev install can put the glue under a package.json that declares
    // `"type": "module"`, in which case Node treats it as ESM, the UMD tail
    // never runs, and require() hands back an empty namespace instead of the
    // factory. Say that, rather than failing later with "ModuleFactory not
    // set", which describes the symptom and not the cause.
    if (typeof exported === 'function') {
      host.ModuleFactory = exported as Host['ModuleFactory'];
    } else if (!host.ModuleFactory) {
      throw new Error(
        'The LiteRT-LM runtime did not export its module factory. This happens when the ' +
          'plugin folder sits under a package.json declaring "type": "module", which makes ' +
          'Node read the runtime as ESM. A normal install has no package.json there.'
      );
    }
  }
  if (!host.ModuleFactory) {
    throw new Error('ModuleFactory not set.');
  }
  if (assetLoaderScript) {
    const exported = loadGlue(String(assetLoaderScript));
    if (typeof exported === 'function') host.ModuleFactory = exported as Host['ModuleFactory'];
    if (!host.ModuleFactory) {
      throw new Error('ModuleFactory not set.');
    }
  }
  if (host.Module && fileLocator) {
    const moduleFileLocator = host.Module;
    moduleFileLocator.locateFile = fileLocator.locateFile;
    if (fileLocator.mainScriptUrlOrBlob) {
      moduleFileLocator.mainScriptUrlOrBlob = fileLocator.mainScriptUrlOrBlob;
    }
  }
  const factory = host.ModuleFactory;
  const module = await factory(host.Module ?? fileLocator);
  host.ModuleFactory = undefined;
  host.Module = undefined;
  return new constructorFcn(module, glCanvas);
};
