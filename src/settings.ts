import { App, Notice, PluginSettingTab, Setting, TFolder } from 'obsidian';
import type LiteRtSpikePlugin from './main';
import { DEFAULT_WIKI_DIR } from './wiki-store';

export interface GemmaWikiSettings {
  wikiDir: string;
  staleDays: number;
  defaultMode: 'note' | 'wiki';
  // Semi-auto ingest scan (manual trigger; no background timer yet).
  scanQuietHours: number;
  scanMaxPerRun: number;
  scanExclude: string; // comma-separated path prefixes to skip
}

export const DEFAULT_SETTINGS: GemmaWikiSettings = {
  wikiDir: DEFAULT_WIKI_DIR,
  staleDays: 30,
  defaultMode: 'note',
  scanQuietHours: 3,
  scanMaxPerRun: 10,
  scanExclude: '',
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

    // ---------- Schema ----------
    new Setting(containerEl).setName('Schema').setHeading();
    new Setting(containerEl)
      .setName('Tag vocabulary & naming rules')
      .setClass('gemma4-stack-buttons')
      .setDesc(
        'Tag rules live in the wiki\'s schema.md ("config as a note"), not here. "Open schema.md" ' +
          'opens that file (creating it first if it doesn\'t exist yet) so you can read or edit the ' +
          'rules directly. "Clean up tags" has local Gemma read the tags already on your wiki, merge ' +
          'near-synonyms into one clean list, and write it back for you to review first — it can take ' +
          'a while on the first run while the local model loads, watch the notice in the corner for progress.'
      )
      .addButton((btn) => btn.setButtonText('Open schema.md').onClick(() => void this.plugin.openSchemaFile()))
      .addButton((btn) =>
        btn.setButtonText('Clean up tags').onClick(() => void this.plugin.suggestTagVocabulary())
      );

    // ---------- Skills ----------
    new Setting(containerEl).setName('Skills').setHeading();
    new Setting(containerEl)
      .setName('Custom skills')
      .setDesc(
        'Your one-shot prompts live as files in the wiki\'s skills/ folder ("config as a note"), ' +
          'one file per skill — frontmatter for name/icon/mode, the body is the prompt. Each appears ' +
          'in the ⚡ menu of the chat panel. Create the folder with a README and two examples, then ' +
          'add or edit files there.'
      )
      .addButton((btn) => btn.setButtonText('Create skills folder').onClick(() => void this.plugin.createSkillsFolder()));

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

    // ---------- Scan ----------
    new Setting(containerEl).setName('Scan for new notes').setHeading();
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        'Run the "Scan notes for wiki" command to find new or changed notes, draft a card for each, ' +
        'and review them all at once before anything is written. Drafts are never saved without your tick.',
    });

    new Setting(containerEl)
      .setName('Quiet period (hours)')
      .setDesc('Skip notes edited within this many hours — you are probably still working on them.')
      .addSlider((sl) =>
        sl
          .setLimits(0, 24, 1)
          .setValue(this.plugin.settings.scanQuietHours)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.scanQuietHours = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Max notes per scan')
      .setDesc('Cap each scan so a large backlog does not run the GPU through dozens of notes at once.')
      .addSlider((sl) =>
        sl
          .setLimits(1, 30, 1)
          .setValue(this.plugin.settings.scanMaxPerRun)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.scanMaxPerRun = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Exclude folders')
      .setDesc('Comma-separated path prefixes to skip when scanning (e.g. templates, attachments). The wiki folder is always excluded.')
      .addText((text) =>
        text
          .setPlaceholder('Templates, 10_リソース')
          .setValue(this.plugin.settings.scanExclude)
          .onChange(async (v) => {
            this.plugin.settings.scanExclude = v;
            await this.plugin.saveSettings();
          })
      );
  }
}
