import { App, Notice, PluginSettingTab, Setting, TFolder } from 'obsidian';
import type LiteRtSpikePlugin from './main';
import { DEFAULT_WIKI_DIR } from './wiki-store';

export interface GemmaWikiSettings {
  wikiDir: string;
  staleDays: number;
  defaultMode: 'note' | 'wiki';
}

export const DEFAULT_SETTINGS: GemmaWikiSettings = {
  wikiDir: DEFAULT_WIKI_DIR,
  staleDays: 30,
  defaultMode: 'note',
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
    containerEl.addClass('gemma4-settings');

    // ---------- Model ----------
    new Setting(containerEl).setName('Model').setHeading();

    const status = this.plugin.modelStatus();
    const modelSetting = new Setting(containerEl)
      .setName('Local model')
      .setDesc(
        status.downloaded
          ? `Downloaded (${status.sizeGB} GB on disk). Completely free — runs offline on your GPU, no API key or subscription.`
          : status.partialGB
            ? `Partial download on disk (${status.partialGB} GB). Resume to finish.`
            : 'Not downloaded yet (~2.97 GB, one time). Downloads on first use, or start it here.'
      );
    modelSetting.addButton((btn) => {
      btn.setButtonText(status.downloaded ? 'Re-download' : status.partialGB ? 'Resume download' : 'Download model');
      btn.onClick(() => void this.plugin.downloadModelFromSettings());
    });

    // ---------- Wiki ----------
    new Setting(containerEl).setName('Wiki').setHeading();

    let pendingDir = this.plugin.settings.wikiDir;
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
            pendingDir = v;
          })
      )
      .addButton((btn) =>
        btn.setButtonText('Apply').onClick(async () => {
          const next = (pendingDir || DEFAULT_WIKI_DIR).trim().replace(/^\/+|\/+$/g, '');
          const prev = this.plugin.settings.wikiDir;
          if (!next || next === prev) {
            new Notice('No change.');
            return;
          }
          const existing = this.app.vault.getAbstractFileByPath(next);
          if (existing && !(existing instanceof TFolder)) {
            new Notice(`"${next}" already exists and is not a folder.`);
            return;
          }
          await this.plugin.renameWikiDir(prev, next);
          this.display();
        })
      );

    // ---------- Chat ----------
    new Setting(containerEl).setName('Chat').setHeading();

    new Setting(containerEl)
      .setName('Default mode')
      .setDesc('Which grounding mode a new chat panel opens in.')
      .addDropdown((dd) =>
        dd
          .addOption('note', 'This note')
          .addOption('wiki', 'Wiki')
          .setValue(this.plugin.settings.defaultMode)
          .onChange(async (v) => {
            this.plugin.settings.defaultMode = v === 'wiki' ? 'wiki' : 'note';
            await this.plugin.saveSettings();
          })
      );

    // ---------- Review ----------
    new Setting(containerEl).setName('Review').setHeading();

    new Setting(containerEl)
      .setName('Stale after (days)')
      .setDesc('The review board flags pages untouched for this many days.')
      .addSlider((sl) =>
        sl
          .setLimits(7, 120, 1)
          .setValue(this.plugin.settings.staleDays)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.staleDays = v;
            await this.plugin.saveSettings();
          })
      );
  }
}
