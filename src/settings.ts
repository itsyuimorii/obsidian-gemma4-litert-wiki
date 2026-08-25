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
  // Custom skills (issue #4): one per line, "Label :: prompt", appended to
  // the built-in skills menu.
  customSkills: string;
  // Background scan (issue #2): periodically COUNT new/changed notes and
  // show a status-bar chip. Counting is deterministic (no model / no GPU);
  // drafting only runs when the user clicks the chip. Default OFF.
  autoScanEnabled: boolean;
  autoScanIntervalHours: number;
}

export const DEFAULT_SETTINGS: GemmaWikiSettings = {
  wikiDir: DEFAULT_WIKI_DIR,
  staleDays: 30,
  defaultMode: 'note',
  scanQuietHours: 3,
  scanMaxPerRun: 10,
  scanExclude: '',
  customSkills: '',
  autoScanEnabled: false,
  autoScanIntervalHours: 6,
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
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        'The tag vocabulary and naming rules live in the wiki\'s schema.md ("config as a note"), ' +
        'not here — open it to read or edit the rules. Run the command "Suggest tag vocabulary" to ' +
        'generate it from the tags already on your wiki; the model proposes it, you review before it is written.',
    });

    // ---------- Skills ----------
    new Setting(containerEl).setName('Skills').setHeading();

    new Setting(containerEl)
      .setName('Custom skills')
      .setClass('gemma4-textarea-setting')
      .setDesc(
        'Your own one-shot prompts, added to the ⚡ skills menu. One per line, "Label :: prompt". ' +
          'Each runs against the current chat context (mode + attachments), same as the built-in skills.'
      )
      .addTextArea((ta) => {
        ta.setPlaceholder('ELI5 :: Explain this material like I am five.\nAction items :: List concrete next actions from this material.')
          .setValue(this.plugin.settings.customSkills)
          .onChange(async (v) => {
            this.plugin.settings.customSkills = v;
            await this.plugin.saveSettings();
          });
        ta.inputEl.rows = 4;
      });

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

    // Manual-scan knobs — always visible.
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

    // Background auto-scan — its tuning knobs (quiet period, refresh interval)
    // only appear when the toggle is on, so a user who only ever clicks
    // "Scan now" is not confronted with background-mode concepts (issue #42).
    new Setting(containerEl)
      .setName('Show a background "to review" count')
      .setDesc(
        'Periodically COUNT new/changed notes and show them in the status bar. ' +
          'Counting is instant and never runs the model — drafting only happens when you click the chip. Default off.'
      )
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.autoScanEnabled).onChange(async (v) => {
          this.plugin.settings.autoScanEnabled = v;
          await this.plugin.saveSettings();
          this.plugin.rescheduleAutoScan();
          // Re-render to reveal/hide the background-only knobs below —
          // preserving the scroll position, since display() rebuilds the pane
          // and would otherwise snap the view back to the top.
          const scrollTop = this.containerEl.scrollTop;
          this.display();
          this.containerEl.scrollTop = scrollTop;
        })
      );

    if (this.plugin.settings.autoScanEnabled) {
      new Setting(containerEl)
        .setName('Quiet period (hours)')
        .setDesc(
          'Background auto-scan skips notes edited within this many hours — you may still be ' +
            'writing them. Manual "Scan now" always includes them.'
        )
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
        .setName('Re-count every (hours)')
        .setDesc('How often the background count refreshes while Obsidian is open.')
        .addSlider((sl) =>
          sl
            .setLimits(1, 24, 1)
            .setValue(this.plugin.settings.autoScanIntervalHours)
            .setDynamicTooltip()
            .onChange(async (v) => {
              this.plugin.settings.autoScanIntervalHours = v;
              await this.plugin.saveSettings();
              this.plugin.rescheduleAutoScan();
            })
        );
    }
  }
}
