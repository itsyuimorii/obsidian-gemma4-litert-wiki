// What the plugin's modules need from 'obsidian' in order to load under
// node:test. The real package ships types only — its "main" is empty — so
// outside the app there is nothing to import. These are the names, with just
// enough behind them for `instanceof` and `extends` to mean something.

export class TAbstractFile {
  path = '';
  name = '';
}

export class TFile extends TAbstractFile {
  basename = '';
  extension = 'md';
  stat = { mtime: 0, ctime: 0, size: 0 };
}

export class TFolder extends TAbstractFile {}

export class Vault {}
export class App {}

export class Modal {
  app: unknown;
  contentEl = {};
  constructor(app: unknown) {
    this.app = app;
  }
  open(): void {}
  close(): void {}
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}
