import { App, ButtonComponent, EventRef, PluginSettingTab, Setting, TFolder } from 'obsidian';
import { ConfirmModal } from './ingest-modal';
import type LiteRtSpikePlugin from './main';
import { DEFAULT_WIKI_DIR, wikiScaffoldPaths, type ChatTurnRecord } from './wiki-store';
import { DURATION, notify } from './notify';

export interface GemmaWikiSettings {
  wikiDir: string;
  // Engine context window (maxNumTokens). Bigger = longer notes fit and more
  // grounding per answer, at the cost of GPU memory and first-token latency.
  // Applied at engine creation, so changes need a plugin reload.
  contextTokens: number;
  // Show the four [Test] diagnostic commands in the palette. Off by default:
  // they are debugging tools, not things to do with your notes.
  devCommands: boolean;
  staleDays: number;
  defaultMode: 'note' | 'wiki';
  /**
   * The last chat thread, so closing the panel does not discard it (#100).
   *
   * One thread, not a history: this exists so an accidental close, a restart,
   * or a plugin update does not cost you an exchange that took half a minute
   * of GPU time to produce. A list of past threads is a different feature,
   * with its own UI and its own delete semantics.
   *
   * Plugin data, deliberately — not a file in the vault. #96 spent its whole
   * diff moving chat transcripts OUT of the vault, and this is view state, not
   * material: nothing retrieves it, and it is not markdown anyone has to look
   * at. Capped on write so data.json cannot grow without anyone noticing.
   */
  lastThread?: ChatTurnRecord[];
  // Semi-auto ingest scan (manual trigger; no background timer yet).
  scanQuietHours: number;
  // The folders you last scanned. Written by the scan dialog, not by hand —
  // it remembers your pick so the next dialog opens where you left off, and
  // the background count uses the same scope. Blank until your first scan.
  scanInclude: string;
  scanExclude: string; // comma-separated path prefixes to skip (within the allow-list)
  // Where "Save as note" writes. Blank means beside the note the answer came
  // from, which is the answer a person gives when asked where it should live.
  // A folder here overrides that, for anyone who would rather have one pile
  // they chose than several they did not.
  answerFolder: string;
  // Whether the one-time "answers/ and chats/ are retired" notice has been
  // shown. A flag rather than a check, because the folders can legitimately
  // still hold files for as long as the user wants them to.
  retiredFoldersNoticed: boolean;
  // Background scan (issue #2): periodically COUNT new/changed notes and
  // show a status-bar chip. Counting is deterministic (no model / no GPU);
  // drafting only runs when the user clicks the chip. Default OFF.
  autoScanEnabled: boolean;
  autoScanIntervalHours: number;
  // Whether a message has ever been sent in this vault. Drives the one-line
  // nudge in the empty panel; a chat plugin that keeps telling you how to chat
  // after you already have is just noise.
  hasChatted: boolean;
}

export const DEFAULT_SETTINGS: GemmaWikiSettings = {
  wikiDir: DEFAULT_WIKI_DIR,
  contextTokens: 64000,
  devCommands: false,
  staleDays: 30,
  defaultMode: 'note',
  scanQuietHours: 3,
  scanInclude: '',
  scanExclude: '',
  answerFolder: '',
  retiredFoldersNoticed: false,
  autoScanEnabled: false,
  autoScanIntervalHours: 6,
  hasChatted: false,
};

export class GemmaWikiSettingTab extends PluginSettingTab {
  private plugin: LiteRtSpikePlugin;

  constructor(app: App, plugin: LiteRtSpikePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // Vault listeners for the folder-state table, torn down with the pane.
  private watchers: EventRef[] = [];

  // A detached table is not worth redrawing, so the vault listeners go.
  hide(): void {
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
            notify('done', 'Context window saved — reload the plugin (toggle it off/on) to apply.', DURATION.NORMAL);
          })
      );

    new Setting(containerEl)
      .setName('Developer commands')
      .setDesc(
        'Adds four [Test] commands to the palette: check WebGPU, load the WASM runtime without ' +
          'the model, fix grammar of a selection with timings, and a JSON-reliability run. They ' +
          'are for diagnosing a broken setup, not for working with notes. Off by default.'
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.devCommands).onChange(async (v) => {
          this.plugin.settings.devCommands = v;
          await this.plugin.saveSettings();
          notify('info', 'Reload the plugin (toggle it off and on) for this to take effect.');
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
            notify('warn', `"${next}" already exists and is not a folder.`);
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
    // This section configures scanning; it no longer performs it. The one
    // action button used to live here, which made Settings the only place a
    // user could find the feature at all — and it had to be here, because it
    // was also the only place to say which folder. The scan dialog asks that
    // now, so the button had nothing left that this pane was uniquely good
    // for. Settings configures; the command palette and the chat panel act.
    // A heading is a heading. The guidance sits in a row of its own so it gets
    // the same card as everything else on this page — hung off the heading it
    // rendered as bare text floating outside the cards, which read as a stray
    // paragraph rather than part of the section.
    new Setting(containerEl).setName('Scan for new notes').setHeading();

    new Setting(containerEl)
      .setName('How to run a scan')
      .setDesc(
        'Cmd/Ctrl+P → "Scan a folder into the wiki", or the button in the chat panel when your ' +
          'wiki is empty. It asks which folders, shows how many notes each one holds, and ' +
          'remembers your last pick. "Stop the running scan" cancels — whatever was drafted ' +
          'before you stopped is still offered for review.'
      );

    new Setting(containerEl)
      .setName('Save answers into')
      .setDesc(
        'Where the save button under an answer writes. Leave blank and it goes beside the note ' +
          'the answer came from — in Wiki mode, the note behind its first source. Name a folder ' +
          'here to put every saved answer in one place instead. Either way it is an ordinary ' +
          'note of yours, so the next scan can turn it into a wiki card like any other.'
      )
      .addText((text) =>
        text
          .setPlaceholder('beside the note it came from')
          .setValue(this.plugin.settings.answerFolder)
          .onChange(async (v) => {
            this.plugin.settings.answerFolder = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Never scan these')
      .setDesc(
        'Folders that are not notes — templates, attachments, an archive. Skipped by every scan ' +
          'and by the background count, whatever you tick in the dialog (comma-separated). The ' +
          'wiki folder is always excluded.'
      )
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
