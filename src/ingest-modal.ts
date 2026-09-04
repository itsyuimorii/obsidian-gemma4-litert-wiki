import { App, MarkdownRenderer, Modal, Component, setIcon } from 'obsidian';

// A small yes/no gate. Resolves true if the user confirms, false otherwise
// (including closing the modal). Used e.g. when a note is already ingested and
// unchanged, to let the user re-ingest anyway instead of silently skipping.
export class ConfirmModal extends Modal {
  private opts: { title: string; body: string; confirmText: string; onResult: (ok: boolean) => void };
  private decided = false;

  constructor(app: App, opts: { title: string; body: string; confirmText: string; onResult: (ok: boolean) => void }) {
    super(app);
    this.opts = opts;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: this.opts.title });
    // pre-line so multi-line bodies (e.g. the retag per-page change list)
    // keep their line breaks; the class caps height and scrolls.
    contentEl.createDiv({ cls: 'gemma4-confirm-body', text: this.opts.body });
    const buttons = contentEl.createDiv({ cls: 'gemma4-ingest-buttons' });
    const cancel = buttons.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());
    const ok = buttons.createEl('button', { cls: 'mod-cta', text: this.opts.confirmText });
    ok.addEventListener('click', () => {
      this.decided = true;
      this.opts.onResult(true);
      this.close();
    });
  }

  onClose() {
    if (!this.decided) this.opts.onResult(false);
    this.contentEl.empty();
  }
}

// The review gate. Nothing is written to the vault until the user has
// seen the exact page that would be created and clicked Approve — the
// step the reference implementations skipped and their users missed.

export class IngestPreviewModal extends Modal {
  private pageContent: string;
  private pagePath: string;
  private overwriting: boolean;
  private onApprove: () => void;
  private heading: string;
  private overwriteWarning?: string;
  private onDismiss?: () => void;
  private approved = false;
  private renderHost = new Component();

  constructor(
    app: App,
    pagePath: string,
    pageContent: string,
    overwriting: boolean,
    onApprove: () => void,
    heading = 'Review wiki page before writing',
    opts: {
      /**
       * What an overwrite costs, in the words of the file being overwritten.
       * It used to be one hard-coded sentence about cards being rebuilt from
       * their note, which appeared over schema.md — a file that is nobody's
       * build output and where the sentence was simply false.
       */
      overwriteWarning?: string;
      /** Called when the dialog closes without approving. */
      onDismiss?: () => void;
    } = {}
  ) {
    super(app);
    this.pagePath = pagePath;
    this.pageContent = pageContent;
    this.overwriting = overwriting;
    this.onApprove = onApprove;
    this.heading = heading;
    this.overwriteWarning = opts.overwriteWarning;
    this.onDismiss = opts.onDismiss;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('gemma4-ingest-modal');
    // The heading used to be hard-coded to "Review wiki page before writing",
    // which was wrong for Improve: that path previews the user's OWN note, so
    // the dialog announced a wiki page directly above a line reading
    // "Will overwrite: my-note.md".
    contentEl.createEl('h3', { text: this.heading });
    contentEl.createDiv({
      cls: 'gemma4-ingest-path',
      text: this.overwriting ? `Will overwrite: ${this.pagePath}` : `Will create: ${this.pagePath}`,
    });
    // "Will overwrite" names the file and not the loss. A card is regenerated
    // from its note, so any correction made by hand in the card is destroyed
    // here — silently, at the one moment the user could still say no. Say it
    // where it happens rather than in the folder's README.
    if (this.overwriting && this.overwriteWarning) {
      contentEl.createDiv({ cls: 'gemma4-ingest-overwrite-warning', text: this.overwriteWarning });
    }

    const preview = contentEl.createDiv({ cls: 'gemma4-ingest-preview' });
    void MarkdownRenderer.render(this.app, this.pageContent, preview, this.pagePath, this.renderHost);

    const buttons = contentEl.createDiv({ cls: 'gemma4-ingest-buttons' });
    const cancel = buttons.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());
    const approve = buttons.createEl('button', { cls: 'mod-cta', text: 'Approve and write' });
    approve.addEventListener('click', () => {
      this.approved = true;
      this.close();
      this.onApprove();
    });
  }

  onClose() {
    this.renderHost.unload();
    this.contentEl.empty();
    if (!this.approved) this.onDismiss?.();
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

// Shown once, immediately after the plugin creates its folder for the first
// time. Deliberately NOT a confirmation: there is no decision here, and a
// dialog that only has one sensible answer is friction, not consent. It exists
// because the alternative — creating eight things in someone's vault silently —
// leaves them with a folder they never asked about and cannot interpret.
// The primary action opens index.md, which carries the same explanation
// permanently, so this card is a doorway rather than the only telling.
export class ScaffoldCreatedModal extends Modal {
  private dir: string;
  private items: { path: string; what: string }[];
  private onOpenIndex: () => void;
  private onOpenPanel: () => void;

  constructor(
    app: App,
    dir: string,
    items: { path: string; what: string }[],
    onOpenIndex: () => void,
    onOpenPanel: () => void
  ) {
    super(app);
    this.dir = dir;
    this.items = items;
    this.onOpenIndex = onOpenIndex;
    this.onOpenPanel = onOpenPanel;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('gemma4-scaffold-modal');
    // Widen the shell as well as the content: at the default modal width the
    // eight paths plus the two explanations were a line or two too tall and the
    // card came up with a scrollbar, which is a bad look for the first thing
    // the plugin ever shows anyone.
    this.modalEl.addClass('gemma4-scaffold-shell');
    contentEl.createEl('h3', { text: `Gemma Wiki set up "${this.dir}/"` });
    contentEl.createEl('p', {
      cls: 'gemma4-scaffold-lede',
      text:
        'Everything this plugin writes goes in that one folder. Your own notes are never ' +
        'moved or modified — they are read and closed.',
    });

    const list = contentEl.createDiv({ cls: 'gemma4-scaffold-list' });
    for (const item of this.items) {
      const row = list.createDiv({ cls: 'gemma4-scaffold-row' });
      row.createSpan({ cls: 'gemma4-scaffold-path', text: item.path });
      row.createSpan({ cls: 'gemma4-scaffold-what', text: item.what });
    }

    contentEl.createEl('p', {
      cls: 'gemma4-scaffold-foot',
      text:
        'Each folder holds a README explaining what belongs in it. Rename the folder, or check ' +
        'that nothing is missing, in Settings → Gemma Wiki.',
    });

    // Where the plugin actually lives. A first-time user has no reason to guess
    // that a ribbon icon on the far left is the whole product, so this says it
    // in words and the panel opens on its own once this card is dismissed.
    // Draw the actual ribbon icon inline rather than describing it. "The Gemma
    // Wiki icon" is useless to someone staring at a column of nine icons they
    // have never looked at closely; the picture is the instruction.
    const where = contentEl.createEl('p', { cls: 'gemma4-scaffold-where' });
    where.appendText('You talk to it from the side panel — click ');
    const inlineIcon = where.createSpan({ cls: 'gemma4-inline-icon' });
    setIcon(inlineIcon, 'gemma-wiki-logo');
    where.appendText(
      ' in the ribbon down the left edge of the window. It is opening now so you can see where it is.'
    );

    const buttons = contentEl.createDiv({ cls: 'gemma4-ingest-buttons' });
    const index = buttons.createEl('button', { text: 'Open index.md' });
    index.addEventListener('click', () => {
      this.close();
      this.onOpenIndex();
    });
    const open = buttons.createEl('button', { cls: 'mod-cta', text: 'Show me the panel' });
    open.addEventListener('click', () => this.close());
  }

  onClose() {
    this.contentEl.empty();
    this.onOpenPanel();
  }
}
