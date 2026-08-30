import { App, ButtonComponent, EventRef, Notice, PluginSettingTab, Setting, TFolder } from 'obsidian';
import { ConfirmModal } from './ingest-modal';
import type LiteRtSpikePlugin from './main';
import { DEFAULT_WIKI_DIR, wikiScaffoldPaths } from './wiki-store';

export interface GemmaWikiSettings {
  wikiDir: string;
  // Engine context window (maxNumTokens). Bigger = longer notes fit and more
  // grounding per answer, at the cost of GPU memory and first-token latency.
  // Applied at engine creation, so changes need a plugin reload.
  contextTokens: number;
  staleDays: number;
  defaultMode: 'note' | 'wiki';
  // Semi-auto ingest scan (manual trigger; no background timer yet).
  scanQuietHours: number;
  scanMaxPerRun: number;
  // Allow-list: "Scan now" only looks at notes under these folders (comma-
  // separated path prefixes). Blank = nothing to scan (opt-in by design), so
  // scan never sweeps the whole vault. Cmd+P ingest still works on any note.
  scanInclude: string;
  scanExclude: string; // comma-separated path prefixes to skip (within the allow-list)
  // Background scan (issue #2): periodically COUNT new/changed notes and
  // show a status-bar chip. Counting is deterministic (no model / no GPU);
  // drafting only runs when the user clicks the chip. Default OFF.
  autoScanEnabled: boolean;
  autoScanIntervalHours: number;
  // Whether the one-time "here is the folder that was just created" card has
  // been shown. Not a consent flag — the folder is made either way; this only
  // stops the explanation reappearing every launch.
  scaffoldNoticeShown: boolean;
}

export const DEFAULT_SETTINGS: GemmaWikiSettings = {
  wikiDir: DEFAULT_WIKI_DIR,
  contextTokens: 64000,
  staleDays: 30,
  defaultMode: 'note',
  scanQuietHours: 3,
  scanMaxPerRun: 10,
  scanInclude: '',
  scanExclude: '',
  autoScanEnabled: false,
  autoScanIntervalHours: 6,
  scaffoldNoticeShown: false,
};

export class GemmaWikiSettingTab extends PluginSettingTab {
  private plugin: LiteRtSpikePlugin;

  constructor(app: App, plugin: LiteRtSpikePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // Vault listeners for the folder-state table, torn down with the pane.
  private watchers: EventRef[] = [];

  // Closing the pane drops the button this callback writes to; leaving it
  // registered would have a finishing scan poke a detached element. Same for
  // the vault listeners below — a detached table is not worth redrawing.
  hide(): void {
    this.plugin.onScanStateChange = null;
    for (const ref of this.watchers) this.app.vault.offref(ref);
    this.watchers = [];
  }

  // The folder table is computed when the pane renders, so deleting a folder
  // with Settings open left it showing eight ticks for something that was no
  // longer there. Re-render, but only when the path that changed is one the
  // table actually shows — a scan writing twenty pages should not redraw the
  // pane twenty times.
  private watchScaffold(): void {
    const owned = new Set(wikiScaffoldPaths().map((e) => e.path.replace(/\/$/, '')));
    const touched = (path: string) => owned.has(path) || path === this.plugin.settings.wikiDir;
    const rerender = (file: { path: string }) => {
      if (!touched(file.path)) return;
      const scrollTop = this.containerEl.scrollTop;
      this.display();
      this.containerEl.scrollTop = scrollTop;
    };
    // Registered one by one: vault.on is overloaded per event name, so a union
    // in a loop does not narrow.
    this.watchers.push(this.app.vault.on('create', rerender));
    this.watchers.push(this.app.vault.on('delete', rerender));
    this.watchers.push(
      this.app.vault.on('rename', (file, oldPath) => {
        if (touched(file.path) || touched(oldPath)) rerender(file);
      })
    );
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('gemma4-settings');
    for (const ref of this.watchers) this.app.vault.offref(ref);
    this.watchers = [];
    this.watchScaffold();

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

    new Setting(containerEl)
      .setName('Context window (tokens)')
      .setDesc(
        'How much the model can hold at once — longer notes fit whole, and answers can ground on ' +
          'more material. Costs GPU memory and first-token latency. Takes effect after the plugin ' +
          'reloads. If the model fails to load or answers degrade after raising this, set it lower.'
      )
      .addDropdown((dd) =>
        dd
          .addOption('4096', '4,096 (small / safest)')
          .addOption('8192', '8,192')
          .addOption('16384', '16,384')
          .addOption('32768', '32,768')
          .addOption('64000', '64,000 (max)')
          .setValue(String(this.plugin.settings.contextTokens))
          .onChange(async (v) => {
            this.plugin.settings.contextTokens = parseInt(v, 10) || 64000;
            await this.plugin.saveSettings();
            new Notice('✅ Context window saved — reload the plugin (toggle it off/on) to apply.', 6000);
          })
      );

    // ---------- Wiki ----------
    new Setting(containerEl).setName('Wiki').setHeading();

    // Renaming the knowledge folder moves every page and rewrites every
    // internal link, so Apply stays disabled until the field actually differs
    // from what is saved. It used to be permanently clickable and answered
    // "No change." — one useless notice per press, stacking if you pressed twice.
    let pendingDir = this.plugin.settings.wikiDir;
    let applyBtn: ButtonComponent | null = null;
    const normalizeDir = (v: string) => (v || DEFAULT_WIKI_DIR).trim().replace(/^\/+|\/+$/g, '');
    const syncApply = () => {
      const next = normalizeDir(pendingDir);
      applyBtn?.setDisabled(!next || next === this.plugin.settings.wikiDir);
    };

    new Setting(containerEl)
      .setName('Knowledge folder name')
      .setDesc(
        'The one folder the plugin writes to. Your own notes are never moved or modified. ' +
          'Changing this renames the folder and rewrites internal links; blank resets to the default.'
      )
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_WIKI_DIR)
          .setValue(this.plugin.settings.wikiDir)
          .onChange((v) => {
            pendingDir = v;
            syncApply();
          })
      )
      .addButton((btn) => {
        applyBtn = btn;
        btn.setButtonText('Apply').onClick(async () => {
          const next = normalizeDir(pendingDir);
          const prev = this.plugin.settings.wikiDir;
          if (!next || next === prev) return;
          const existing = this.app.vault.getAbstractFileByPath(next);
          if (existing && !(existing instanceof TFolder)) {
            new Notice(`⚠️ "${next}" already exists and is not a folder.`);
            return;
          }
          // A typo here does not fail — it silently starts a second, empty
          // knowledge base under the misspelled name and leaves the real one
          // orphaned. Moving a whole wiki deserves the confirmation that
          // creating an empty folder never did.
          const pageCount = this.app.vault
            .getMarkdownFiles()
            .filter((f) => f.path.startsWith(`${prev}/`)).length;
          const ok = await new Promise<boolean>((resolve) => {
            new ConfirmModal(this.app, {
              title: 'Rename the knowledge folder',
              body:
                `${prev}  →  ${next}\n\n` +
                (pageCount
                  ? `${pageCount} file${pageCount === 1 ? '' : 's'} will move, and links pointing into ` +
                    `"${prev}/" will be rewritten.`
                  : `"${prev}/" is empty or missing, so nothing moves — the folders will simply be ` +
                    `created under "${next}/".`) +
                '\n\nCheck the spelling: a name you did not mean leaves your existing wiki behind.',
              confirmText: 'Rename',
              onResult: resolve,
            }).open();
          });
          if (!ok) return;
          await this.plugin.renameWikiDir(prev, next);
          this.display();
        });
        syncApply();
      });

    // What the plugin actually put in the vault. The settings page used to
    // describe the layout in prose in three different places and got it wrong
    // (concepts/, skills/ and schema.md were missing from the list) — this is
    // generated from the same list the scaffold builds from, so it cannot drift.
    const map = containerEl.createDiv({ cls: 'gemma4-folder-map' });
    let missing = 0;
    for (const entry of wikiScaffoldPaths()) {
      // Trailing slash is for display; the vault index is keyed without it.
      const here = !!this.app.vault.getAbstractFileByPath(entry.path.replace(/\/$/, ''));
      if (!here) missing++;
      const row = map.createDiv({ cls: here ? 'gemma4-folder-row' : 'gemma4-folder-row is-missing' });
      // The three files are openable from here, which is what the separate
      // "Open schema.md" button used to be for. Folders are not: Obsidian has
      // no clean reveal-a-folder API, so skills/ keeps its own button.
      const isFile = here && entry.path.endsWith('.md');
      const pathEl = row.createSpan({
        cls: isFile ? 'gemma4-folder-path is-link' : 'gemma4-folder-path',
        text: entry.path,
      });
      if (isFile) {
        pathEl.addEventListener('click', () => {
          (this.app as unknown as { setting?: { close?: () => void } }).setting?.close?.();
          void this.app.workspace.openLinkText(entry.path.replace(/\.md$/, ''), '', false);
        });
      }
      row.createSpan({ cls: 'gemma4-folder-what', text: entry.what });
      row.createSpan({ cls: 'gemma4-folder-state', text: here ? '✓' : 'missing' });
    }

    // Showing the state turns "Repair folders" from a button whose purpose is
    // a mystery (the folders are made on startup, so why is it here?) into the
    // action for a condition you can actually see. Sync clients drop empty
    // directories often enough that the recovery path has to exist.
    new Setting(containerEl)
      .setName('Folders')
      .setDesc(
        missing
          ? `${missing} of ${wikiScaffoldPaths().length} missing — they are normally created when Obsidian starts.`
          : 'All present. These are created when Obsidian starts; this button is only for putting one back.'
      )
      .addButton((btn) => {
        // Deliberately not a CTA. The red rows already carry the signal, and a
        // filled accent button for a recovery action reads as the main thing
        // to do on the page, which it never is.
        btn.setButtonText(missing ? `Create ${missing} missing` : 'Repair folders');
        btn.onClick(async () => {
          await this.plugin.repairWikiFolders();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName('What this plugin created')
      .setDesc(
        'The card shown the first time the folder was made — what each folder is for, and where ' +
          'the chat panel lives. Shown once on purpose; this is how to see it again.'
      )
      .addButton((btn) =>
        btn.setButtonText('Show setup card').onClick(() => this.plugin.showSetupCard())
      );

    // ---------- Schema ----------
    new Setting(containerEl).setName('Schema').setHeading();
    new Setting(containerEl)
      .setName('Tag vocabulary & naming rules')
      .setClass('gemma4-stack-buttons')
      .setDesc(
        'Tag rules live in schema.md, not here — config as a note; open it from the list above. ' +
          '"Organize tags" has local Gemma merge near-synonyms into one vocabulary and writes it back ' +
          'for you to review. The first run is slow while the model loads.'
      )
      .addButton((btn) =>
        btn.setButtonText('Organize tags').onClick(() => void this.plugin.suggestTagVocabulary())
      );

    // ---------- Skills ----------
    new Setting(containerEl).setName('Skills').setHeading();
    new Setting(containerEl)
      .setName('Custom skills')
      .setDesc(
        'One file per skill in skills/ — frontmatter for name/icon/mode, the body is the prompt. ' +
          'Each file becomes an entry in the ⚡ menu of the chat panel. The folder ships with a README ' +
          'and two examples.'
      )
      .addButton((btn) => btn.setButtonText('Open skills folder').onClick(() => void this.plugin.createSkillsFolder()));

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
    new Setting(containerEl)
      .setName('Scan now')
      .setDesc(
        'Sweep the folders below for new or changed notes, draft a card for each, and review them ' +
          'all at once before anything is written — drafts are never saved without your tick. ' +
          'A scan is one model call per note, so it takes a while: you can close this window and ' +
          'keep working, and the review dialog opens when it finishes. ' +
          'To ingest one specific note instead, use the command palette: "Ingest active note into wiki".'
      )
      .addButton((btn) => {
        // The button doubles as the stop control. Its label follows the
        // plugin's real scan state via onScanStateChange — setting it once at
        // click time went stale whenever this pane re-rendered, so a running
        // scan could still read "Scan now".
        const sync = () => btn.setButtonText(this.plugin.isScanning() ? 'Stop scan' : 'Scan now');
        sync();
        this.plugin.onScanStateChange = sync;
        btn.onClick(() => {
          if (this.plugin.isScanning()) {
            this.plugin.cancelScan();
            return;
          }
          void this.plugin.scanAndReviewIngest();
        });
      });

    new Setting(containerEl)
      .setName('Scan these folders')
      .setDesc(
        'Scan only looks at notes under these folders (comma-separated, e.g. "走り書き, research"). ' +
          'Everything else in your vault is left alone. Leave blank and scan has nothing to do — this ' +
          'is opt-in on purpose, so scanning never pulls in notes you did not mean to file.'
      )
      .addText((text) =>
        text
          .setPlaceholder('走り書き, research')
          .setValue(this.plugin.settings.scanInclude)
          .onChange(async (v) => {
            this.plugin.settings.scanInclude = v;
            await this.plugin.saveSettings();
          })
      );

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
      .setDesc('Optional: within the scanned folders above, skip these sub-paths (comma-separated, e.g. a drafts subfolder). The wiki folder is always excluded.')
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
