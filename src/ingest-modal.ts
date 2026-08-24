import { App, MarkdownRenderer, Modal, Component } from 'obsidian';

// The review gate. Nothing is written to the vault until the user has
// seen the exact page that would be created and clicked Approve — the
// step the reference implementations skipped and their users missed.

export class IngestPreviewModal extends Modal {
  private pageContent: string;
  private pagePath: string;
  private overwriting: boolean;
  private onApprove: () => void;
  private renderHost = new Component();

  constructor(
    app: App,
    pagePath: string,
    pageContent: string,
    overwriting: boolean,
    onApprove: () => void
  ) {
    super(app);
    this.pagePath = pagePath;
    this.pageContent = pageContent;
    this.overwriting = overwriting;
    this.onApprove = onApprove;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('gemma4-ingest-modal');
    contentEl.createEl('h3', { text: 'Review wiki page before writing' });
    contentEl.createDiv({
      cls: 'gemma4-ingest-path',
      text: this.overwriting ? `Will overwrite: ${this.pagePath}` : `Will create: ${this.pagePath}`,
    });

    const preview = contentEl.createDiv({ cls: 'gemma4-ingest-preview' });
    void MarkdownRenderer.render(this.app, this.pageContent, preview, this.pagePath, this.renderHost);

    const buttons = contentEl.createDiv({ cls: 'gemma4-ingest-buttons' });
    const cancel = buttons.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());
    const approve = buttons.createEl('button', { cls: 'mod-cta', text: 'Approve and write' });
    approve.addEventListener('click', () => {
      this.close();
      this.onApprove();
    });
  }

  onClose() {
    this.renderHost.unload();
    this.contentEl.empty();
  }
}
