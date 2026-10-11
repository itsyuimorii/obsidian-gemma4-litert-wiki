// A vault that lives in a Map, behind the handful of calls the model-free
// checks make: list the markdown files, read one, look one up by path, and
// ask for its frontmatter. Loading this file also teaches Node where
// 'obsidian' is and that the plugin's own imports end in .ts.

import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'obsidian') {
      return { url: new URL('./obsidian-stub.ts', import.meta.url).href, shortCircuit: true };
    }
    // src/ imports its neighbours the way a bundler reads them: './pure'.
    if (/^\.\.?\//.test(specifier) && !/\.[a-z]+$/.test(specifier) && context.parentURL?.includes('/src/')) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { TFile } = await import('./obsidian-stub.ts');

type Frontmatter = Record<string, unknown>;

/** The subset of YAML the plugin writes: scalars, and lists of scalars. */
export function parseFrontmatter(content: string): Frontmatter | undefined {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return undefined;
  const fm: Frontmatter = {};
  let list: unknown[] | null = null;
  const scalar = (raw: string): unknown => {
    const v = raw.trim().replace(/^"(.*)"$/, '$1');
    if (v === 'true') return true;
    if (v === 'false') return false;
    return v;
  };
  for (const line of m[1].split('\n')) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && list) {
      list.push(scalar(item[1]));
      continue;
    }
    const pair = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!pair) continue;
    if (pair[2] === '') {
      list = [];
      fm[pair[1]] = list;
    } else {
      list = null;
      fm[pair[1]] = scalar(pair[2]);
    }
  }
  return fm;
}

export interface FakeVault {
  /** Pass this wherever the plugin takes an App. */
  app: unknown;
  set(path: string, content: string): void;
  remove(path: string): void;
}

export function fakeVault(initial: Record<string, string> = {}): FakeVault {
  const contents = new Map<string, string>();
  const files = new Map<string, InstanceType<typeof TFile>>();

  const set = (path: string, content: string) => {
    contents.set(path, content);
    if (!files.has(path)) {
      const f = new TFile();
      f.path = path;
      f.name = path.split('/').pop() ?? path;
      f.basename = f.name.replace(/\.md$/, '');
      files.set(path, f);
    }
  };
  const remove = (path: string) => {
    contents.delete(path);
    files.delete(path);
  };
  for (const [path, content] of Object.entries(initial)) set(path, content);

  const read = (file: { path: string }) => Promise.resolve(contents.get(file.path) ?? '');
  const app = {
    vault: {
      getMarkdownFiles: () => [...files.values()].filter((f) => f.path.endsWith('.md')),
      getAbstractFileByPath: (path: string) => files.get(path) ?? null,
      read,
      cachedRead: read,
    },
    metadataCache: {
      getFileCache: (file: { path: string }) => {
        const content = contents.get(file.path);
        return content === undefined ? null : { frontmatter: parseFrontmatter(content) };
      },
      resolvedLinks: {} as Record<string, Record<string, number>>,
    },
  };
  return { app, set, remove };
}
