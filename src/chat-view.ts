import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import type { Conversation } from '@litert-lm/core';
import type LiteRtSpikePlugin from './main';

// Chat with the currently active note, entirely local. This is the
// "narrow" version of Query from the wiki roadmap — grounded in one open
// note instead of an index-selected set of wiki pages, because the wiki
// layer (ingest) doesn't exist yet. Once ingest is built, this view's
// context source swaps from "the active file" to "index.md + selected
// pages" without changing the UI shell.

export const VIEW_TYPE_CHAT = 'gemma4-litert-wiki-chat-view';

// Only the read-and-answer-about-one-note path has been benchmarked
// (up to ~700 words / ~4700 chars with no quality drop-off). This cap is
// a deliberately conservative product default, not the model's real
// ceiling — see the grammar-fix command's looser cap for stress-testing.
const MAX_NOTE_CHARS = 20000;

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export class ChatView extends ItemView {
  private plugin: LiteRtSpikePlugin;
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private noteLabelEl!: HTMLElement;
  private history: ChatTurn[] = [];
  private busy = false;

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
    container.addClass('gemma4-chat-container');

    this.noteLabelEl = container.createDiv({ cls: 'gemma4-chat-note-label' });
    this.updateNoteLabel();

    this.messagesEl = container.createDiv({ cls: 'gemma4-chat-messages' });

    const inputRow = container.createDiv({ cls: 'gemma4-chat-input-row' });
    this.inputEl = inputRow.createEl('textarea', {
      cls: 'gemma4-chat-input',
      attr: { placeholder: 'Ask about the currently open note…', rows: '3' },
    });
    this.sendButton = inputRow.createEl('button', { cls: 'gemma4-chat-send', text: 'Send' });

    this.sendButton.addEventListener('click', () => void this.handleSend());
    this.inputEl.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' && !evt.shiftKey) {
        evt.preventDefault();
        void this.handleSend();
      }
    });

    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.updateNoteLabel()));
  }

  private updateNoteLabel() {
    const file = this.app.workspace.getActiveFile();
    this.noteLabelEl.setText(file ? `Chatting about: ${file.basename}` : 'Open a note to chat about it.');
  }

  private appendMessage(role: 'user' | 'assistant'): HTMLElement {
    const row = this.messagesEl.createDiv({ cls: `gemma4-chat-msg gemma4-chat-msg-${role}` });
    row.createDiv({ cls: 'gemma4-chat-msg-role', text: role === 'user' ? 'You' : 'Gemma' });
    const body = row.createDiv({ cls: 'gemma4-chat-msg-body' });
    this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight });
    return body;
  }

  private async handleSend() {
    if (this.busy) return;
    const question = this.inputEl.value.trim();
    if (!question) return;

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
    this.inputEl.value = '';
    this.appendMessage('user').setText(question);
    const answerBody = this.appendMessage('assistant');
    answerBody.setText('Loading model…');
    this.history.push({ role: 'user', content: question });

    let conversation: Conversation | undefined;
    try {
      const engine = await this.plugin.ensureEngine((text) => answerBody.setText(text));

      const { SamplerType } = await import('@litert-lm/core');
      conversation = await engine.createConversation({
        preface: {
          messages: [
            {
              role: 'system',
              content:
                `Answer the user's question using ONLY the note content below, titled "${file.basename}". ` +
                'If the answer is not in the note, say so plainly instead of guessing or using outside ' +
                'knowledge. Be concise.\n\n---\n' +
                noteContent,
            },
          ],
        },
        sessionConfig: {
          samplerParams: { type: SamplerType.GREEDY },
          maxOutputTokens: 1024,
        },
      });

      answerBody.setText('');
      let answer = '';
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
          answer += chunk;
          answerBody.setText(answer);
          this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight });
        }
      }
      this.history.push({ role: 'assistant', content: answer });
    } catch (err) {
      console.error('[gemma4-litert-wiki] chat failed', err);
      answerBody.setText(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await conversation?.delete().catch(() => {});
      this.busy = false;
      this.sendButton.disabled = false;
    }
  }
}
