import { App, Notice, PluginSettingTab, Setting, TFolder } from 'obsidian';
import type LiteRtSpikePlugin from './main';
import { DEFAULT_WIKI_DIR } from './wiki-store';

export interface GemmaWikiSettings {
  wikiDir: string;
}

export const DEFAULT_SETTINGS: GemmaWikiSettings = {
  wikiDir: DEFAULT_WIKI_DIR,
};

export class GemmaWikiSettingTab extends PluginSettingTab {
  private plugin: LiteRtSpikePlugin;

  constructor(app: App, plugin: LiteRtSpikePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName('Wiki').setHeading();

    let pending = this.plugin.settings.wikiDir;
    new Setting(containerEl)
      .setName('Knowledge folder name')
      .setDesc(
        'Folder the plugin creates and maintains (sources, answers, chats, index, log). ' +
          'Changing it renames the existing folder and rewrites internal links. Leave blank to reset to the default.'
      )
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_WIKI_DIR)
          .setValue(this.plugin.settings.wikiDir)
          .onChange((v) => {
            pending = v;
          })
      )
      .addButton((btn) =>
        btn
          .setButtonText('Apply')
          .setCta()
          .onClick(async () => {
            const next = (pending || DEFAULT_WIKI_DIR).trim().replace(/^\/+|\/+$/g, '');
            const prev = this.plugin.settings.wikiDir;
            if (!next || next === prev) {
              new Notice('No change.');
              return;
            }
            // Guard against colliding with an unrelated existing folder that
            // isn't ours (has no index we'd recognize) — but allow it if it
            // doesn't exist yet.
            const existing = this.app.vault.getAbstractFileByPath(next);
            if (existing && !(existing instanceof TFolder)) {
              new Notice(`"${next}" already exists and is not a folder.`);
              return;
            }
            await this.plugin.renameWikiDir(prev, next);
            this.display();
          })
      );
  }
}
