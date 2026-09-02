import {
  App,
  FuzzySuggestModal,
  ItemView,
  Menu,
  MarkdownRenderer,
  setIcon,
  setTooltip,
  TFile,
  WorkspaceLeaf,
  normalizePath,
} from 'obsidian';
import type { Conversation } from '@litert-lm/core';
import type LiteRtSpikePlugin from './main';
import {
  appendLog,
  buildAnswerNote,
  safeFileName,
  clampToTokens,
  contentHash,
  ensureWikiScaffold,
  expandByLinks,
  getIngestedSourcePaths,
  indexPath,
  loadPages,
  readIndexEntries,
  readLogTail,
  readSkills,
  scoreEntries,
  writeWikiPage,
  type ChatTurnRecord,
} from './wiki-store';
import { IngestPreviewModal } from './ingest-modal';
import { notify } from './notify';

// What `written_by` records on a saved answer. The bundle filename without its
// extension: specific enough to tell two model versions apart in six months,
// which is the whole point of writing it down.
const MODEL_LABEL = 'gemma-4-E4B-it-web';

// Chat with the currently active note, entirely local. This is the
// "narrow" version of Query from the wiki roadmap — grounded in one open
// note instead of an index-selected set of wiki pages, because the wiki
// layer (ingest) doesn't exist yet. Once ingest is built, this view's
// context source swaps from "the active file" to "index.md + selected
// pages" without changing the UI shell.
//
// UI conventions follow what the top Obsidian AI panels (Copilot-style
// side leaves) established: theme variables only (no hardcoded colors, so
// any community theme and dark mode just work), accent-colored user
// bubbles, full-width markdown-rendered assistant replies, hover action
// buttons, a typing indicator while waiting for the first token, and a
// stop button during generation.

// Copilot-style "+" context picker: fuzzy-search any markdown note and
// attach it as grounding for the next question. Selections render as
// removable pills above the input.
class NotePickerModal extends FuzzySuggestModal<TFile> {
  private exclude: Set<string>;
  private onPick: (f: TFile) => void;

  constructor(app: App, exclude: Set<string>, onPick: (f: TFile) => void) {
    super(app);
    this.exclude = exclude;
    this.onPick = onPick;
    this.setPlaceholder('Attach a note as context…');
  }

  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles().filter((f) => !this.exclude.has(f.path));
  }

  getItemText(f: TFile): string {
    return f.path;
  }

  onChooseItem(f: TFile): void {
    this.onPick(f);
  }
}

export const VIEW_TYPE_CHAT = 'gemma4-litert-wiki-chat-view';

// How much grounding content to feed per answer, derived from the configured
// context window (settings) minus room for the answer and instructions.
// Token-estimated (CJK-aware), not char-counted.

/** One chip above the input: a label, and what pressing it does. */
export interface SuggestionSpec {
  label: string;
  /** What to send, for the chips that ask a question. */
  ask?: string;
  /** A non-question action: scan, file a note, reformat one. Styled as a write. */
  action?: 'scan' | 'ingest' | 'improve';
  /**
   * Ground in every page rather than the ones that lexically match.
   *
   * There are two kinds of wiki question and only one of them is served by
   * retrieval. "What did I conclude about X" wants the pages about X. "What
   * connects my pages" wants breadth, and scoring it against page summaries
   * finds nothing at all — the words in the question (connections, themes,
   * gaps, pages) appear in no summary, so zero pages come back and the model
   * correctly reports that it was given none.
   */
  wholeWiki?: boolean;
}

/**
 * Which chips belong above the input, given the mode and whether the wiki
 * holds anything.
 *
 * Pulled out as a pure function because the bug this fixes lives entirely in
 * this decision, not in the rendering: with an empty wiki, every one of the
 * three wiki-mode questions is guaranteed to fail. The panel was inviting the
 * user to do something that could not work, three times over, and answering
 * each with the same refusal.
 *
 * This row is also the only part of the panel that never disappears — the
 * empty state that used to carry "Scan a folder" is about an empty
 * CONVERSATION, and vanishes the moment you send anything, while an empty
 * WIKI stays empty until you file something. Two different emptinesses; the
 * remedy belongs to the one that persists.
 */
export function suggestionsFor(mode: 'note' | 'wiki'): SuggestionSpec[] {
  if (mode === 'note') {
    // "Key points" went: it and "Summarize" are the same operation in two
    // layouts, and they were two of the three slots. The freed slot goes to
    // the action that was missing entirely — This-note mode had no way to put
    // the note you are looking at into the wiki, even though actions can ONLY
    // live in this row and that one is the plugin's core loop.
    return [
      { label: 'Summarize', ask: 'Summarize this note' },
      { label: 'Formatting', action: 'improve' },
      { label: 'Ingest this note into wiki', action: 'ingest' },
    ];
  }
  // Three, fixed, and the same whatever state the wiki is in.
  //
  // An earlier version swapped these out for "Scan a folder / File this note"
  // when nothing was filed yet. It meant the row you learned was not the row
  // you kept, and it hid Find connections from the person most likely to be
  // wondering what this thing does. Asking a wiki question against an empty
  // wiki now simply answers "there is nothing here", and that answer carries
  // the buttons to fix it — the remedy travels with the problem instead of
  // rearranging the furniture in advance.
  //
  // Three because the row is permanent screen space and a fourth wraps on a
  // narrow panel. Scan takes one because it is an action, and a skill file is
  // frontmatter plus a prompt with no way to express "do this". The other two
  // are the questions whose answers are not already sitting in a file you
  // could open — which is what ruled out "What's in my wiki?" (index.md) and
  // "Added recently" (log.md, and it duplicated a skills-menu entry).
  return [
    { label: 'Scan a folder', action: 'scan' },
    {
      label: 'Find connections',
      ask: 'What connections or common themes link the pages in my wiki? Cite the pages.',
      wholeWiki: true,
    },
    {
      label: "What's still open?",
      // Wiki-wide, which is what separates it from the "Find gaps" skill:
      // that one looks for holes in whatever the chat is grounded in right
      // now, this one looks across everything filed.
      ask:
        'What questions do my pages raise but never answer? List the gaps and why each ' +
        'matters. Cite the pages.',
      wholeWiki: true,
    },
  ];
}

export class ChatView extends ItemView {
  private plugin: LiteRtSpikePlugin;
  private messagesEl!: HTMLElement;
  private emptyStateEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private noteChipEl!: HTMLElement;
  private busy = false;
  private turns: ChatTurnRecord[] = [];
  private lastQuestion: string | null = null;
  private activeConversation: Conversation | null = null;
  private mode: 'note' | 'wiki' = 'note'; // overwritten from settings in onOpen
  // Whether the wiki holds any pages. Cached, because the chips are drawn
  // synchronously and metadataCache fires 'resolved' constantly — reading
  // index.md on every one of those would be a file read per keystroke-ish
  // event for a boolean that changes about once.
  private wikiEmpty = true;
  private modeButtons: { note: HTMLElement; wiki: HTMLElement } | null = null;
  private expandButton!: HTMLButtonElement;
  private inputExpanded = false;
  private suggestionRow!: HTMLElement;
  private contextRow!: HTMLElement;
  private attachedFiles: TFile[] = [];

  private renderContextPills() {
    this.contextRow.empty();
    if (!this.attachedFiles.length) {
      this.contextRow.hide();
      return;
    }
    this.contextRow.show();
    for (const f of this.attachedFiles) {
      const pill = this.contextRow.createDiv({ cls: 'gemma4-chat-context-pill' });
      const ic = pill.createSpan({ cls: 'gemma4-chat-context-pill-icon' });
      setIcon(ic, 'file-text');
      pill.createSpan({ text: f.basename });
      const x = pill.createEl('button', {
        cls: 'gemma4-chat-context-pill-x',
        attr: { 'aria-label': 'Remove' },
      });
      setIcon(x, 'x');
      x.addEventListener('click', () => {
        this.attachedFiles = this.attachedFiles.filter((a) => a !== f);
        this.renderContextPills();
      });
    }
  }

  private async readAttachments(): Promise<{
    blocks: string;
    sources: { title: string; linkPath: string }[];
  }> {
    let blocks = '';
    const sources: { title: string; linkPath: string }[] = [];
    for (const f of this.attachedFiles) {
      const content = await this.app.vault.read(f);
      blocks += `## Attached note: ${f.basename}\n${content.slice(0, 8000)}\n\n`;
      sources.push({ title: f.basename, linkPath: f.path.replace(/\.md$/, '') });
    }
    return { blocks, sources };
  }

  private buildEmptyState() {
    this.emptyStateEl = this.messagesEl.createDiv({ cls: 'gemma4-chat-empty' });
    void this.renderEmptyState();
  }

  /**
   * The empty state, which is the only screen a new user is guaranteed to
   * look at.
   *
   * In Wiki mode with nothing ingested, the honest thing to say is "there is
   * nothing here yet" and to offer the way out. Filling the wiki lived only
   * in Settings and in a command called "semi-automatic ingest", so the one
   * moment a user is looking straight at an empty wiki was the one moment
   * nothing told them what to do about it.
   */
  /**
   * Re-read whether the wiki holds anything, and redraw only if that changed.
   *
   * metadataCache fires 'resolved' constantly, and this is behind a file read,
   * so the guard is the point: without it every resolve would re-read
   * index.md to re-answer a boolean that flips roughly once in the life of a
   * vault.
   */
  private async refreshWikiEmpty(): Promise<void> {
    let empty = true;
    try {
      empty = (await readIndexEntries(this.app.vault)).length === 0;
    } catch {
      empty = this.wikiEmpty;
    }
    if (empty === this.wikiEmpty) return;
    this.wikiEmpty = empty;
    this.renderSuggestions();
    void this.renderEmptyState();
  }

  private async renderEmptyState() {
    const el = this.emptyStateEl;
    if (!el) return;
    el.empty();
    const icon = el.createDiv({ cls: 'gemma4-chat-empty-icon' });
    setIcon(icon, 'gemma-wiki-logo');

    // Kept, because knowing the wiki is empty before you ask is worth a file
    // read. Not kept: the two buttons that used to be here. The chip row above
    // the input carries Scan permanently now, and a screen with the same two
    // buttons twice is a screen that has not decided where they live.
    if (this.mode === 'wiki' && this.wikiEmpty) {
      el.createDiv({ cls: 'gemma4-chat-empty-title', text: 'Your wiki is empty' });
      el.createDiv({
        cls: 'gemma4-chat-empty-hint',
        text:
          'Wiki mode answers from pages you have filed here, and nothing is filed yet. ' +
          'Press Scan a folder below to fill it.',
      });
      el.createDiv({
        cls: 'gemma4-chat-empty-hint',
        text:
          'Or switch to This note above and ask about the note you have open right now — that ' +
          'needs no setup at all.',
      });
      return;
    }

    el.createDiv({
      cls: 'gemma4-chat-empty-title',
      text: this.mode === 'wiki' ? 'Ask your wiki' : 'Ask about the open note',
    });
    el.createDiv({
      cls: 'gemma4-chat-empty-hint',
      text: 'Answers come from a model running entirely inside Obsidian — nothing leaves your machine.',
    });

    // Until the first message is sent, point at the chips. Someone opening this
    // for the first time is not short of explanation — there is a setup card, a
    // tooltip and a README — they are short of a first move. The chips already
    // are that move; they just look like decoration until something says so.
    if (!this.plugin.settings.hasChatted) {
      const nudge = this.emptyStateEl.createDiv({ cls: 'gemma4-chat-empty-nudge' });
      // Name a chip that is actually on screen. This said "press Summarize"
      // in both modes, and Wiki mode has no Summarize chip — a first-run hint
      // pointing at a button that is not there is worse than no hint.
      const first = suggestionsFor(this.mode)[0];
      nudge.appendText('New here? Press ');
      nudge.createEl('b', { text: first?.label ?? 'a chip' });
      nudge.appendText(' below, or just ask a question.');
    }
  }

  // Suggestion chips live above the input, permanently — they used to sit
  // in the empty state and vanished after the first question. Note-mode
  // only: canned wiki-mode questions would fight the lexical retrieval.
  /** What pressing a suggestion does — from a chip or from a message. */
  private runSuggestion(spec: SuggestionSpec) {
    if (spec.ask) {
      void this.handleSend({ text: spec.ask, wholeWiki: spec.wholeWiki });
      return;
    }
    if (spec.action === 'scan') return void this.plugin.scanAndReviewIngest();
    if (spec.action === 'ingest') return void this.plugin.ingestActiveNote();
    void this.plugin.improveActiveNote();
  }

  private renderSuggestions() {
    if (!this.suggestionRow) return;
    this.suggestionRow.empty();
    this.suggestionRow.show();
    // Short labels; the full question lives in the prompt. What belongs here
    // is decided by suggestionsFor(); this only draws it.
    // The one thing that separates a chip that ASKS from a chip that DOES.
    // Same pill, same text colour; the glyph carries it.
    const ACTION_ICON: Record<string, string> = {
      scan: 'folder-search',
      ingest: 'file-plus-2',
      improve: 'wand-2',
    };
    const TIP: Record<string, string> = {
      scan: 'Pick folders, see how many notes each holds, then draft a page for each',
      ingest: 'Draft one wiki page from the note you have open — you review it before anything is written',
      improve: 'Edits this note — you review before anything is written',
    };
    const scanning = this.plugin.isScanning();
    // Something else is already spending the engine. Rather than let you press
    // a button and be told no, take the button away — the only version of this
    // that needs no words. The scan chip is the exception, and only because it
    // turns into the stop control; every other chip greys, including during a
    // scan, where they used to stay lit and then refuse.
    const busy = this.plugin.isBusy();
    for (const spec of suggestionsFor(this.mode)) {
      // The scan chip doubles as the stop control while a scan runs. Pressing
      // it and getting "a scan is already running — use the other command" was
      // the button refusing to be the thing it obviously is.
      const isScanChip = spec.action === 'scan';
      const label = isScanChip && scanning ? 'Stop scan' : spec.label;
      const chip = this.suggestionRow.createEl('button', {
        cls: spec.action ? 'gemma4-chat-suggestion gemma4-chat-suggestion-write' : 'gemma4-chat-suggestion',
      });
      if (spec.action) setIcon(chip.createSpan(), isScanChip && scanning ? 'square' : ACTION_ICON[spec.action]);
      chip.createSpan({ text: label });
      if (isScanChip && scanning) {
        chip.addClass('gemma4-chat-suggestion-running');
        setTooltip(chip, 'Stop after the note being drafted right now finishes');
        chip.addEventListener('click', () => {
          this.plugin.cancelScan();
          notify('info', 'Stopping — the note being drafted right now will finish first.');
        });
        continue;
      }
      if (busy) {
        chip.disabled = true;
        chip.addClass('gemma4-chat-suggestion-disabled');
        setTooltip(chip, `Busy: ${this.plugin.runningLabel() ?? 'something is running'}`);
        continue;
      }
      if (spec.action) setTooltip(chip, TIP[spec.action]);
      chip.addEventListener('click', () => this.runSuggestion(spec));
    }
  }

  private clearChat() {
    if (this.busy) this.activeConversation?.cancel();
    this.lastQuestion = null;
    this.turns = [];
    this.messagesEl.empty();
    this.buildEmptyState();
  }

  private autoGrowInput() {
    if (this.inputExpanded) return;
    const el = this.inputEl;
    el.style.height = 'auto';
    const max = Math.floor(this.containerEl.clientHeight * 0.35);
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }

  private toggleInputExpand() {
    this.inputExpanded = !this.inputExpanded;
    this.inputEl.toggleClass('gemma4-chat-input-tall', this.inputExpanded);
    setIcon(this.expandButton, this.inputExpanded ? 'minimize-2' : 'maximize-2');
    setTooltip(this.expandButton, this.inputExpanded ? 'Shrink input' : 'Expand input');
    if (this.inputExpanded) {
      this.inputEl.style.height = '';
    } else {
      this.autoGrowInput();
    }
    this.inputEl.focus();
  }

  constructor(leaf: WorkspaceLeaf, plugin: LiteRtSpikePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  /**
   * Closing the panel mid-answer must not leave the plugin marked busy.
   *
   * chatBusy is cleared in a finally, but that finally belongs to a generation
   * whose view is gone; a panel closed while streaming would otherwise leave
   * every chip and command disabled with nothing left to finish and clear it.
   */
  async onClose(): Promise<void> {
    this.activeConversation?.cancel();
    this.plugin.setChatBusy(false);
  }

  getViewType(): string {
    return VIEW_TYPE_CHAT;
  }

  getDisplayText(): string {
    return 'Chat with note';
  }

  getIcon(): string {
    return 'gemma-wiki-logo';
  }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('gemma4-chat');

    // Header: title row + context chip showing which note we're grounded in.
    const header = container.createDiv({ cls: 'gemma4-chat-header' });
    const titleRow = header.createDiv({ cls: 'gemma4-chat-title-row' });
    const titleIcon = titleRow.createSpan({ cls: 'gemma4-chat-title-icon' });
    // Brand mark, registered in main.ts: a note card with a folded corner
    // and a spark.
    setIcon(titleIcon, 'gemma-wiki-logo');
    titleRow.createSpan({ cls: 'gemma4-chat-title', text: 'Gemma Wiki' });
    titleRow.createSpan({ cls: 'gemma4-chat-title-badge', text: 'local' });
    // Grouped at the right so the two icons sit together, not pushed to
    // opposite ends by the title's auto margin.
    const headerActions = titleRow.createDiv({ cls: 'gemma4-chat-header-actions' });
    const clearBtn = headerActions.createEl('button', {
      cls: 'gemma4-chat-clear',
      attr: { 'aria-label': 'Clear chat' },
    });
    setIcon(clearBtn, 'trash-2');
    setTooltip(clearBtn, 'Clear chat');
    clearBtn.addEventListener('click', () => this.clearChat());

    // Mode pills live in the composer toolbar (concept D); the header
    // keeps only the context chip.
    this.noteChipEl = header.createDiv({ cls: 'gemma4-chat-note-chip' });

    // Message list with an empty-state hint shown until the first send.
    this.messagesEl = container.createDiv({ cls: 'gemma4-chat-messages' });
    this.buildEmptyState();

    // Input area, concept D: suggestion chips above one unified composer
    // card (Claudian-style) holding context pills, a borderless textarea,
    // and a hairline toolbar — mode pills left, tools middle, send right.
    const inputWrap = container.createDiv({ cls: 'gemma4-chat-input-wrap' });
    this.suggestionRow = inputWrap.createDiv({ cls: 'gemma4-chat-suggestion-row' });
    const composer = inputWrap.createDiv({ cls: 'gemma4-composer' });
    this.contextRow = composer.createDiv({ cls: 'gemma4-chat-context-row' });
    this.contextRow.hide();
    this.inputEl = composer.createEl('textarea', {
      cls: 'gemma4-chat-input',
      attr: { placeholder: 'Ask about this note… (Enter to send)', rows: '3' },
    });
    const buttonRow = composer.createDiv({ cls: 'gemma4-composer-bar' });

    const modeRow = buttonRow.createDiv({ cls: 'gemma4-chat-mode-row' });
    // "This note", not "Note": users repeatedly read "Note" as "search my
    // notes" and were confused when it only saw the open file.
    const noteBtn = modeRow.createEl('button', { cls: 'gemma4-chat-mode-btn', text: 'This note' });
    const wikiBtn = modeRow.createEl('button', { cls: 'gemma4-chat-mode-btn', text: 'Wiki' });
    this.modeButtons = { note: noteBtn, wiki: wikiBtn };
    noteBtn.addEventListener('click', () => this.setMode('note'));
    wikiBtn.addEventListener('click', () => this.setMode('wiki'));

    const attachBtn = buttonRow.createEl('button', {
      cls: 'gemma4-chat-attach',
      attr: { 'aria-label': 'Add note as context' },
    });
    setIcon(attachBtn, 'plus');
    setTooltip(attachBtn, 'Add note as context');
    attachBtn.addEventListener('click', () => {
      const exclude = new Set(this.attachedFiles.map((f) => f.path));
      const active = this.app.workspace.getActiveFile();
      if (active) exclude.add(active.path);
      new NotePickerModal(this.app, exclude, (f) => {
        this.attachedFiles.push(f);
        this.renderContextPills();
      }).open();
    });

    // Skills: canned single-task prompts run against the current grounding
    // (mode + attachments). Each is one structured ask, not a tool loop —
    // the "wiki as input for repeat work" pattern from the field research.
    const skillsBtn = buttonRow.createEl('button', {
      cls: 'gemma4-chat-attach',
      attr: { 'aria-label': 'Run a skill' },
    });
    setIcon(skillsBtn, 'zap');
    setTooltip(skillsBtn, 'Run a skill');
    const SKILLS: { label: string; icon: string; prompt: string; mode?: 'note' | 'wiki'; fill?: boolean }[] = [
      {
        // Nouns, because every one of these hands you a thing: a quiz, a set of
        // cards, a checklist. The menu was three imperatives and two nouns,
        // and the two nouns were the seed files — the ones a user writes.
        // "Find gaps" keeps its verb: "Gaps" alone does not say gaps in what.
        label: 'Quiz',
        icon: 'graduation-cap',
        // Note-scoped, and not only as a matter of taste. Run in Wiki mode
        // these three retrieve NOTHING: the lexical scorer matches the words
        // in the prompt against page summaries, and "create practice
        // questions from this material" shares no vocabulary with a page
        // about compound interest. Zero pages came back and the model was
        // asked to quiz you on a catalog.
        mode: 'note',
        prompt:
          'Create 5 practice questions that test understanding of this material. Number each ' +
          'question and put its answer in bold directly below it.',
      },
      {
        label: 'Flashcards',
        icon: 'layers',
        mode: 'note',
        prompt:
          'Create 8 flashcards from this material. Format each as **Q:** question then **A:** ' +
          'answer on the next line, with a blank line between cards.',
      },
      {
        label: 'Find gaps',
        icon: 'search',
        mode: 'note',
        prompt:
          'What important questions does this material raise but not answer? List the gaps and ' +
          'why each matters.',
      },
    ];

    // Custom skills (issue #4) live as files in <wiki>/skills/ — "config as a
    // note", read fresh on each menu open so adding or editing a skill file
    // takes effect without reloading. Built-ins first, then the user's, in
    // filename order.
    skillsBtn.addEventListener('click', (evt) => {
      void (async () => {
        const custom = await readSkills(this.app.vault);
        const all = [...SKILLS, ...custom];
        const menu = new Menu();
        // A skill that declares a mode used to switch you into it on click.
        // That is a menu item quietly changing what the panel is grounded in
        // — you pressed "Feynman" from Wiki mode and landed in This note,
        // with nothing saying so. Show it as unavailable instead, and say
        // which mode it wants.
        const unusable = all.filter((s) => s.mode && s.mode !== this.mode);
        if (unusable.length === all.length && all.length) {
          const want = all[0].mode === 'wiki' ? 'Wiki' : 'This note';
          menu.addItem((item) => item.setTitle(`Switch to ${want} to use these`).setDisabled(true));
          menu.addSeparator();
        }
        // A skill spends the engine too, so it obeys the same one-at-a-time
        // rule as the chips rather than queueing behind whatever is running.
        const busy = this.plugin.isBusy();
        if (busy) {
          menu.addItem((item) =>
            item.setTitle(`Busy: ${this.plugin.runningLabel() ?? 'something is running'}`).setDisabled(true)
          );
          menu.addSeparator();
        }
        for (const skill of all) {
          const wrongMode = !!skill.mode && skill.mode !== this.mode;
          menu.addItem((item) => {
            item.setTitle(skill.label).setIcon(skill.icon);
            if (wrongMode || busy) {
              item.setDisabled(true);
              return;
            }
            item.onClick(() => {
              if (!skill.fill) {
                void this.handleSend({ text: skill.prompt, skillLabel: skill.label });
                return;
              }
              // fill: true is the one case that DOES want the box — the prompt
              // is unfinished and you are being handed the pen. The parser
              // trims the file, so a prompt written to end in "…explain: "
              // arrives without its space and the cursor would land against
              // the colon; put it back rather than asking every skill author
              // to notice.
              this.inputEl.value = /[:\-–—]$/.test(skill.prompt) ? `${skill.prompt} ` : skill.prompt;
              this.autoGrowInput();
              this.inputEl.focus();
              const end = this.inputEl.value.length;
              this.inputEl.setSelectionRange(end, end);
            });
          });
        }
        menu.showAtMouseEvent(evt);
      })();
    });

    // Expand toggle: square outline button that switches the input between
    // auto-grow and a fixed tall editor with its own scrollbar.
    this.expandButton = buttonRow.createEl('button', {
      cls: 'gemma4-chat-expand',
      attr: { 'aria-label': 'Expand input' },
    });
    setIcon(this.expandButton, 'maximize-2');
    setTooltip(this.expandButton, 'Expand input');
    this.expandButton.addEventListener('click', () => this.toggleInputExpand());

    this.inputEl.addEventListener('input', () => this.autoGrowInput());

    this.stopButton = buttonRow.createEl('button', { cls: 'gemma4-chat-stop' });
    setIcon(this.stopButton, 'square');
    this.stopButton.createSpan({ text: 'Stop' });
    this.stopButton.hide();
    // No mod-cta: it applies the theme's accent color, which defeats the
    // monochrome design (a pink theme accent turned the button pink).
    this.sendButton = buttonRow.createEl('button', { cls: 'gemma4-chat-send' });
    setIcon(this.sendButton, 'arrow-up');
    setTooltip(this.sendButton, 'Send (Enter)');

    this.setMode(this.plugin.settings.defaultMode);

    this.sendButton.addEventListener('click', () => void this.handleSend());
    this.stopButton.addEventListener('click', () => this.activeConversation?.cancel());
    this.inputEl.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' && !evt.shiftKey) {
        evt.preventDefault();
        void this.handleSend();
      }
    });

    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.updateNoteChip()));
    // The chips depend on whether the wiki holds anything, and that changes
    // out from under this panel — a scan finishing, a page written, a page
    // deleted. Read it once now, then follow the vault. refreshWikiEmpty
    // redraws only when the answer flips.
    void this.refreshWikiEmpty();
    this.registerEvent(this.app.metadataCache.on('resolved', () => void this.refreshWikiEmpty()));
    // The scan chip is also the stop button, so it has to know when a scan
    // starts and ends — including scans started from the command palette.
    this.register(this.plugin.onScanState(() => this.renderSuggestions()));
  }

  private setMode(mode: 'note' | 'wiki') {
    this.mode = mode;
    this.modeButtons?.note.toggleClass('gemma4-chat-mode-active', mode === 'note');
    this.modeButtons?.wiki.toggleClass('gemma4-chat-mode-active', mode === 'wiki');
    this.inputEl?.setAttribute(
      'placeholder',
      mode === 'note' ? 'Ask about this note… (Enter to send)' : 'Ask your wiki… (Enter to send)'
    );
    this.renderSuggestions();
    this.updateNoteChip();
    void this.renderEmptyState();
  }

  private updateNoteChip() {
    this.noteChipEl.empty();
    const icon = this.noteChipEl.createSpan({ cls: 'gemma4-chat-note-chip-icon' });
    if (this.mode === 'wiki') {
      setIcon(icon, 'library');
      this.noteChipEl.createSpan({ text: 'Wiki (ingested pages)' });
      this.noteChipEl.removeClass('gemma4-chat-note-chip-none');
      return;
    }
    const file = this.app.workspace.getActiveFile();
    setIcon(icon, 'file-text');
    this.noteChipEl.createSpan({
      text: file ? file.basename : 'No note open',
    });
    this.noteChipEl.toggleClass('gemma4-chat-note-chip-none', !file);
    if (file && getIngestedSourcePaths(this.app).has(file.path)) {
      const check = this.noteChipEl.createSpan({ cls: 'gemma4-chat-chip-check' });
      setIcon(check, 'check');
      check.setAttribute('aria-label', 'Already in wiki');
    }
  }

  private appendUserMessage(text: string) {
    this.emptyStateEl.hide();
    const row = this.messagesEl.createDiv({ cls: 'gemma4-chat-row gemma4-chat-row-user' });
    row.createDiv({ cls: 'gemma4-chat-bubble-user', text });
    this.scrollToBottom();
  }

  private appendAssistantMessage(): { body: HTMLElement; row: HTMLElement } {
    this.emptyStateEl.hide();
    const row = this.messagesEl.createDiv({ cls: 'gemma4-chat-row gemma4-chat-row-assistant' });
    const body = row.createDiv({ cls: 'gemma4-chat-bubble-assistant' });
    this.scrollToBottom();
    return { body, row };
  }

  // Failures render inside the thread rather than as a floating Notice —
  // otherwise the user's question bubble is left dangling with no visible
  // response, which read as "the model can't answer".
  /**
   * An inline note in the thread — a refusal, a truncation warning.
   *
   * Optionally with buttons. A refusal that names the way out and then makes
   * you go find it is only half a message: the "your wiki is empty" one used
   * to name a command you had to type, while the only clickable version of the
   * same thing lived in the empty state, which disappears the moment you send
   * anything.
   */
  private appendInfoMessage(text: string, actions?: SuggestionSpec[]) {
    this.emptyStateEl.hide();
    const row = this.messagesEl.createDiv({ cls: 'gemma4-chat-row gemma4-chat-row-assistant' });
    const box = row.createDiv({ cls: 'gemma4-chat-info', text });
    if (actions?.length) {
      const bar = box.createDiv({ cls: 'gemma4-chat-info-actions' });
      for (const spec of actions) {
        const btn = bar.createEl('button', { cls: 'gemma4-chat-empty-action', text: spec.label });
        btn.addEventListener('click', () => this.runSuggestion(spec));
      }
    }
    this.scrollToBottom();
  }

  private showTypingIndicator(parent: HTMLElement): HTMLElement {
    // A single thin spinner ring, shadcn-style — quieter than bouncing dots.
    return parent.createDiv({ cls: 'gemma4-chat-spinner' });
  }

  private addAssistantActions(
    row: HTMLElement,
    getAnswer: () => string,
    question: string,
    sources: { title: string; linkPath: string }[],
    allowSave = true,
    skillLabel?: string
  ) {
    const actions = row.createDiv({ cls: 'gemma4-chat-actions' });

    const copyBtn = actions.createEl('button', {
      cls: 'gemma4-chat-action clickable-icon',
      attr: { 'aria-label': 'Copy answer' },
    });
    setIcon(copyBtn, 'copy');
    setTooltip(copyBtn, 'Copy answer');
    copyBtn.addEventListener('click', () => {
      void navigator.clipboard.writeText(getAnswer());
      notify('done', 'Copied.');
    });

    const regenBtn = actions.createEl('button', {
      cls: 'gemma4-chat-action clickable-icon',
      attr: { 'aria-label': 'Regenerate' },
    });
    setIcon(regenBtn, 'refresh-cw');
    setTooltip(regenBtn, 'Regenerate answer');
    regenBtn.addEventListener('click', () => {
      if (this.busy || !this.lastQuestion) return;
      row.remove();
      void this.runGeneration(this.lastQuestion);
    });

    // Karpathy's compounding rule: good answers get filed back into the
    // wiki instead of vanishing into chat history. Same review gate as
    // ingest — preview first, nothing written without approval. Skipped for
    // ungrounded answers (issue #7): model guesses must not enter the wiki.
    if (!allowSave) return;
    const saveBtn = actions.createEl('button', {
      cls: 'gemma4-chat-action clickable-icon',
      attr: { 'aria-label': 'Save answer to wiki' },
    });
    setIcon(saveBtn, 'file-plus-2');
    setTooltip(saveBtn, 'Save as note');
    saveBtn.addEventListener('click', () => void (async () => {
      const answer = getAnswer();
      const folder = this.answerFolder(sources);
      // The question is the title, as a person would have typed it. slugify()
      // is right for a tag and for a card the plugin owns; this file lands in
      // someone's own folder, where a kebab-cased filename is the plugin
      // imposing a house style on a directory that is not its own.
      const label = skillLabel ? `${skillLabel} — ${sources[0]?.title ?? 'chat'}` : question;
      const stem = safeFileName(label, `answer ${window.moment().format('YYYY-MM-DD HHmmss')}`);
      const notePath = this.freePath(folder, stem);
      const content = buildAnswerNote(question, answer, sources, {
        model: MODEL_LABEL,
        titleLabel: skillLabel ? `${skillLabel} — ${sources[0]?.title ?? 'chat'}` : undefined,
      });
      // Never `overwriting`. This folder is the user's; appending " 2" costs a
      // duplicate, and silently replacing a file in someone's own notes costs
      // whatever was in it.
      new IngestPreviewModal(this.app, notePath, content, false, () => {
        void (async () => {
          const dir = notePath.slice(0, notePath.lastIndexOf('/'));
          if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
            await this.app.vault.createFolder(dir).catch(() => {});
          }
          await this.app.vault.create(notePath, content);
          await appendLog(this.app.vault, 'answer', notePath);
          notify('done', `Saved: ${notePath}`);
        })();
      }, 'Review note before writing').open();
    })());
  }

  /**
   * Which folder a saved answer goes in.
   *
   * Beside the note it came from, because that is the answer a person would
   * give if asked where it should live, and because the complaint this fixes is
   * not knowing where things went. In Wiki mode the answer read cards rather
   * than notes, so the first source is followed back through its `source:`
   * frontmatter to the note it summarises.
   *
   * The setting overrides all of it for anyone who would rather have one pile
   * they chose than several they did not.
   */
  private answerFolder(sources: { title: string; linkPath: string }[]): string {
    const configured = this.plugin.settings.answerFolder.trim();
    if (configured) return configured.replace(/\/+$/, '');
    const first = sources[0];
    if (first) {
      const card = this.app.vault.getAbstractFileByPath(`${first.linkPath}.md`);
      if (card instanceof TFile) {
        const src = this.app.metadataCache.getFileCache(card)?.frontmatter?.source;
        if (typeof src === 'string' && src) {
          const noteDir = src.slice(0, src.lastIndexOf('/'));
          if (noteDir) return noteDir;
          return '';
        }
      }
    }
    const active = this.app.workspace.getActiveFile();
    return active?.parent?.path && active.parent.path !== '/' ? active.parent.path : '';
  }

  /** `<folder>/<stem>.md`, with " 2", " 3" … appended rather than overwriting. */
  private freePath(folder: string, stem: string): string {
    const dir = folder ? `${folder}/` : '';
    let path = normalizePath(`${dir}${stem}.md`);
    for (let n = 2; this.app.vault.getAbstractFileByPath(path) && n <= 99; n++) {
      path = normalizePath(`${dir}${stem} ${n}.md`);
    }
    return path;
  }

  private scrollToBottom() {
    this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight });
  }

  /**
   * Send a question.
   *
   * A canned prompt is passed in rather than staged in the input box. It used
   * to be written there first and sent a line later, so anything that stopped
   * the send — the busy guard, most visibly — left the prompt sitting in the
   * box as if you had typed it and changed your mind. The box is where YOU
   * write; it is not a transport for text the plugin already has.
   */
  private async handleSend(opts: { text?: string; wholeWiki?: boolean; skillLabel?: string } = {}) {
    if (this.busy) return;
    // The input is the one door the greyed chips do not cover: you can type a
    // question while an Improve is running and press Enter. Same engine, same
    // rule.
    if (this.plugin.isBusy()) {
      notify('warn', `Busy: ${this.plugin.runningLabel() ?? 'something is running'}. Wait for that to finish.`);
      return;
    }
    const typed = opts.text === undefined;
    const question = (opts.text ?? this.inputEl.value).trim();
    if (!question) return;
    if (typed) this.inputEl.value = '';
    this.autoGrowInput();
    this.lastQuestion = question;
    // One message is enough: the nudge has done its job and should not come
    // back on the next empty panel.
    if (!this.plugin.settings.hasChatted) {
      this.plugin.settings.hasChatted = true;
      void this.plugin.saveSettings();
    }
    this.turns.push({ role: 'user', content: question });
    this.appendUserMessage(question);
    await this.runGeneration(question, false, opts.wholeWiki ?? false, opts.skillLabel);
  }

  // Builds the grounding context for one question, or returns null with a
  // user-facing Notice when there is nothing to ground in. Wiki mode is
  // honest by design: no matching pages means "not in your wiki", not a
  // guess from the model's own knowledge.
  private async buildContext(
    question: string,
    ungrounded = false,
    wholeWiki = false
  ): Promise<{
    systemPrompt: string;
    sourcePath: string;
    sources: { title: string; linkPath: string }[];
    ungrounded?: boolean;
    noPageMatch?: boolean;
  } | null> {
    // Escape hatch (issue #7): the user explicitly asked to bypass grounding
    // and let Gemma answer from its own knowledge. No retrieval, no sources,
    // and the answer is marked ungrounded so the trust model stays intact.
    if (ungrounded) {
      return {
        systemPrompt:
          "Answer the user's question from your own general knowledge. You do NOT have access to " +
          "the user's notes or wiki here — never claim a fact came from them. If you are unsure, " +
          'say so plainly. Be concise. You may use markdown.',
        sourcePath: indexPath(),
        sources: [],
        ungrounded: true,
      };
    }
    if (this.mode === 'wiki') {
      const entries = await readIndexEntries(this.app.vault);
      if (!entries.length) {
        this.appendInfoMessage(
          'Your wiki is empty, so there is nothing to answer from. File something first — ' +
            'nothing is written without your approval.',
          [
            { label: 'Scan a folder', action: 'scan' },
            { label: 'Ingest this note into wiki', action: 'ingest' },
          ]
        );
        return null;
      }
      // A whole-wiki question is not a retrieval problem. Scoring "what
      // connects my pages" against page summaries matches nothing, because the
      // question is about the shape of the collection and not about anything
      // in it — so every page is the right answer to "which pages", and
      // loadPages fills up to the budget and stops.
      const selected = wholeWiki ? entries : scoreEntries(question, entries);
      // Expand one hop through the link graph (issue #14): a page linked to
      // or from a lexical hit often holds the answer even when its own summary
      // didn't share the question's words. Seeds still decide noPageMatch.
      const expanded =
        !wholeWiki && selected.length ? expandByLinks(this.app, selected, entries, 2) : [];
      const retrieved = [...selected, ...expanded];
      const loaded = retrieved.length
        ? await loadPages(this.app.vault, retrieved, this.plugin.budget('chat') * 3)
        : '';
      // Catalog + recent log always ride along: they are small, and they
      // make meta-questions answerable ("what is in my wiki?", "what did
      // I add today?") — pure page retrieval left those as dead ends.
      const catalog = entries.map((e) => `- ${e.title} — ${e.summary}`).join('\n');
      const logTail = await readLogTail(this.app.vault, 12);
      const attachments = await this.readAttachments();
      // One pile. There used to be a second, ranked below this one under a
      // heading that told the model which to believe when they disagreed —
      // needed while saved answers were retrieved, and dead since they stopped
      // being. Everything here derives from a note the user wrote.
      const clampedWiki = clampToTokens(
        (loaded ? `## Relevant pages\n${loaded}\n\n` : '') + attachments.blocks,
        this.plugin.budget('chat')
      );
      if (clampedWiki.truncated) {
        this.appendInfoMessage(
          `Only the first ~${Math.round(this.plugin.budget('chat') / 1000)}k tokens of the retrieved ` +
            'material were sent — the rest was cut to keep one answer fast.'
        );
      }
      return {
        systemPrompt:
          "Use ONLY the material below about the user's personal wiki: " +
          'the catalog (every wiki page with a one-line summary), the recent activity log ' +
          '(dated ingest/answer entries), and ' +
          (wholeWiki
            ? 'the full text of the wiki pages, as many as fit. Work across all of them — this ' +
              'is about the collection, not about one page. '
            : 'the full text of the most relevant pages. ') +
          // The same four cases as note mode, because the bug was the same and
          // fixing only one mode left the other echoing. Asked what a term
          // means, a wiki whose pages name it without defining it could only
          // repeat one of them back.
          //
          // What is genuinely different here is the stake, not the rule. In
          // note mode the note is open beside the answer; here the answer
          // stands for pages you are not looking at, and the Sources row is
          // what you would check it against — so the separation between what
          // your pages say and what a term means has to be visible in the
          // text, or the row implies the whole answer came from them.
          'Never claim your material says something it does not, and never invent detail and ' +
          'present it as the user\'s.\n\n' +
          'If the user asks a question about their own material — what is in it, what they ' +
          'recorded, what connects — answer only from what is below, and say plainly when it ' +
          'does not answer rather than guessing.\n\n' +
          'If they ask what something MEANS — a term, a claim, a concept the pages use — ' +
          'explain it, using ordinary knowledge of the subject. The pages give you the topic, ' +
          'not the only words you may use. Repeating a page\'s own sentence back is not an ' +
          'answer. Keep the two apart in what you write, so it is never unclear which is which: ' +
          'what the pages state, then what it means.\n\n' +
          'If the user asks you to work with the material instead, carry ' +
          'that out from what is here — the instruction comes from the user, so do not look for ' +
          'it inside the pages.\n\n' +
          'If you cannot tell what is being asked — the request is a fragment, a single word, or ' +
          'otherwise unclear — say that you did not follow it and ask for it another way. Do NOT ' +
          'report that the material lacks something when the real problem is that you did not ' +
          'understand the request.\n\n' +
          'Be concise. You may use markdown formatting.\n\n' +
          `## Catalog\n${catalog}\n\n` +
          (logTail ? `## Recent activity log\n${logTail}\n\n` : '') +
          clampedWiki.text,
        sourcePath: indexPath(),
        sources: [
          ...attachments.sources,
          ...(retrieved.length
            ? retrieved.map((e) => ({ title: e.title, linkPath: e.linkPath }))
            : [{ title: 'Wiki index', linkPath: indexPath().replace(/\.md$/, '') }]),
        ],
        // No page matched the question — the answer leans on catalog/log
        // only (good for meta-questions, thin for everything else). Flag it
        // so runGeneration can offer the "ask Gemma directly" hatch below.
        // Only meaningful for a retrieval question. A whole-wiki question that
        // came back thin was not a miss — it had everything there was.
        noPageMatch: !wholeWiki && selected.length === 0,
      };
    }

    const file = this.app.workspace.getActiveFile();
    const attachments = await this.readAttachments();
    if (!file && !attachments.blocks) {
      this.appendInfoMessage(
        'Open a note first, or attach one with the + button — This-note mode needs something to ground in.'
      );
      return null;
    }
    let noteBlock = '';
    const sources: { title: string; linkPath: string }[] = [];
    if (file) {
      const noteContent = await this.app.vault.read(file);
      noteBlock = `## Open note: ${file.basename}\n${noteContent}\n\n`;
      sources.push({ title: file.basename, linkPath: file.path.replace(/\.md$/, '') });
    }
    sources.push(...attachments.sources);
    const clamped = clampToTokens(noteBlock + attachments.blocks, this.plugin.budget('chat'));
    if (clamped.truncated) {
      // Say whose limit this is. "Longer than the model can hold" blamed the
      // model for a cap the plugin sets, and left the reader with nothing to
      // do about it.
      this.appendInfoMessage(
        `Only the first ~${Math.round(this.plugin.budget('chat') / 1000)}k tokens of this note were ` +
          'sent — the rest was cut to keep one answer fast. Raise Context window in settings to ' +
          'send more, or select a section and ask about that.'
      );
    }
    return {
      systemPrompt:
        // Three kinds of request. The prompt learned the first two the hard
        // way and the third was still missing.
        //
        // 1. A question of fact about the note — grounded, and honestly
        //    refused when the note does not answer it.
        // 2. An instruction to work on the note. "Use ONLY the notes" used to
        //    turn this into a lookup: asked to make flashcards, the model went
        //    looking for flashcards IN the note, did not find any, and refused.
        //    Every skill is a transformation, not a lookup.
        // 3. Asking what something MEANS — and this one failed worse than a
        //    refusal. Asked what a line about store-and-forward transmission
        //    meant, the model repeated that line back verbatim: the note
        //    contains the term but not an explanation of it, so under "never
        //    bring in outside knowledge" an echo was the only compliant
        //    answer. Retrieval succeeded and the answer was still useless,
        //    which is worse than saying no, because it looks like an answer.
        //
        // Grounding this panel in a note means the note is the SUBJECT, not
        // the vocabulary the model is allowed. Someone reading their own
        // lecture notes and asking what a term means is asking about the note.
        // What must never happen is misreporting what the note says, or
        // passing off general knowledge as something the note stated — so the
        // rule that survives is attribution, not ignorance.
        //
        // Wiki mode keeps the strict rule: a claim about a body of pages you
        // cannot eyeball is exactly where invented detail does damage, and
        // that is the mode whose Sources row is load-bearing.
        'The note below is what the user is asking about. Answer them properly.\n\n' +
        'Never misreport the note: do not claim it says something it does not, and do not ' +
        'invent detail and present it as theirs.\n\n' +
        'If they ask a question of fact about their own material and the note does not answer ' +
        'it, say so plainly rather than guessing.\n\n' +
        'If they ask what something MEANS — a term, a line, a concept the note uses — explain ' +
        'it properly, using ordinary knowledge of the subject. The note gives you the topic, ' +
        'not the only words you may use. Repeating the note\'s own sentence back is not an ' +
        'answer. Keep the two apart so they are never confused: say what the note states, then ' +
        'explain it.\n\n' +
        'If the user asks you to work with the material — summarise it, turn it into questions ' +
        'or flashcards, list the actions it implies, point out what is unclear — carry that out ' +
        'from what the notes contain. The instruction comes from the user; do not look for it ' +
        'inside the notes.\n\n' +
        'If you cannot tell what is being asked — the request is a fragment, a single word, or ' +
        'otherwise unclear — say that you did not follow it and ask for it another way. Do NOT ' +
        'report that the material lacks something when the real problem is that you did not ' +
        'understand the request.\n\n' +
        'Be concise. You may use markdown formatting.\n\n' +
        clamped.text,
      sourcePath: file?.path ?? 'wiki/index.md',
      sources,
    };
  }

  private async runGeneration(question: string, ungrounded = false, wholeWiki = false, skillLabel?: string) {
    const context = await this.buildContext(question, ungrounded, wholeWiki);
    if (!context) return;

    this.busy = true;
    // Also tell the plugin: one engine, one operation, and a streaming answer
    // is an operation. Without this the chips stayed live through an answer.
    this.plugin.setChatBusy(true);
    this.sendButton.disabled = true;
    this.stopButton.show();

    const { body, row } = this.appendAssistantMessage();
    const typing = this.showTypingIndicator(body);
    const status = body.createDiv({ cls: 'gemma4-chat-status' });

    let conversation: Conversation | undefined;
    let answer = '';
    try {
      const engine = await this.plugin.ensureEngine((text) => status.setText(text));
      status.remove();

      const { SamplerType } = await import('@litert-lm/core');
      conversation = await engine.createConversation({
        preface: {
          messages: [{ role: 'system', content: context.systemPrompt }],
        },
        sessionConfig: {
          samplerParams: { type: SamplerType.GREEDY },
          maxOutputTokens: 1024,
        },
      });
      this.activeConversation = conversation;

      const streamTextEl = body.createDiv({ cls: 'gemma4-chat-stream-text' });
      let firstChunk = true;
      const stream = conversation.sendMessageStreaming(question);
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const content = value?.content;
        let chunk = '';
        if (typeof content === 'string') {
          chunk = content;
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (part.type === 'text' && part.text) chunk += part.text;
          }
        }
        if (chunk) {
          if (firstChunk) {
            typing.remove();
            firstChunk = false;
          }
          answer += chunk;
          streamTextEl.setText(answer);
          this.scrollToBottom();
        }
      }

      // Streaming shows plain text (cheap, no flicker); the finished
      // answer gets one proper markdown render pass.
      typing.remove();
      streamTextEl.remove();
      const rendered = body.createDiv({ cls: 'gemma4-chat-markdown' });
      await MarkdownRenderer.render(this.app, answer, rendered, context.sourcePath, this);

      if (context.ungrounded) {
        // Ungrounded answer: no sources, an explicit warning label so it is
        // never mistaken for a grounded, citable answer.
        const warnRow = body.createDiv({ cls: 'gemma4-chat-sources' });
        warnRow.createSpan({
          cls: 'gemma4-chat-sources-label',
          text: '⚠ Gemma general knowledge — not from your notes',
        });
      } else {
        // Deterministic source attribution: list exactly the notes/pages the
        // answer was grounded in, as clickable links — not left to the model.
        const sourcesRow = body.createDiv({ cls: 'gemma4-chat-sources' });
        sourcesRow.createSpan({ cls: 'gemma4-chat-sources-label', text: 'Sources' });
        for (const src of context.sources) {
          const link = sourcesRow.createEl('a', { cls: 'gemma4-chat-source-link', text: src.title });
          link.addEventListener('click', (evt) => {
            evt.preventDefault();
            void this.app.workspace.openLinkText(src.linkPath, '', false);
          });
        }
      }

      this.turns.push({ role: 'assistant', content: answer, sources: context.ungrounded ? [] : context.sources });
      // Ungrounded answers can't be saved to the wiki — filing model guesses
      // as sourced pages is exactly the pollution the grounding model avoids.
      this.addAssistantActions(row, () => answer, question, context.sources, !context.ungrounded, skillLabel);

      // Issue #7 routing: a grounded wiki answer with no matching page often
      // means "not in your wiki". Offer a per-answer, opt-in hatch to ask
      // Gemma directly — default stays grounded, the escalation is explicit.
      if (context.noPageMatch && !context.ungrounded) {
        const hatch = body.createDiv({ cls: 'gemma4-chat-hatch' });
        const btn = hatch.createEl('button', {
          cls: 'gemma4-chat-hatch-btn',
          text: 'Not in your wiki? Ask Gemma directly (no sources)',
        });
        btn.addEventListener('click', () => {
          if (this.busy) return;
          btn.disabled = true;
          void this.runGeneration(question, true);
        });
      }

      this.scrollToBottom();
    } catch (err) {
      console.error('[gemma4-litert-wiki] chat failed', err);
      typing.remove();
      body.createDiv({
        cls: 'gemma4-chat-error',
        text: `Failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      // Release first, tidy up after. The answer is fully rendered by now, so
      // the panel LOOKS idle — but this ran `await conversation.delete()`
      // before clearing the flags, leaving a window where a press was silently
      // refused because a teardown nobody can see had not finished.
      this.activeConversation = null;
      this.busy = false;
      this.plugin.setChatBusy(false);
      this.sendButton.disabled = false;
      this.stopButton.hide();
      this.inputEl.focus();
      await conversation?.delete().catch(() => {});
    }
  }
}
