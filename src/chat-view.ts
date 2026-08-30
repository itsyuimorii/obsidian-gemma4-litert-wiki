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
} from 'obsidian';
import type { Conversation } from '@litert-lm/core';
import type LiteRtSpikePlugin from './main';
import {
  answerPagePath,
  appendLog,
  buildAnswerPage,
  buildChatTranscript,
  chatTranscriptPath,
  clampToTokens,
  ensureWikiScaffold,
  expandByLinks,
  getIngestedSourcePaths,
  indexPath,
  loadPages,
  readIndexEntries,
  readLogTail,
  readSkills,
  scoreEntries,
  upsertIndexEntry,
  writeWikiPage,
  type ChatTurnRecord,
} from './wiki-store';
import { IngestPreviewModal } from './ingest-modal';
import { notify } from './notify';

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
  private async renderEmptyState() {
    const el = this.emptyStateEl;
    if (!el) return;
    el.empty();
    const icon = el.createDiv({ cls: 'gemma4-chat-empty-icon' });
    setIcon(icon, 'gemma-wiki-logo');

    const wikiEmpty =
      this.mode === 'wiki' && (await readIndexEntries(this.app.vault)).length === 0;

    if (wikiEmpty) {
      el.createDiv({ cls: 'gemma4-chat-empty-title', text: 'Your wiki is empty' });
      el.createDiv({
        cls: 'gemma4-chat-empty-hint',
        text: 'Wiki mode answers from pages you have filed. File some first:',
      });
      const actions = el.createDiv({ cls: 'gemma4-chat-empty-actions' });
      const batch = actions.createEl('button', {
        cls: 'gemma4-chat-empty-action mod-cta',
        text: 'Scan a folder',
      });
      setTooltip(batch, 'Draft a page for every new or changed note in the folders you named in settings');
      batch.addEventListener('click', () => void this.plugin.scanAndReviewIngest());

      const one = actions.createEl('button', { cls: 'gemma4-chat-empty-action', text: 'File this note' });
      setTooltip(one, 'Draft one page from the note you have open');
      one.addEventListener('click', () => void this.plugin.ingestActiveNote());

      el.createDiv({
        cls: 'gemma4-chat-empty-hint',
        text: 'Nothing is written until you approve it. Or switch to This note above and ask about the open note right now.',
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
  }

  // Suggestion chips live above the input, permanently — they used to sit
  // in the empty state and vanished after the first question. Note-mode
  // only: canned wiki-mode questions would fight the lexical retrieval.
  private renderSuggestions() {
    if (!this.suggestionRow) return;
    this.suggestionRow.empty();
    this.suggestionRow.show();
    // Short labels; the full question lives in the prompt. Chips swap per
    // mode instead of hiding — wiki mode gets prompts that are reliable
    // against catalog+log grounding. The Improve write op routes straight
    // to the preview-gated editor and never enters retrieval.
    const ask = (q: string) => {
      this.inputEl.value = q;
      void this.handleSend();
    };
    const items: { label: string; run: () => void; write?: boolean }[] =
      this.mode === 'note'
        ? [
            { label: 'Summarize', run: () => ask('Summarize this note') },
            { label: 'Key points', run: () => ask('What are the key points?') },
            { label: 'Formatting', write: true, run: () => void this.plugin.improveActiveNote() },
          ]
        : [
            {
              label: "What's in my wiki?",
              run: () => ask('What is in my wiki? Give a short overview grouped by topic.'),
            },
            {
              label: 'Added recently',
              run: () => ask('What did I add to the wiki recently, based on the activity log?'),
            },
            {
              label: 'Find connections',
              run: () =>
                ask('What connections or common themes link the pages in my wiki? Cite the pages.'),
            },
          ];
    for (const item of items) {
      const chip = this.suggestionRow.createEl('button', {
        cls: item.write ? 'gemma4-chat-suggestion gemma4-chat-suggestion-write' : 'gemma4-chat-suggestion',
        text: item.label,
      });
      if (item.write) setTooltip(chip, 'Edits this note — you review before anything is written');
      chip.addEventListener('click', item.run);
    }
  }

  // Persist the thread as a vault-native markdown file (Copilot-style):
  // frontmatter for Dataview/Query reuse, Q/A blocks with sources. Goes
  // through the same review-gated write path as saved answers.
  private async saveConversation() {
    if (!this.turns.length) {
      notify('noop', 'Nothing to save yet — ask something first.');
      return;
    }
    const firstQ = this.turns.find((t) => t.role === 'user')?.content ?? 'chat';
    const stamp = window.moment().format('YYYY-MM-DD-HHmmss');
    const pagePath = chatTranscriptPath(firstQ, stamp);
    const content = buildChatTranscript(this.turns, this.mode, stamp.slice(0, 10));
    new IngestPreviewModal(this.app, pagePath, content, false, () => {
      void (async () => {
        await ensureWikiScaffold(this.app.vault);
        await writeWikiPage(this.app.vault, pagePath, content);
        // Index it too (issue #17) — without an index entry, Wiki-mode
        // retrieval and lint can never see the saved transcript, so it was
        // effectively write-only.
        await upsertIndexEntry(this.app.vault, pagePath, firstQ.slice(0, 80), `Saved ${this.mode} chat: ${firstQ.slice(0, 100)}`);
        await appendLog(this.app.vault, 'chat', firstQ.slice(0, 60));
        notify('done', `Conversation saved: ${pagePath}`);
      })();
    }).open();
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
    const saveConvBtn = headerActions.createEl('button', {
      cls: 'gemma4-chat-clear',
      attr: { 'aria-label': 'Save conversation to wiki' },
    });
    setIcon(saveConvBtn, 'save');
    setTooltip(saveConvBtn, 'Save conversation to wiki');
    saveConvBtn.addEventListener('click', () => void this.saveConversation());

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
    const SKILLS: { label: string; icon: string; prompt: string; mode?: 'note' | 'wiki' }[] = [
      {
        label: 'Quiz me',
        icon: 'graduation-cap',
        prompt:
          'Create 5 practice questions that test understanding of this material. Number each ' +
          'question and put its answer in bold directly below it.',
      },
      {
        label: 'Make flashcards',
        icon: 'layers',
        prompt:
          'Create 8 flashcards from this material. Format each as **Q:** question then **A:** ' +
          'answer on the next line, with a blank line between cards.',
      },
      {
        label: 'Find gaps',
        icon: 'search',
        prompt:
          'What important questions does this material raise but not answer? List the gaps and ' +
          'why each matters.',
      },
      {
        label: 'Digest recent wiki activity',
        icon: 'history',
        // Needs the catalog + log, which only Wiki mode carries — running
        // it in This-note mode produced "I do not have access to an
        // activity log". The skill switches mode itself.
        mode: 'wiki',
        prompt:
          'Based on the activity log and catalog, summarize what was added to the wiki recently, ' +
          'grouped by topic.',
      },
    ];

    // Custom skills (issue #4) live as files in <wiki>/skills/ — "config as a
    // note", read fresh on each menu open so adding or editing a skill file
    // takes effect without reloading. Built-ins first, then the user's, in
    // filename order.
    skillsBtn.addEventListener('click', (evt) => {
      void (async () => {
        const custom = await readSkills(this.app.vault);
        const menu = new Menu();
        for (const skill of [...SKILLS, ...custom]) {
          menu.addItem((item) =>
            item
              .setTitle(skill.label)
              .setIcon(skill.icon)
              .onClick(() => {
                if (skill.mode && skill.mode !== this.mode) this.setMode(skill.mode);
                this.inputEl.value = skill.prompt;
                void this.handleSend();
              })
          );
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
  private appendInfoMessage(text: string) {
    this.emptyStateEl.hide();
    const row = this.messagesEl.createDiv({ cls: 'gemma4-chat-row gemma4-chat-row-assistant' });
    row.createDiv({ cls: 'gemma4-chat-info', text });
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
    allowSave = true
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
    setTooltip(saveBtn, 'Save answer to wiki');
    saveBtn.addEventListener('click', () => {
      const answer = getAnswer();
      const pagePath = answerPagePath(question);
      const pageContent = buildAnswerPage(question, answer, sources);
      const overwriting = !!this.app.vault.getAbstractFileByPath(pagePath);
      new IngestPreviewModal(this.app, pagePath, pageContent, overwriting, () => {
        void (async () => {
          await ensureWikiScaffold(this.app.vault);
          await writeWikiPage(this.app.vault, pagePath, pageContent);
          const summary = answer.trim().split(/(?<=[.!?])\s/)[0]?.slice(0, 140) ?? question;
          await upsertIndexEntry(this.app.vault, pagePath, question, summary);
          await appendLog(this.app.vault, 'answer', question);
          notify('done', `Saved to wiki: ${pagePath}`);
        })();
      }).open();
    });
  }

  private scrollToBottom() {
    this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight });
  }

  private async handleSend() {
    if (this.busy) return;
    const question = this.inputEl.value.trim();
    if (!question) return;
    this.inputEl.value = '';
    this.autoGrowInput();
    this.lastQuestion = question;
    this.turns.push({ role: 'user', content: question });
    this.appendUserMessage(question);
    await this.runGeneration(question);
  }

  // Builds the grounding context for one question, or returns null with a
  // user-facing Notice when there is nothing to ground in. Wiki mode is
  // honest by design: no matching pages means "not in your wiki", not a
  // guess from the model's own knowledge.
  private async buildContext(
    question: string,
    ungrounded = false
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
          'Your wiki is empty — run "Ingest active note into wiki" on a few notes first, then ask again.'
        );
        return null;
      }
      const selected = scoreEntries(question, entries);
      // Expand one hop through the link graph (issue #14): a page linked to
      // or from a lexical hit often holds the answer even when its own summary
      // didn't share the question's words. Seeds still decide noPageMatch.
      const expanded = selected.length ? expandByLinks(this.app, selected, entries, 2) : [];
      const retrieved = [...selected, ...expanded];
      const pages = retrieved.length
        ? await loadPages(this.app.vault, retrieved, this.plugin.budget('chat') * 3)
        : '';
      // Catalog + recent log always ride along: they are small, and they
      // make meta-questions answerable ("what is in my wiki?", "what did
      // I add today?") — pure page retrieval left those as dead ends.
      const catalog = entries.map((e) => `- ${e.title} — ${e.summary}`).join('\n');
      const logTail = await readLogTail(this.app.vault, 12);
      const attachments = await this.readAttachments();
      const clampedWiki = clampToTokens(
        (pages ? `## Relevant pages\n${pages}\n\n` : '') + attachments.blocks,
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
          "You answer questions about the user's personal wiki. Use ONLY the material below: " +
          'the catalog (every wiki page with a one-line summary), the recent activity log ' +
          '(dated ingest/answer entries), and the full text of the most relevant pages. If the ' +
          'answer is not in this material, say so plainly instead of guessing. Be concise. You ' +
          'may use markdown formatting.\n\n' +
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
        noPageMatch: selected.length === 0,
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
        "Answer the user's question using ONLY the notes below. If the answer is not in them, " +
        'say so plainly instead of guessing or using outside knowledge. Be concise. You may use ' +
        'markdown formatting.\n\n' +
        clamped.text,
      sourcePath: file?.path ?? 'wiki/index.md',
      sources,
    };
  }

  private async runGeneration(question: string, ungrounded = false) {
    const context = await this.buildContext(question, ungrounded);
    if (!context) return;

    this.busy = true;
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
      this.addAssistantActions(row, () => answer, question, context.sources, !context.ungrounded);

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
      this.activeConversation = null;
      await conversation?.delete().catch(() => {});
      this.busy = false;
      this.sendButton.disabled = false;
      this.stopButton.hide();
      this.inputEl.focus();
    }
  }
}
