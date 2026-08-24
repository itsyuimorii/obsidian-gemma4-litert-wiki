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

export interface RelinkProposal {
  pagePath: string;
  title: string;
  related: { title: string; linkPath: string }[];
}

export class RelinkPreviewModal extends Modal {
  private proposals: RelinkProposal[];
  private onApprove: () => void;

  constructor(app: App, proposals: RelinkProposal[], onApprove: () => void) {
    super(app);
    this.proposals = proposals;
    this.onApprove = onApprove;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('gemma4-ingest-modal');
    contentEl.createEl('h3', { text: 'Review related-link additions' });
    contentEl.createDiv({
      cls: 'gemma4-ingest-path',
      text: `${this.proposals.length} pages will gain a Related section. Nothing else is changed.`,
    });
    const list = contentEl.createEl('ul', { cls: 'gemma4-relink-list' });
    for (const prop of this.proposals) {
      const li = list.createEl('li');
      li.createSpan({ cls: 'gemma4-relink-page', text: prop.title });
      li.createSpan({ text: ' \u2192 ' });
      li.createSpan({ text: prop.related.map((r) => r.title).join(', ') });
    }
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
    this.contentEl.empty();
  }
}
