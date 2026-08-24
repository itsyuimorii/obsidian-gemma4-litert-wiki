import {
  App,
  FuzzySuggestModal,
  ItemView,
  Menu,
  MarkdownRenderer,
  Notice,
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
  ensureWikiScaffold,
  getIngestedSourcePaths,
  loadPages,
  readIndexEntries,
  readLogTail,
  scoreEntries,
  upsertIndexEntry,
  writeWikiPage,
} from './wiki-store';
import { IngestPreviewModal } from './ingest-modal';

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

// Only the read-and-answer-about-one-note path has been benchmarked
// (up to ~700 words with no quality drop-off). Conservative product
// default, not the model's real ceiling.
const MAX_NOTE_CHARS = 20000;

export class ChatView extends ItemView {
  private plugin: LiteRtSpikePlugin;
  private messagesEl!: HTMLElement;
  private emptyStateEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private noteChipEl!: HTMLElement;
  private busy = false;
  private lastQuestion: string | null = null;
  private activeConversation: Conversation | null = null;
  private mode: 'note' | 'wiki' = 'note';
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
    const emptyIcon = this.emptyStateEl.createDiv({ cls: 'gemma4-chat-empty-icon' });
    setIcon(emptyIcon, 'message-circle');
    this.emptyStateEl.createDiv({
      cls: 'gemma4-chat-empty-title',
      text: 'Ask about the open note',
    });
    this.emptyStateEl.createDiv({
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
    if (this.mode !== 'note') {
      this.suggestionRow.hide();
      return;
    }
    this.suggestionRow.show();
    // Read ops answer in the thread; the Improve write op routes straight
    // to the plugin's preview-gated editor — it never enters retrieval,
    // which is what mis-routed action-style inputs before.
    const ask = (q: string) => {
      this.inputEl.value = q;
      void this.handleSend();
    };
    const items: { label: string; run: () => void; write?: boolean }[] = [
      { label: 'Summarize this note', run: () => ask('Summarize this note') },
      { label: 'What are the key points?', run: () => ask('What are the key points?') },
      { label: '\u2728 Improve formatting', write: true, run: () => void this.plugin.improveActiveNote() },
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

  private clearChat() {
    if (this.busy) this.activeConversation?.cancel();
    this.lastQuestion = null;
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
    return 'message-circle';
  }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('gemma4-chat');

    // Header: title row + context chip showing which note we're grounded in.
    const header = container.createDiv({ cls: 'gemma4-chat-header' });
    const titleRow = header.createDiv({ cls: 'gemma4-chat-title-row' });
    const titleIcon = titleRow.createSpan({ cls: 'gemma4-chat-title-icon' });
    setIcon(titleIcon, 'bot');
    titleRow.createSpan({ cls: 'gemma4-chat-title', text: 'Gemma' });
    titleRow.createSpan({ cls: 'gemma4-chat-title-badge', text: 'local' });
    const clearBtn = titleRow.createEl('button', {
      cls: 'gemma4-chat-clear',
      attr: { 'aria-label': 'Clear chat' },
    });
    setIcon(clearBtn, 'rotate-ccw');
    setTooltip(clearBtn, 'Clear chat');
    clearBtn.addEventListener('click', () => this.clearChat());

    // Mode toggle: "Note" chats about the open note; "Wiki" retrieves
    // from index.md + ingested pages (the real Karpathy Query path).
    // Rendered as shadcn-style pills on one aligned row with the context chip.
    const controls = header.createDiv({ cls: 'gemma4-chat-header-controls' });
    const modeRow = controls.createDiv({ cls: 'gemma4-chat-mode-row' });
    // "This note", not "Note": users repeatedly read "Note" as "search my
    // notes" and were confused when it only saw the open file.
    const noteBtn = modeRow.createEl('button', { cls: 'gemma4-chat-mode-btn', text: 'This note' });
    const wikiBtn = modeRow.createEl('button', { cls: 'gemma4-chat-mode-btn', text: 'Wiki' });
    this.modeButtons = { note: noteBtn, wiki: wikiBtn };
    noteBtn.addEventListener('click', () => this.setMode('note'));
    wikiBtn.addEventListener('click', () => this.setMode('wiki'));

    this.noteChipEl = controls.createDiv({ cls: 'gemma4-chat-note-chip' });
    this.setMode('note');

    // Message list with an empty-state hint shown until the first send.
    this.messagesEl = container.createDiv({ cls: 'gemma4-chat-messages' });
    this.buildEmptyState();

    // Input area: persistent suggestion chips + textarea + send/stop buttons.
    const inputWrap = container.createDiv({ cls: 'gemma4-chat-input-wrap' });
    this.contextRow = inputWrap.createDiv({ cls: 'gemma4-chat-context-row' });
    this.contextRow.hide();
    this.suggestionRow = inputWrap.createDiv({ cls: 'gemma4-chat-suggestion-row' });
    this.renderSuggestions();
    this.inputEl = inputWrap.createEl('textarea', {
      cls: 'gemma4-chat-input',
      attr: { placeholder: 'Ask about this note… (Enter to send)', rows: '2' },
    });
    const buttonRow = inputWrap.createDiv({ cls: 'gemma4-chat-button-row' });

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
    skillsBtn.addEventListener('click', (evt) => {
      const menu = new Menu();
      for (const skill of SKILLS) {
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
    sources: { title: string; linkPath: string }[]
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
      new Notice('Copied.');
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
    // ingest — preview first, nothing written without approval.
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
          new Notice(`Saved to wiki: ${pagePath}`, 3000);
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
    this.appendUserMessage(question);
    await this.runGeneration(question);
  }

  // Builds the grounding context for one question, or returns null with a
  // user-facing Notice when there is nothing to ground in. Wiki mode is
  // honest by design: no matching pages means "not in your wiki", not a
  // guess from the model's own knowledge.
  private async buildContext(
    question: string
  ): Promise<{ systemPrompt: string; sourcePath: string; sources: { title: string; linkPath: string }[] } | null> {
    if (this.mode === 'wiki') {
      const entries = await readIndexEntries(this.app.vault);
      if (!entries.length) {
        this.appendInfoMessage(
          'Your wiki is empty — run "Ingest active note into wiki" on a few notes first, then ask again.'
        );
        return null;
      }
      const selected = scoreEntries(question, entries);
      const pages = selected.length
        ? await loadPages(this.app.vault, selected, MAX_NOTE_CHARS)
        : '';
      // Catalog + recent log always ride along: they are small, and they
      // make meta-questions answerable ("what is in my wiki?", "what did
      // I add today?") — pure page retrieval left those as dead ends.
      const catalog = entries.map((e) => `- ${e.title} — ${e.summary}`).join('\n');
      const logTail = await readLogTail(this.app.vault, 12);
      const attachments = await this.readAttachments();
      return {
        systemPrompt:
          "You answer questions about the user's personal wiki. Use ONLY the material below: " +
          'the catalog (every wiki page with a one-line summary), the recent activity log ' +
          '(dated ingest/answer entries), and the full text of the most relevant pages. If the ' +
          'answer is not in this material, say so plainly instead of guessing. Be concise. You ' +
          'may use markdown formatting.\n\n' +
          `## Catalog\n${catalog}\n\n` +
          (logTail ? `## Recent activity log\n${logTail}\n\n` : '') +
          (pages ? `## Relevant pages\n${pages}\n\n` : '') +
          attachments.blocks,
        sourcePath: 'wiki/index.md',
        sources: [
          ...attachments.sources,
          ...(selected.length
            ? selected.map((e) => ({ title: e.title, linkPath: e.linkPath }))
            : [{ title: 'Wiki index', linkPath: 'wiki/index' }]),
        ],
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
      if (noteContent.length > MAX_NOTE_CHARS) {
        this.appendInfoMessage(
          `"${file.basename}" is ${noteContent.length} chars, over the ${MAX_NOTE_CHARS} limit for this feature right now. Try a shorter note.`
        );
        return null;
      }
      noteBlock = `## Open note: ${file.basename}\n${noteContent}\n\n`;
      sources.push({ title: file.basename, linkPath: file.path.replace(/\.md$/, '') });
    }
    sources.push(...attachments.sources);
    return {
      systemPrompt:
        "Answer the user's question using ONLY the notes below. If the answer is not in them, " +
        'say so plainly instead of guessing or using outside knowledge. Be concise. You may use ' +
        'markdown formatting.\n\n' +
        noteBlock +
        attachments.blocks,
      sourcePath: file?.path ?? 'wiki/index.md',
      sources,
    };
  }

  private async runGeneration(question: string) {
    const context = await this.buildContext(question);
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

      this.addAssistantActions(row, () => answer, question, context.sources);
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
