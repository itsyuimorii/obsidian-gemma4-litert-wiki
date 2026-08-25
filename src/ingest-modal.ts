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

// Issue #6: preview gate for the This-note "suggest tags & links" write
// action. Lists exactly what will be added to the note — tags merged into
// frontmatter, wiki links appended as a Related section — before any write.
export class SuggestTagsLinksModal extends Modal {
  private notePath: string;
  private tags: string[];
  private links: { title: string; linkPath: string }[];
  private onApprove: () => void;

  constructor(
    app: App,
    notePath: string,
    tags: string[],
    links: { title: string; linkPath: string }[],
    onApprove: () => void
  ) {
    super(app);
    this.notePath = notePath;
    this.tags = tags;
    this.links = links;
    this.onApprove = onApprove;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('gemma4-ingest-modal');
    contentEl.createEl('h3', { text: 'Review tags & links before writing' });
    contentEl.createDiv({
      cls: 'gemma4-ingest-path',
      text: `Will edit: ${this.notePath} — merges tags into frontmatter, appends a Related section. Nothing else changes.`,
    });

    if (this.tags.length) {
      contentEl.createEl('div', { cls: 'gemma4-relink-page', text: 'Tags to add' });
      contentEl.createDiv({ text: this.tags.map((t) => `#${t}`).join('  ') });
    }
    if (this.links.length) {
      contentEl.createEl('div', { cls: 'gemma4-relink-page', text: 'Links to add' });
      contentEl.createDiv({ text: this.links.map((l) => `[[${l.title}]]`).join('  ') });
    }
    if (!this.tags.length && !this.links.length) {
      contentEl.createDiv({ text: 'Nothing to suggest — no new tags and no related pages found.' });
    }

    const buttons = contentEl.createDiv({ cls: 'gemma4-ingest-buttons' });
    const cancel = buttons.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());
    if (this.tags.length || this.links.length) {
      const approve = buttons.createEl('button', { cls: 'mod-cta', text: 'Approve and write' });
      approve.addEventListener('click', () => {
        this.close();
        this.onApprove();
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// First-run gate before the 2.97 GB download. Explicit consent (no
// surprise multi-GB pull), stating the real costs: size, disk headroom,
// one-time, offline after. onConfirm runs the resumable download.
export class OnboardingModal extends Modal {
  private resumeBytes: number;
  private onResult: (confirmed: boolean) => void;
  private decided = false;

  constructor(app: App, resumeBytes: number, onResult: (confirmed: boolean) => void) {
    super(app);
    this.resumeBytes = resumeBytes;
    this.onResult = onResult;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('gemma4-onboarding');
    contentEl.createEl('h3', { text: 'Download the local model' });

    const resuming = this.resumeBytes > 0;
    contentEl.createEl('p', {
      text: resuming
        ? `A partial download of ${(this.resumeBytes / 1e9).toFixed(2)} GB is on disk — this will resume from there.`
        : 'Gemma Wiki is completely free — no API key, no subscription, no usage fees, ever. The model runs entirely on your machine, so ingest and chat as much as you want. It downloads once, then works fully offline.',
    });

    const list = contentEl.createEl('ul', { cls: 'gemma4-onboarding-list' });
    list.createEl('li', { text: 'Size: ~2.97 GB, downloaded one time and cached on disk.' });
    list.createEl('li', { text: 'Free space: keep ~5 GB free for the download and its temporary file.' });
    list.createEl('li', { text: 'Runs on your GPU via WebGPU — desktop only, no cloud, no API key.' });
    list.createEl('li', { text: 'If the download is interrupted, run it again — it resumes where it stopped.' });

    const buttons = contentEl.createDiv({ cls: 'gemma4-ingest-buttons' });
    const cancel = buttons.createEl('button', { text: 'Not now' });
    cancel.addEventListener('click', () => this.close());
    const confirm = buttons.createEl('button', {
      cls: 'mod-cta',
      text: resuming ? 'Resume download' : 'Download model',
    });
    confirm.addEventListener('click', () => {
      this.decided = true;
      this.close();
      this.onResult(true);
    });
  }

  onClose() {
    // Closing any other way (Esc, backdrop, Not now) counts as declining.
    if (!this.decided) this.onResult(false);
    this.contentEl.empty();
  }
}
