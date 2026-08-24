import { ItemView, MarkdownRenderer, Notice, setIcon, WorkspaceLeaf } from 'obsidian';
import type { Conversation } from '@litert-lm/core';
import type LiteRtSpikePlugin from './main';

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
    setIcon(titleIcon, 'sparkles');
    titleRow.createSpan({ cls: 'gemma4-chat-title', text: 'Gemma · local' });
    this.noteChipEl = header.createDiv({ cls: 'gemma4-chat-note-chip' });
    this.updateNoteChip();

    // Message list with an empty-state hint shown until the first send.
    this.messagesEl = container.createDiv({ cls: 'gemma4-chat-messages' });
    this.emptyStateEl = this.messagesEl.createDiv({ cls: 'gemma4-chat-empty' });
    const emptyIcon = this.emptyStateEl.createDiv({ cls: 'gemma4-chat-empty-icon' });
    setIcon(emptyIcon, 'message-circle');
    this.emptyStateEl.createDiv({
      cls: 'gemma4-chat-empty-title',
      text: 'Ask about the open note',
    });
    this.emptyStateEl.createDiv({
      cls: 'gemma4-chat-empty-hint',
      text: 'Answers come from a model running entirely inside Obsidian — nothing leaves your machine. Try "summarize this note" or "what are the key points?"',
    });

    // Input area: textarea + send/stop buttons.
    const inputWrap = container.createDiv({ cls: 'gemma4-chat-input-wrap' });
    this.inputEl = inputWrap.createEl('textarea', {
      cls: 'gemma4-chat-input',
      attr: { placeholder: 'Ask about this note… (Enter to send)', rows: '2' },
    });
    const buttonRow = inputWrap.createDiv({ cls: 'gemma4-chat-button-row' });
    this.stopButton = buttonRow.createEl('button', { cls: 'gemma4-chat-stop' });
    setIcon(this.stopButton, 'square');
    this.stopButton.createSpan({ text: 'Stop' });
    this.stopButton.hide();
    this.sendButton = buttonRow.createEl('button', { cls: 'gemma4-chat-send mod-cta' });
    setIcon(this.sendButton, 'arrow-up');

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

  private updateNoteChip() {
    const file = this.app.workspace.getActiveFile();
    this.noteChipEl.empty();
    const icon = this.noteChipEl.createSpan({ cls: 'gemma4-chat-note-chip-icon' });
    setIcon(icon, 'file-text');
    this.noteChipEl.createSpan({
      text: file ? file.basename : 'No note open',
    });
    this.noteChipEl.toggleClass('gemma4-chat-note-chip-none', !file);
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

  private showTypingIndicator(parent: HTMLElement): HTMLElement {
    const dots = parent.createDiv({ cls: 'gemma4-chat-typing' });
    for (let i = 0; i < 3; i++) dots.createSpan({ cls: 'gemma4-chat-typing-dot' });
    return dots;
  }

  private addAssistantActions(row: HTMLElement, getAnswer: () => string) {
    const actions = row.createDiv({ cls: 'gemma4-chat-actions' });

    const copyBtn = actions.createEl('button', {
      cls: 'gemma4-chat-action clickable-icon',
      attr: { 'aria-label': 'Copy answer' },
    });
    setIcon(copyBtn, 'copy');
    copyBtn.addEventListener('click', () => {
      void navigator.clipboard.writeText(getAnswer());
      new Notice('Copied.');
    });

    const regenBtn = actions.createEl('button', {
      cls: 'gemma4-chat-action clickable-icon',
      attr: { 'aria-label': 'Regenerate' },
    });
    setIcon(regenBtn, 'refresh-cw');
    regenBtn.addEventListener('click', () => {
      if (this.busy || !this.lastQuestion) return;
      row.remove();
      void this.runGeneration(this.lastQuestion);
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
    this.lastQuestion = question;
    this.appendUserMessage(question);
    await this.runGeneration(question);
  }

  private async runGeneration(question: string) {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice('Open a note first — this chats about the currently active note.');
      return;
    }

    const noteContent = await this.app.vault.read(file);
    if (noteContent.length > MAX_NOTE_CHARS) {
      new Notice(
        `"${file.basename}" is ${noteContent.length} chars, over the ${MAX_NOTE_CHARS} limit for this feature right now. Try a shorter note.`,
        8000
      );
      return;
    }

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
          messages: [
            {
              role: 'system',
              content:
                `Answer the user's question using ONLY the note content below, titled "${file.basename}". ` +
                'If the answer is not in the note, say so plainly instead of guessing or using outside ' +
                'knowledge. Be concise. You may use markdown formatting.\n\n---\n' +
                noteContent,
            },
          ],
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
      await MarkdownRenderer.render(this.app, answer, rendered, file.path, this);
      this.addAssistantActions(row, () => answer);
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
