import { SETTINGS_VERSION } from './pure';
import {
  App,
  ButtonComponent,
  EventRef,
  PluginSettingTab,
  Setting,
  TFolder,
  type SettingDefinitionItem,
} from 'obsidian';
import { ConfirmModal } from './ingest-modal';
import type LiteRtSpikePlugin from './main';
import { DEFAULT_WIKI_DIR, wikiScaffoldPaths, type ChatTurnRecord } from './wiki-store';
import { DURATION, notify } from './notify';
import { t, tn } from './i18n';
import { LANGUAGES } from './texts/index';

export interface GemmaWikiSettings {
  /**
   * Shape version of this object on disk. Migrations key on it rather than on
   * which keys are present, because for one key — lastThread — absence is
   * normal. See migrateSettings in pure.ts.
   */
  settingsVersion: number;
  wikiDir: string;
  // Engine context window (maxNumTokens). Bigger = longer notes fit and more
  // grounding per answer, at the cost of GPU memory and first-token latency.
  // Applied at engine creation, so changes need a plugin reload.
  contextTokens: number;
  // Show the [Test] diagnostic commands in the palette. Off by default:
  // they are debugging tools, not things to do with your notes.
  devCommands: boolean;
  staleDays: number;
  defaultMode: 'note' | 'wiki' | 'vault';
  /** Appended to every chat system prompt; see standingInstructions in pure.ts. */
  chatInstructions: string;
  /**
   * The last chat thread, so closing the panel does not discard it (#100).
   *
   * One thread, not a history: this exists so an accidental close, a restart,
   * or a plugin update does not cost you an exchange that took half a minute
   * of GPU time to produce. Past threads are the 🕘 history, kept in their
   * own file in the plugin folder — see chat-archive.ts.
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
  // Whether the pointer at the chat panel's mode button has been dismissed.
  // Separate from hasChatted, because the button is new to people who have
  // chatted for months: it replaced three pills they knew.
  scopeHintSeen: boolean;
  // The interface language (#166): a code from src/texts/, or 'auto' to
  // follow Obsidian's own language setting.
  language: string;
}

export const DEFAULT_SETTINGS: GemmaWikiSettings = {
  settingsVersion: SETTINGS_VERSION,
  wikiDir: DEFAULT_WIKI_DIR,
  contextTokens: 64000,
  devCommands: false,
  staleDays: 30,
  defaultMode: 'note',
  chatInstructions: '',
  scanQuietHours: 3,
  scanInclude: '',
  scanExclude: '',
  answerFolder: '',
  retiredFoldersNoticed: false,
  autoScanEnabled: false,
  autoScanIntervalHours: 6,
  hasChatted: false,
  scopeHintSeen: false,
  language: 'auto',
};

/** The language dropdown: Obsidian's choice first, then each language by its own name. */
function languageOptions(): Record<string, string> {
  const options: Record<string, string> = { auto: t('settings.language.auto') };
  for (const l of LANGUAGES) options[l.code] = l.name;
  return options;
}

export class GemmaWikiSettingTab extends PluginSettingTab {
  private plugin: LiteRtSpikePlugin;

  constructor(app: App, plugin: LiteRtSpikePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * The declarative half of this tab (Obsidian 1.13+).
   *
   * Obsidian 1.13 indexes settings so a user can find one by typing its name,
   * and only definitions returned here are indexed — an imperatively built row
   * is invisible to that search. `display()` below stays for the 1.11.4 floor
   * this plugin declares, so the two coexist: everything a search would
   * plausibly be aimed at is declared here, and the parts that are not really
   * "a setting" — the model download with its live progress, the folder-state
   * table, the buttons that open a file — keep their imperative rendering
   * through `render`, which exists for exactly that.
   *
   * Values are read from and written to `plugin.settings` by key. Side
   * effects that used to live in each `onChange` move to `setControlValue`,
   * which is the one place a write passes through.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        type: 'group',
        heading: t('settings.group.model'),
        items: [
          // Rendered imperatively into the declarative page. On 1.13 and later
          // display() is never called once this list is non-empty, so anything
          // that lives only there is invisible — which, until this, was the
          // model download, Check setup, the folder map and the repair button.
          {
            name: t('settings.model.name'),
            desc: t('settings.model.desc'),
            aliases: ['download', 'gemma', 'weights'],
            render: (setting) => this.addLocalModelControls(setting),
          },
          {
            name: t('settings.check.name'),
            desc: t('settings.check.desc'),
            aliases: ['diagnostics', 'gpu', 'webgpu', 'troubleshoot'],
            render: (setting) => this.addCheckSetupControls(setting),
          },
          {
            name: t('settings.context.name'),
            desc: t('settings.context.desc'),
            aliases: ['tokens', 'maxNumTokens', 'memory'],
            control: {
              type: 'dropdown',
              key: 'contextTokens',
              options: {
                '4096': t('settings.context.small'),
                '8192': '8,192',
                '16384': '16,384',
                '32768': '32,768',
                '64000': t('settings.context.max'),
              },
            },
          },
          {
            name: t('settings.dev.name'),
            desc: t('settings.dev.desc'),
            aliases: ['debug', 'diagnostics', 'test commands'],
            control: { type: 'toggle', key: 'devCommands' },
          },
        ],
      },
      {
        type: 'group',
        heading: t('settings.group.wiki'),
        items: [
          {
            name: t('settings.folder.name'),
            desc: t('settings.folder.desc'),
            aliases: ['wiki folder', 'rename', 'gemma-wiki'],
            render: (setting) =>
              this.addKnowledgeFolderControls(setting, () => {
                this.refreshDeclarativeScaffoldRows();
                (this as { update?: () => void }).update?.();
              }),
          },
          {
            name: t('settings.map.name'),
            desc: t('settings.map.desc'),
            aliases: ['folders', 'layout', 'scaffold', 'schema.md', 'skills'],
            render: (setting) => {
              // A table, not a control: it takes the whole row.
              setting.settingEl.addClass('gemma4-folder-map-row');
              const map = setting.settingEl.createDiv({ cls: 'gemma4-folder-map' });
              this.declarativeScaffoldRows.map = map;
              this.renderFolderMap(map);
              // The imperative page registers these in redraw(); that never
              // runs here, so the row that shows the state watches for it.
              const owned = new Set(wikiScaffoldPaths().map((e) => e.path.replace(/\/$/, '')));
              const touched = (path: string) => owned.has(path) || path === this.plugin.settings.wikiDir;
              const refresh = (file: { path: string }) => {
                if (touched(file.path)) this.refreshDeclarativeScaffoldRows();
              };
              const refs: EventRef[] = [
                this.app.vault.on('create', refresh),
                this.app.vault.on('delete', refresh),
                this.app.vault.on('rename', (file, oldPath) => {
                  if (touched(file.path) || touched(oldPath)) this.refreshDeclarativeScaffoldRows();
                }),
              ];
              return () => {
                for (const ref of refs) this.app.vault.offref(ref);
                delete this.declarativeScaffoldRows.map;
              };
            },
          },
          {
            name: t('settings.repair.name'),
            desc: t('settings.repair.desc'),
            aliases: ['repair', 'missing', 'recreate'],
            render: (setting) => {
              this.declarativeScaffoldRows.repair = setting;
              this.addRepairFoldersControls(setting, () => this.refreshDeclarativeScaffoldRows());
              return () => {
                delete this.declarativeScaffoldRows.repair;
              };
            },
          },
          {
            name: t('settings.setupCard.name'),
            desc: t('settings.setupCard.desc'),
            aliases: ['setup card', 'welcome', 'onboarding'],
            render: (setting) => this.addSetupCardControls(setting),
          },
        ],
      },
      {
        type: 'group',
        heading: t('settings.group.schema'),
        items: [
          {
            name: t('settings.tags.name'),
            desc: t('settings.tags.desc'),
            aliases: ['tags', 'schema', 'organize', 'vocabulary'],
            render: (setting) => {
              setting.setClass('gemma4-stack-buttons');
              this.addOrganizeTagsControls(setting);
            },
          },
        ],
      },
      {
        type: 'group',
        heading: t('settings.group.skills'),
        items: [
          {
            name: t('settings.skills.name'),
            desc: t('settings.skills.desc'),
            aliases: ['prompts', 'skills folder', 'lightning menu'],
            render: (setting) => this.addSkillsFolderControls(setting),
          },
        ],
      },
      {
        type: 'group',
        heading: t('settings.group.chat'),
        items: [
          {
            name: t('settings.language.name'),
            desc: t('settings.language.desc'),
            aliases: ['language', 'locale', 'japanese', 'chinese', 'translation'],
            control: { type: 'dropdown', key: 'language', options: languageOptions() },
          },
          {
            name: t('settings.mode.name'),
            desc: t('settings.mode.desc'),
            aliases: ['this note', 'wiki mode', 'vault', 'direct'],
            control: {
              type: 'dropdown',
              key: 'defaultMode',
              options: {
                note: t('chat.scope.note.label'),
                vault: t('chat.scope.vault.label'),
                wiki: t('chat.scope.wiki.label'),
              },
            },
          },
          {
            name: t('settings.instructions.name'),
            desc: t('settings.instructions.desc'),
            aliases: ['system prompt', 'custom instructions', 'language', 'persona'],
            control: {
              type: 'textarea',
              key: 'chatInstructions',
              rows: 3,
              placeholder: t('settings.instructions.placeholder'),
            },
          },
        ],
      },
      {
        type: 'group',
        heading: t('settings.group.review'),
        items: [
          {
            name: t('settings.stale.name'),
            desc: t('settings.stale.desc'),
            aliases: ['staleness', 'review board'],
            control: { type: 'slider', key: 'staleDays', min: 7, max: 120, step: 1 },
          },
        ],
      },
      {
        type: 'group',
        heading: t('settings.group.scan'),
        items: [
          {
            name: t('settings.howToScan.name'),
            desc: t('settings.howToScan.desc'),
            aliases: ['scan', 'ingest', 'folder scan', 'stop scan'],
          },
          {
            name: t('settings.answerFolder.name'),
            desc: t('settings.answerFolder.desc'),
            aliases: ['answer folder', 'save', 'where answers go'],
            control: { type: 'text', key: 'answerFolder', placeholder: t('settings.answerFolder.placeholder') },
          },
          {
            name: t('settings.exclude.name'),
            desc: t('settings.exclude.desc'),
            aliases: ['exclude', 'ignore', 'skip folders'],
            control: { type: 'textarea', key: 'scanExclude', rows: 2, placeholder: t('settings.exclude.placeholder') },
          },
          {
            name: t('settings.count.name'),
            desc: t('settings.count.desc'),
            aliases: ['status bar', 'badge', 'background'],
            control: { type: 'toggle', key: 'autoScanEnabled' },
          },
          {
            name: t('settings.quiet.name'),
            desc: t('settings.quiet.desc'),
            aliases: ['quiet', 'recent edits'],
            visible: () => this.plugin.settings.autoScanEnabled,
            control: { type: 'slider', key: 'scanQuietHours', min: 0, max: 24, step: 1 },
          },
          {
            name: t('settings.recount.name'),
            desc: t('settings.recount.desc'),
            aliases: ['interval', 'refresh'],
            visible: () => this.plugin.settings.autoScanEnabled,
            control: { type: 'slider', key: 'autoScanIntervalHours', min: 1, max: 24, step: 1 },
          },
        ],
      },
    ];
  }

  /**
   * Read side of the same binding.
   *
   * A dropdown's options are keyed by string, and this one stores a number —
   * so the default read would hand the control `64000` where it is looking
   * for `"64000"`, and the pane would open with nothing selected. Everything
   * else round-trips as itself.
   */
  getControlValue(key: string): unknown {
    const value = (this.plugin.settings as unknown as Record<string, unknown>)[key];
    return key === 'contextTokens' ? String(value) : value;
  }

  /**
   * Every write passes through here, so this is where the effects live that
   * used to sit in each control's `onChange`: a changed context window or
   * developer-command toggle needs a plugin reload to take, a changed wiki
   * folder has to be pushed into the module that resolves paths, and the
   * background counter has to be rescheduled when its cadence changes.
   */
  async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings as unknown as Record<string, unknown>;
    s[key] = key === 'contextTokens' ? parseInt(String(value), 10) || 64000 : value;
    await this.plugin.saveSettings();

    if (key === 'language') {
      this.plugin.applyLanguage();
      // This page is in the old language until it is drawn again.
      (this as { update?: () => void }).update?.();
      if (!(await this.plugin.redrawChatPanels())) notify('info', t('settings.language.reopen'));
    } else if (key === 'contextTokens') {
      notify('done', t('settings.context.saved'), DURATION.NORMAL);
    } else if (key === 'devCommands') {
      notify('info', t('settings.dev.reload'));
    } else if (key === 'autoScanEnabled' || key === 'autoScanIntervalHours') {
      this.plugin.rescheduleAutoScan();
      // The two sliders below this toggle appear and disappear with it, and
      // `visible` is only re-evaluated when the tab is told to re-render.
      // update() arrived in 1.13 alongside this whole API, while the declared
      // floor is 1.11.4 — but nothing on 1.11.4 reaches this method at all,
      // since it only runs when Obsidian is driving the declarative tab. The
      // check is for the type system and for anyone reading it later.
      if (key === 'autoScanEnabled') {
        const tab = this as { update?: () => void };
        tab.update?.();
      }
    }
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
      this.redraw();
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

  /**
   * Obsidian calls this to open the tab. It is deprecated from 1.13 in favour
   * of getSettingDefinitions above, and stays for the 1.11.4 floor. Nothing
   * else in this file calls it: the rows that rebuild the pane after a change
   * go through `redraw`, so the deprecated name is written exactly once, here,
   * where the app requires it.
   */
  display(): void {
    this.redraw();
  }

  private redraw(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('gemma4-settings');
    for (const ref of this.watchers) this.app.vault.offref(ref);
    this.watchers = [];
    this.watchScaffold();

    // A settings page is where people land when they are lost, so the way to
    // see every feature working comes first — one line, then out of the way.
    const demo = containerEl.createEl('p', { cls: 'gemma4-settings-demo' });
    demo.appendText(t('settings.demo.before'));
    demo.createEl('a', {
      text: 'gemma-wiki-demo.vercel.app',
      href: 'https://gemma-wiki-demo.vercel.app',
    });
    demo.appendText(t('settings.demo.after'));

    // ---------- Model ----------
    new Setting(containerEl).setName(t('settings.group.model')).setHeading();

    this.addLocalModelControls(new Setting(containerEl).setName(t('settings.model.name')));
    this.addCheckSetupControls(
      new Setting(containerEl).setName(t('settings.check.name')).setDesc(t('settings.check.desc'))
    );

    new Setting(containerEl)
      .setName(t('settings.context.name'))
      .setDesc(t('settings.context.desc'))
      .addDropdown((dd) =>
        dd
          .addOption('4096', t('settings.context.small'))
          .addOption('8192', '8,192')
          .addOption('16384', '16,384')
          .addOption('32768', '32,768')
          .addOption('64000', t('settings.context.max'))
          .setValue(String(this.plugin.settings.contextTokens))
          .onChange(async (v) => {
            this.plugin.settings.contextTokens = parseInt(v, 10) || 64000;
            await this.plugin.saveSettings();
            notify('done', t('settings.context.saved'), DURATION.NORMAL);
          })
      );

    new Setting(containerEl)
      .setName(t('settings.dev.name'))
      .setDesc(t('settings.dev.desc'))
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.devCommands).onChange(async (v) => {
          this.plugin.settings.devCommands = v;
          await this.plugin.saveSettings();
          notify('info', t('settings.dev.reload'));
        })
      );

    // ---------- Wiki ----------
    new Setting(containerEl).setName(t('settings.group.wiki')).setHeading();

    this.addKnowledgeFolderControls(
      new Setting(containerEl).setName(t('settings.folder.name')).setDesc(t('settings.folder.desc')),
      () => this.redraw()
    );
    this.renderFolderMap(containerEl.createDiv({ cls: 'gemma4-folder-map' }));
    this.addRepairFoldersControls(new Setting(containerEl).setName(t('settings.repair.name')), () => this.redraw());
    this.addSetupCardControls(
      new Setting(containerEl).setName(t('settings.setupCard.name')).setDesc(t('settings.setupCard.desc'))
    );

    // ---------- Schema ----------
    new Setting(containerEl).setName(t('settings.group.schema')).setHeading();
    this.addOrganizeTagsControls(
      new Setting(containerEl)
        .setName(t('settings.tags.name'))
        .setClass('gemma4-stack-buttons')
        .setDesc(t('settings.tags.desc'))
    );

    // ---------- Skills ----------
    new Setting(containerEl).setName(t('settings.group.skills')).setHeading();
    this.addSkillsFolderControls(
      new Setting(containerEl).setName(t('settings.skills.name')).setDesc(t('settings.skills.desc'))
    );

    // ---------- Chat ----------
    new Setting(containerEl).setName(t('settings.group.chat')).setHeading();
    this.legacyRedrawRest(containerEl);
  }

  /**
   * The rows that were unique to the imperative page and are now shared with
   * the declarative one. Each takes a Setting whose name (and static desc)
   * is already set — by redraw() on Obsidian before 1.13, by the framework
   * from getSettingDefinitions() on 1.13 and later — and adds what the
   * definition language cannot express: a button, a confirm dialog, a
   * description that depends on what is on disk.
   */
  private addLocalModelControls(s: Setting): void {
    const status = this.plugin.modelStatus();
    s.setDesc(
      status.downloaded
        ? t('settings.model.downloaded', { gb: status.sizeGB })
        : status.partialGB
          ? t('settings.model.partial', { gb: status.partialGB })
          : t('settings.model.missing')
    );
    s.addButton((btn) => {
      btn.setButtonText(
        t(status.downloaded ? 'settings.model.redownload' : status.partialGB ? 'settings.model.resume' : 'settings.model.download')
      );
      btn.onClick(() => void this.plugin.downloadModelFromSettings());
    });
  }

  private addCheckSetupControls(s: Setting): void {
    s.addButton((btn) => {
      btn.setButtonText(t('settings.check.run'));
      btn.onClick(() => void this.plugin.showDiagnostics());
    });
  }

  private addKnowledgeFolderControls(s: Setting, afterRename: () => void): void {
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
    s.addText((text) =>
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
        btn.setButtonText(t('settings.folder.apply')).onClick(async () => {
          const next = normalizeDir(pendingDir);
          const prev = this.plugin.settings.wikiDir;
          if (!next || next === prev) return;
          const existing = this.app.vault.getAbstractFileByPath(next);
          if (existing && !(existing instanceof TFolder)) {
            notify('warn', t('settings.folder.notFolder', { name: next }));
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
              title: t('settings.folder.renameTitle'),
              body:
                `${prev}  →  ${next}\n\n` +
                (pageCount
                  ? tn('settings.folder.renameMoves', pageCount, { prev })
                  : t('settings.folder.renameEmpty', { prev, next })) +
                `\n\n${t('settings.folder.renameCheck')}`,
              confirmText: t('settings.folder.renameConfirm'),
              onResult: resolve,
            }).open();
          });
          if (!ok) return;
          await this.plugin.renameWikiDir(prev, next);
          afterRename();
        });
        syncApply();
      });
  }

  /**
   * What the plugin actually put in the vault. The settings page used to
   * describe the layout in prose in three different places and got it wrong
   * (concepts/, skills/ and schema.md were missing from the list) — this is
   * generated from the same list the scaffold builds from, so it cannot drift.
   * Returns how many entries are missing, for the repair row beneath it.
   */
  private renderFolderMap(map: HTMLElement): number {
    map.empty();
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
      row.createSpan({ cls: 'gemma4-folder-state', text: here ? '✓' : t('settings.map.missing') });
    }
    return missing;
  }

  /**
   * Showing the state turns "Repair folders" from a button whose purpose is
   * a mystery (the folders are made on startup, so why is it here?) into the
   * action for a condition you can actually see. Sync clients drop empty
   * directories often enough that the recovery path has to exist.
   */
  private addRepairFoldersControls(s: Setting, afterRepair: () => void): void {
    const missing = wikiScaffoldPaths().filter((e) => !this.app.vault.getAbstractFileByPath(e.path.replace(/\/$/, ''))).length;
    s.setDesc(
      missing
        ? t('settings.repair.someMissing', { n: missing, total: wikiScaffoldPaths().length })
        : t('settings.repair.allPresent')
    );
    s.addButton((btn) => {
      // Deliberately not a CTA. The red rows already carry the signal, and a
      // filled accent button for a recovery action reads as the main thing
      // to do on the page, which it never is.
      btn.setButtonText(missing ? t('settings.repair.createMissing', { n: missing }) : t('settings.repair.button'));
      btn.onClick(async () => {
        await this.plugin.repairWikiFolders();
        afterRepair();
      });
    });
  }

  private addSetupCardControls(s: Setting): void {
    s.addButton((btn) => btn.setButtonText(t('settings.setupCard.button')).onClick(() => this.plugin.showSetupCard()));
  }

  private addOrganizeTagsControls(s: Setting): void {
    s.addButton((btn) => btn.setButtonText(t('settings.tags.button')).onClick(() => void this.plugin.suggestTagVocabulary()));
  }

  private addSkillsFolderControls(s: Setting): void {
    s.addButton((btn) => btn.setButtonText(t('settings.skills.button')).onClick(() => void this.plugin.createSkillsFolder()));
  }

  /**
   * On Obsidian 1.13 and later the declarative page is what renders, and the
   * rows above are drawn into it through `render`. Those rows read the vault
   * (is the model there, which folders exist) and go stale when it changes;
   * this redraws just the two that do, in place, and is what the vault
   * watchers registered by the folder map call.
   */
  private declarativeScaffoldRows: { map?: HTMLElement; repair?: Setting } = {};

  private refreshDeclarativeScaffoldRows(): void {
    const { map, repair } = this.declarativeScaffoldRows;
    if (map) this.renderFolderMap(map);
    if (repair) {
      repair.controlEl.empty();
      this.addRepairFoldersControls(repair, () => this.refreshDeclarativeScaffoldRows());
    }
  }

  /** The remainder of the imperative page, unchanged: rows the declarative page also declares. */
  private legacyRedrawRest(containerEl: HTMLElement): void {

    new Setting(containerEl)
      .setName(t('settings.language.name'))
      .setDesc(t('settings.language.desc'))
      .addDropdown((dd) =>
        dd
          .addOptions(languageOptions())
          .setValue(this.plugin.settings.language)
          .onChange(async (v) => {
            this.plugin.settings.language = v;
            await this.plugin.saveSettings();
            this.plugin.applyLanguage();
            const scrollTop = this.containerEl.scrollTop;
            this.redraw();
            this.containerEl.scrollTop = scrollTop;
            if (!(await this.plugin.redrawChatPanels())) notify('info', t('settings.language.reopen'));
          })
      );

    new Setting(containerEl)
      .setName(t('settings.mode.name'))
      .setDesc(t('settings.mode.desc'))
      .addDropdown((dd) =>
        dd
          .addOption('note', t('chat.scope.note.label'))
          .addOption('vault', t('chat.scope.vault.label'))
          .addOption('wiki', t('chat.scope.wiki.label'))
          .setValue(this.plugin.settings.defaultMode)
          .onChange(async (v) => {
            this.plugin.settings.defaultMode =
              v === 'wiki' ? 'wiki' : v === 'note' ? 'note' : 'vault';
            await this.plugin.saveSettings();
          })
      );

    // ---------- Review ----------
    new Setting(containerEl).setName(t('settings.group.review')).setHeading();

    new Setting(containerEl)
      .setName(t('settings.stale.name'))
      .setDesc(t('settings.stale.desc'))
      .addSlider((sl) =>
        sl
          .setLimits(7, 120, 1)
          .setValue(this.plugin.settings.staleDays)
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
    new Setting(containerEl).setName(t('settings.group.scan')).setHeading();

    new Setting(containerEl).setName(t('settings.howToScan.name')).setDesc(t('settings.howToScan.desc'));

    new Setting(containerEl)
      .setName(t('settings.answerFolder.name'))
      .setDesc(t('settings.answerFolder.desc'))
      .addText((text) =>
        text
          .setPlaceholder(t('settings.answerFolder.placeholder'))
          .setValue(this.plugin.settings.answerFolder)
          .onChange(async (v) => {
            this.plugin.settings.answerFolder = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('settings.exclude.name'))
      .setDesc(t('settings.exclude.desc'))
      .addText((text) =>
        text
          .setPlaceholder(t('settings.exclude.placeholder'))
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
      .setName(t('settings.count.name'))
      .setDesc(t('settings.count.desc'))
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.autoScanEnabled).onChange(async (v) => {
          this.plugin.settings.autoScanEnabled = v;
          await this.plugin.saveSettings();
          this.plugin.rescheduleAutoScan();
          // Re-render to reveal/hide the background-only knobs below —
          // preserving the scroll position, since redraw() rebuilds the pane
          // and would otherwise snap the view back to the top.
          const scrollTop = this.containerEl.scrollTop;
          this.redraw();
          this.containerEl.scrollTop = scrollTop;
        })
      );

    if (this.plugin.settings.autoScanEnabled) {
      new Setting(containerEl)
        .setName(t('settings.quiet.name'))
        .setDesc(t('settings.quiet.desc'))
        .addSlider((sl) =>
          sl
            .setLimits(0, 24, 1)
            .setValue(this.plugin.settings.scanQuietHours)
            .onChange(async (v) => {
              this.plugin.settings.scanQuietHours = v;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName(t('settings.recount.name'))
        .setDesc(t('settings.recount.desc'))
        .addSlider((sl) =>
          sl
            .setLimits(1, 24, 1)
            .setValue(this.plugin.settings.autoScanIntervalHours)
            .onChange(async (v) => {
              this.plugin.settings.autoScanIntervalHours = v;
              await this.plugin.saveSettings();
              this.plugin.rescheduleAutoScan();
            })
        );
    }
  }
}
