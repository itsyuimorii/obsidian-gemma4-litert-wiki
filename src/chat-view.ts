import {
  asksAboutOwnNotes,
  excerptAround,
  formatVaultTree,
  looksLikeCollectionQuery,
  looksLikeListQuery,
  looksLikeRecentQuery,
  looksLikeRefusal,
  queryTerms,
  rankVaultDocs,
  rescoreWithBodies,
  standingInstructions,
  type VaultDoc,
} from './pure';
import {
  App,
  FuzzySuggestModal,
  ItemView,
  Menu,
  MarkdownRenderer,
  getAllTags,
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
  buildChatTranscript,
  safeFileName,
  rebuildChatsIndex,
  wikiChatsDir,
  wikiSourcesDir,
  wikiConceptsDir,
  clampToTokens,
  estimateTokens,
  fmOf,
  expandByLinks,
  getIngestedSourcePaths,
  indexPath,
  loadPages,
  readIndexEntries,
  readLogTail,
  readSkills,
  scoreEntries,
  type ChatTurnRecord,
  wikiDir,
} from './wiki-store';
import { IngestPreviewModal } from './ingest-modal';
import { notify } from './notify';

// What `written_by` records on a saved answer. The bundle filename without its
// extension: specific enough to tell two model versions apart in six months,
// which is the whole point of writing it down.
const MODEL_LABEL = 'gemma-4-E4B-it-web';

// What marks a saved answer in the file explorer. A prefix rather than a
// suffix or a frontmatter field, because those are the two places you cannot
// see it: Obsidian's sidebar truncates around thirty characters and shows no
// properties, so anything at the end is invisible exactly when you are
// scanning a folder to tell your own writing from the model's. `gemma` and not
// `AI` because it names which model; the exact build is in `written_by`.
const MODEL_PREFIX = 'gemma';

// How much of a typed question survives before the topic is appended. Without
// a cap the topic is what gets cut, which is backwards — the topic is the part
// you cannot reconstruct from the folder.
const QUESTION_STEM_MAX = 60;

/** The folder part of a vault path, '' for a file at the root. */
function parentOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut > 0 ? path.slice(0, cut) : '';
}

/**
 * The title of a saved answer: what it did, then what it was about.
 *
 * That order matters more than it looks. Several answers about one note are
 * told apart by the action or the question, not by the topic they share — so
 * with a sidebar truncating at thirty characters, action-first keeps them
 * distinguishable and topic-first renders them identical.
 *
 * The topic is appended only when there is exactly one source. In Wiki mode an
 * answer can read four cards, and naming it after the first would claim it is
 * about one note when it is about the set.
 */
export function answerTitle(
  question: string,
  promptLabel: string | undefined,
  sources: { title: string; linkPath: string }[]
): string {
  // A canned prompt makes a terrible title — "Summarize this note" names no
  // note, and running it twice in a folder gave you that and "… 2". The label
  // is the short form a chip or a skill already has; a typed question is its
  // own label.
  const head = promptLabel ?? question;
  const stem = head.length > QUESTION_STEM_MAX ? `${head.slice(0, QUESTION_STEM_MAX).trimEnd()}…` : head;
  return sources.length === 1 ? `${stem} — ${sources[0].title}` : stem;
}

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

export const VIEW_TYPE_CHAT = 'gemma-litert-wiki-chat-view';

// How much grounding content to feed per answer, derived from the configured
// context window (settings) minus room for the answer and instructions.
// Token-estimated (CJK-aware), not char-counted.

/** One chip above the input: a label, and what pressing it does. */
export interface SuggestionSpec {
  label: string;
  /** What to send, for the chips that ask a question. */
  ask?: string;
  /**
   * Put this in the input box and hand over the cursor, instead of sending.
   * For a chip whose question is only half written — "Explain a term" cannot
   * be sent, because which term is the whole question. A chip that sends a
   * made-up example in that spot answers something nobody asked.
   */
  fill?: string;
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
/**
 * Where a question is answered from.
 *
 * `direct` is the model on its own — no note, no wiki, no Sources row. It
 * exists because Gemma 4 E4B is a general model and the plugin already had
 * the whole ungrounded path built for the per-answer escape hatch; the only
 * thing missing was a way to choose it on purpose instead of arriving at it
 * after a question failed. Grounded stays the default: this is a mode you
 * pick, never one you land in.
 */
export type ChatMode = 'note' | 'wiki' | 'vault';

export function suggestionsFor(mode: ChatMode): SuggestionSpec[] {
  if (mode === 'vault') {
    // No actions here, because an action files something into the wiki and
    // this mode is the one that reads raw notes rather than the wiki. Three
    // openings that say what the mode is for: one that searches, two that
    // do not need a note at all.
    // All three fill rather than ask: each is a sentence with the important
    // word missing, and that word is yours. The ellipsis in the label says so.
    return [
      { label: 'Find my notes on…', fill: 'Which of my notes are about: ' },
      { label: 'Explain a term…', fill: 'Explain, in plain terms: ' },
      { label: 'Draft an outline…', fill: 'Draft a short outline for: ' },
    ];
  }
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
    {
      // The activity log rides along with every wiki answer, so "this week"
      // is answerable here and nowhere else. It is also the third question
      // whose shape says what this mode is: about the collection, over time.
      label: 'Added this week?',
      ask: 'What did I add to the wiki this week? List the pages and what each is about. Cite the pages.',
      wholeWiki: true,
    },
  ];
}

type RouteTarget = ChatMode;

/**
 * The second half of a Vault answer. The first half, already on screen,
 * came from the notes; this one is the subject itself. Without this the
 * second pass reused DIRECT_PROMPT, and a question shaped "what did I write
 * about coffee" got "I do not have access to your notes" — true, useless,
 * and already said by the label above it. The model is told the notes are
 * handled and asked for what it knows about coffee.
 */
const ADDS_PROMPT =
  "The first part of this reply, already written, answered from the user's own notes. You " +
  'write the second part: general knowledge about the SUBJECT of the question — what it is, ' +
  'useful background, related ideas, anything worth knowing that personal notes may not say. ' +
  'You have not seen the notes; do not refer to them, and never say you lack access to notes ' +
  'or files — that is understood and already handled above. If the question is phrased as ' +
  'being about the notes ("what did I write about X", "which of my notes cover X"), answer ' +
  'about X itself. Be concise. You may use markdown.';

/** Vault mode's ceiling on note material per answer, and per note. */
const VAULT_MATERIAL_TOKENS = 4800;
const VAULT_NOTE_TOKENS = 1200;

/** The model on its own: no notes, and it must not pretend otherwise. */
const DIRECT_PROMPT =
  "Answer the user's question from your own general knowledge. You do NOT have access to " +
  "the user's notes or wiki here — never claim a fact came from them. If you are unsure, " +
  'say so plainly. Be concise. You may use markdown.';

/**
 * What each mode is for, said in the empty panel: what it reads, what it is
 * good for, and — for the other two modes — the question that belongs there
 * instead. The three read three different things, and the pills alone do
 * not say which; this is the sentence that does, at the moment it is
 * needed. The wiki folder is named as the folder, not as "the wiki", so
 * that a reader who has never heard the word knows where to look.
 */
const MODE_GUIDE: Record<
  ChatMode,
  { title: string; reads: string; goodFor: string; others: [ChatMode, string, string][] }
> = {
  note: {
    title: 'Ask about the open note',
    reads: 'Reads only the note you have open, as you wrote it.',
    goodFor: 'Good for: what this note says, a summary, the action items, a term it uses.',
    others: [
      ['vault', 'Vault', 'For any note in your vault, or anything general'],
      ['wiki', 'Wiki', 'For what connects your notes, once cards exist'],
    ],
  },
  vault: {
    title: 'Ask anything',
    reads:
      'Searches every note in your vault as written; then Gemma 4 E4B adds its own answer, ' +
      'marked as its own.',
    goodFor: 'Good for: finding a note, what you wrote about something, anything general.',
    others: [
      ['note', 'This note', 'For only the note you have open'],
      ['wiki', 'Wiki', 'For what connects, what is missing, what you added — across the cards'],
    ],
  },
  wiki: {
    title: 'Ask your wiki',
    reads: '',
    goodFor: 'Good for: what connects my notes, what is still open, what did I add this week.',
    others: [
      ['vault', 'Vault', 'For a note as you wrote it, or one not filed yet'],
      ['note', 'This note', 'For only the note you have open'],
    ],
  },
};

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
  private mode: ChatMode = 'note'; // overwritten from settings in onOpen
  // Whether the wiki holds any pages. Cached, because the chips are drawn
  // synchronously and metadataCache fires 'resolved' constantly — reading
  // index.md on every one of those would be a file read per keystroke-ish
  // event for a boolean that changes about once.
  private wikiEmpty = true;
  private modeButtons: { note: HTMLElement; wiki: HTMLElement; vault: HTMLElement } | null = null;
  /** Set by Stop; a two-part Vault answer checks it before starting part two. */
  private stopRequested = false;
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
    // The chip carries live counts, so it follows every re-read; the rest
    // only redraws when the empty/non-empty answer flips.
    this.updateNoteChip();
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
          `Wiki mode reads only the pages in your ${wikiDir()}/ folder — the cards and concept ` +
          'pages this plugin builds from your notes. Nothing is there yet.',
      });
      el.createDiv({
        cls: 'gemma4-chat-empty-hint',
        text: 'Press Scan a folder below to build it, or switch to Vault to search your notes as they are.',
      });
      return;
    }

    const guide = MODE_GUIDE[this.mode];
    el.createDiv({ cls: 'gemma4-chat-empty-title', text: guide.title });
    // The wiki line names the folder, which is a setting, so it is built here.
    const reads =
      this.mode === 'wiki'
        ? `Reads only ${wikiDir()}/ — the cards and concept pages built from your notes and reviewed by you.`
        : guide.reads;
    el.createDiv({ cls: 'gemma4-chat-empty-hint', text: reads });
    el.createDiv({ cls: 'gemma4-chat-empty-hint', text: guide.goodFor });

    // The other two modes, one line each: the question that belongs there,
    // then the pill. The pills under the input are the same switch; this
    // is the sentence that explains them, at the moment it is needed.
    const lines = el.createDiv({ cls: 'gemma4-chat-empty-guide' });
    for (const [mode, label, what] of guide.others) {
      const line = lines.createDiv({ cls: 'gemma4-chat-empty-guide-line' });
      line.appendText(what + ' → ');
      const b = line.createEl('button', { cls: 'gemma4-chat-empty-guide-mode', text: label });
      b.addEventListener('click', () => this.setMode(mode));
    }

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
    if (spec.fill !== undefined) {
      this.inputEl.value = spec.fill;
      this.autoGrowInput();
      this.inputEl.focus();
      const end = this.inputEl.value.length;
      this.inputEl.setSelectionRange(end, end);
      return;
    }
    if (spec.ask) {
      void this.handleSend({ text: spec.ask, wholeWiki: spec.wholeWiki, promptLabel: spec.label });
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

  /**
   * The whole thread as one note, through the same gate as everything else.
   *
   * Named after the first question, which is what a person would call the
   * conversation if asked, and placed by the same rule as a saved answer:
   * beside the material it came from. In a thread that moved between notes
   * the first source wins — one file has to live somewhere, and the per-answer
   * Sources lines inside it keep the rest honest.
   */
  private async saveConversation() {
    // Only completed exchanges. A trailing question whose generation failed
    // would be saved as a heading with nothing under it.
    const turns = [...this.turns];
    while (turns.length && turns.at(-1)!.role === 'user') turns.pop();
    if (!turns.length) {
      notify('noop', 'Nothing to save yet — ask something first.');
      return;
    }
    const firstQ = turns.find((t) => t.role === 'user')?.content ?? 'conversation';
    const title = firstQ.length > 80 ? `${firstQ.slice(0, 77).trim()}…` : firstQ.trim();
    // One folder, not beside the note. A saved ANSWER belongs next to the
    // material it came from, because it is about that material and you want
    // it where you would look for it. A conversation is a working record: it
    // can move between notes and modes, it is read once and rarely linked,
    // and scattering one copy per note it happened to touch buries the notes
    // under sediment. So they collect in one place — and that place is
    // excluded from every path that could read them back, which is the whole
    // reason they can be collected safely.
    const folder = wikiChatsDir();
    const stem = safeFileName(
      `${MODEL_PREFIX} — chat — ${title}`,
      `${MODEL_PREFIX} — chat ${window.moment().format('YYYY-MM-DD HHmmss')}`
    );
    const notePath = this.freePath(folder, stem);
    const content = buildChatTranscript(turns, { model: MODEL_LABEL, titleLabel: title });
    // Never overwriting, for the same reason a saved answer never is: this is
    // the user's folder, and " 2" costs a duplicate where replacing costs
    // whatever was in the file.
    new IngestPreviewModal(this.app, notePath, content, false, () => {
      void (async () => {
        const dir = notePath.slice(0, notePath.lastIndexOf('/'));
        if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
          await this.app.vault.createFolder(dir).catch(() => {});
        }
        await this.app.vault.create(notePath, content);
        // The folder's own table of contents, rebuilt from what is in it. The
        // wiki index is deliberately untouched: a conversation there would be
        // read as material by wiki-mode retrieval.
        await rebuildChatsIndex(this.app.vault, this.app);
        await appendLog(this.app.vault, 'chat', notePath);
        notify('done', `Saved: ${notePath}`);
      })().catch((err) => {
        console.error('[gemma-litert-wiki] saving the conversation failed', err);
        notify('error', `Could not save the conversation — ${err instanceof Error ? err.message : String(err)}`);
      });
    }, 'Review note before writing').open();
  }

  private clearChat() {
    if (this.busy) this.activeConversation?.cancel();
    this.lastQuestion = null;
    this.turns = [];
    this.messagesEl.empty();
    this.buildEmptyState();
    // Clear means clear. Leaving the saved copy behind would resurrect the
    // thread on the next open, which is the opposite of what the button says.
    void this.persistThread();
  }

  /**
   * Keep the thread across a close (#100).
   *
   * Two caps, because unbounded plugin data is how a data.json becomes
   * megabytes without anyone noticing: the most recent exchanges only, and a
   * character ceiling on top for the case where a few answers are enormous.
   * Trimmed from the front so what survives is what you were last looking at.
   */
  private async persistThread(): Promise<void> {
    const MAX_TURNS = 20;
    const MAX_CHARS = 60_000;
    let kept = this.turns.slice(-MAX_TURNS);
    while (kept.length && kept.reduce((n, t) => n + t.content.length, 0) > MAX_CHARS) kept.shift();
    // A lone assistant turn restores as an answer to nothing.
    while (kept.length && kept[0].role === 'assistant') kept.shift();
    const next = kept.length ? kept : undefined;
    const before = JSON.stringify(this.plugin.settings.lastThread ?? null);
    if (JSON.stringify(next ?? null) === before) return;
    this.plugin.settings.lastThread = next;
    await this.plugin.saveSettings();
  }

  /**
   * Put a saved thread back on screen.
   *
   * Rendered from the record, not replayed through the model: these answers
   * were already generated and paid for, and re-running them would be both
   * slow and — the model being sampled — a different answer under the same
   * question.
   */
  private async restoreThread(): Promise<void> {
    const saved = this.plugin.settings.lastThread;
    if (!saved?.length) return;
    this.turns = saved.map((t) => ({ ...t }));
    this.emptyStateEl.hide();
    for (let i = 0; i < saved.length; i++) {
      const turn = saved[i];
      if (turn.role === 'user') {
        this.appendUserMessage(turn.content);
        this.lastQuestion = turn.content;
        continue;
      }
      const { body, row } = this.appendAssistantMessage();
      const rendered = body.createDiv({ cls: 'gemma4-chat-markdown' });
      await MarkdownRenderer.render(this.app, turn.content, rendered, indexPath(), this);
      const sources = turn.sources ?? [];
      if (turn.grounding === 'direct') {
        const warnRow = body.createDiv({ cls: 'gemma4-chat-sources' });
        warnRow.createSpan({
          cls: 'gemma4-chat-sources-label',
          text: '⚠ Gemma general knowledge — not from your notes',
        });
      } else if (sources.length) {
        const sourcesRow = body.createDiv({ cls: 'gemma4-chat-sources' });
        this.sourcesLabel(sourcesRow, turn.grounding ?? '');
        for (const src of sources) {
          const link = sourcesRow.createEl('a', { cls: 'gemma4-chat-source-link', text: src.title });
          link.addEventListener('click', (evt) => {
            evt.preventDefault();
            void this.app.workspace.openLinkText(src.linkPath, '', false);
          });
        }
      }
      const question = saved[i - 1]?.role === 'user' ? saved[i - 1].content : '';
      this.addAssistantActions(row, () => turn.content, question, sources, turn.grounding !== 'direct');
    }

    // Say when the ground has moved. Silently re-grounding a restored thread
    // onto whatever note happens to be open would put this panel's own answers
    // under material they were never about — the one thing its Sources row
    // exists to prevent. So it is stated, and the user decides.
    const was = [...saved].reverse().find((t) => t.grounding)?.grounding;
    const now = this.groundingKey(false, false);
    // `now` must name a real note, not just be in note mode: with nothing
    // open the key is a bare "note:", and the notice would claim the panel is
    // grounded in a note the user does not have open.
    if (was?.startsWith('note:') && now.startsWith('note:') && now !== 'note:' && was !== now) {
      const name = was.slice('note:'.length).split('/').pop()?.replace(/\.md$/, '') ?? 'another note';
      this.appendInfoMessage(
        `Restored from your last session. Those answers are about "${name}"; this panel is now ` +
          'grounded in the note you have open, so a follow-up will be answered from that one.'
      );
    }
    this.scrollToBottom();
  }

  private autoGrowInput() {
    if (this.inputExpanded) return;
    const el = this.inputEl;
    // Measured, not chosen: the box has to be laid out at its natural height
    // before scrollHeight means anything. Through setCssStyles rather than
    // el.style, which the store's linter rejects — a plugin assigning styles
    // directly is a plugin a theme cannot override.
    el.setCssStyles({ height: 'auto' });
    const max = Math.floor(this.containerEl.clientHeight * 0.35);
    el.setCssStyles({ height: `${Math.min(el.scrollHeight, max)}px` });
  }

  private toggleInputExpand() {
    this.inputExpanded = !this.inputExpanded;
    this.inputEl.toggleClass('gemma4-chat-input-tall', this.inputExpanded);
    setIcon(this.expandButton, this.inputExpanded ? 'minimize-2' : 'maximize-2');
    setTooltip(this.expandButton, this.inputExpanded ? 'Shrink input' : 'Expand input');
    if (this.inputExpanded) {
      // Hand the height back to the stylesheet; the expanded class owns it.
      this.inputEl.setCssStyles({ height: '' });
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
    await this.persistThread();
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
    // Beside the bin, where it used to be. The per-message save keeps one
    // answer; this keeps the thread — including the questions, which are the
    // half you cannot reconstruct from the answers.
    const saveConvBtn = headerActions.createEl('button', {
      cls: 'gemma4-chat-clear',
      attr: { 'aria-label': 'Save conversation as a note' },
    });
    setIcon(saveConvBtn, 'save');
    setTooltip(saveConvBtn, 'Save conversation as a note');
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
    // Second, and the default: every raw note in the vault, then the model
    // on its own — the one to type into without thinking. Wiki is last
    // because it is the one that needs building first.
    const vaultBtn = modeRow.createEl('button', {
      cls: 'gemma4-chat-mode-btn',
      text: 'Vault',
    });
    const wikiBtn = modeRow.createEl('button', { cls: 'gemma4-chat-mode-btn', text: 'Wiki' });
    this.modeButtons = { note: noteBtn, wiki: wikiBtn, vault: vaultBtn };
    noteBtn.addEventListener('click', () => this.setMode('note'));
    wikiBtn.addEventListener('click', () => this.setMode('wiki'));
    vaultBtn.addEventListener('click', () => this.setMode('vault'));

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
    const SKILLS: {
      label: string;
      icon: string;
      prompt: string;
      mode?: ChatMode;
      fill?: boolean;
      /** Builds the prompt at click time, for a skill whose material is computed rather than typed. */
      build?: () => Promise<string>;
    }[] = [
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
      {
        // Vault, because the question is about the vault's shape. The tree —
        // folder names and note counts, nothing read from inside any file —
        // is built when you click and travels inside the message, so the
        // model is answering about what you showed it rather than claiming
        // to have looked. A skill that builds its own material is sent
        // ungrounded: searching the vault for a prompt that already contains
        // the vault would be circular.
        label: 'Folder structure',
        icon: 'folder-tree',
        mode: 'vault',
        prompt: '',
        build: async () => {
          const tree = formatVaultTree(
            this.app.vault.getMarkdownFiles().map((f) => f.path),
            { exclude: wikiDir() }
          );
          return (
            'Below is the folder layout of my Obsidian vault — folder names and how many notes ' +
            'each holds, nothing else. Suggest how I could organise it better: what to merge, ' +
            'split, rename, or add, and where uncategorised notes should go. Be concrete and ' +
            'brief; do not invent folders that are not listed as if they existed.\n\n' +
            '```\n' + (tree || '(empty vault)') + '\n```'
          );
        },
      },
    ];

    // Custom skills (issue #4) live as files in <wiki>/skills/ — "config as a
    // note", read fresh on each menu open so adding or editing a skill file
    // takes effect without reloading. Built-ins first, then the user's, in
    // filename order.
    skillsBtn.addEventListener('click', (evt) => {
      void (async () => {
        const custom = await readSkills(this.app.vault);
        // Typed as the built-in shape on purpose: a custom skill fits it (no
        // `build`), and without the annotation TypeScript reduces the union
        // to the custom type and `build` vanishes from every element.
        const all: typeof SKILLS = [...SKILLS, ...custom];
        const menu = new Menu();
        // A skill that declares a mode used to switch you into it on click.
        // That is a menu item quietly changing what the panel is grounded in
        // — you pressed "Feynman" from Wiki mode and landed in This note,
        // with nothing saying so. Show it as unavailable instead, and say
        // which mode it wants.
        const unusable = all.filter((s) => s.mode && s.mode !== this.mode);
        if (unusable.length === all.length && all.length) {
          const want = all[0].mode === 'wiki' ? 'Wiki' : all[0].mode === 'vault' ? 'Vault' : 'This note';
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
                void (async () => {
                  const built = 'build' in skill && !!skill.build;
                  const text = 'build' in skill && skill.build ? await skill.build() : skill.prompt;
                  await this.handleSend({ text, promptLabel: skill.label, ungrounded: built });
                })();
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
    this.stopButton.addEventListener('click', () => {
      this.stopRequested = true;
      this.activeConversation?.cancel();
    });
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

    // Last, so the restored thread lands in a panel that is fully built.
    await this.restoreThread();
  }

  private setMode(mode: ChatMode) {
    this.mode = mode;
    this.modeButtons?.note.toggleClass('gemma4-chat-mode-active', mode === 'note');
    this.modeButtons?.wiki.toggleClass('gemma4-chat-mode-active', mode === 'wiki');
    this.modeButtons?.vault.toggleClass('gemma4-chat-mode-active', mode === 'vault');
    // The Direct placeholder says where the answer comes from rather than what
    // to type, because that is the one thing that changes about an answer here
    // and the Sources row — which says it everywhere else — is absent.
    // Each placeholder names the other two modes, because the wrong mode is
    // the commonest way a first question goes badly: a vault question typed
    // into This note gets "unclear", a general one typed into Wiki gets "not
    // in your wiki", and a vault question typed into Direct gets "I do not
    // have access to your files". The pills are the fix, and they are three
    // small buttons under the box that nothing else points at.
    this.inputEl?.setAttribute(
      'placeholder',
      mode === 'note'
        ? 'Ask about this note… (Enter to send) — Wiki or Vault above for anything else'
        : mode === 'wiki'
          ? 'Ask across your cards… (Enter to send) — This note or Vault above for anything else'
          : 'Ask anything — your notes first, then Gemma 4 E4B (Enter to send)'
    );
    this.renderSuggestions();
    this.updateNoteChip();
    void this.renderEmptyState();
  }

  /** How many cards and concept pages the wiki folder holds right now. */
  private wikiCounts(): { cards: number; concepts: number } {
    const cards = `${wikiSourcesDir()}/`;
    const concepts = `${wikiConceptsDir()}/`;
    let c = 0;
    let k = 0;
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (f.path.startsWith(cards)) c++;
      else if (f.path.startsWith(concepts)) k++;
    }
    return { cards: c, concepts: k };
  }

  private updateNoteChip() {
    this.noteChipEl.empty();
    const icon = this.noteChipEl.createSpan({ cls: 'gemma4-chat-note-chip-icon' });
    // The two wide modes say what they read AND how much of it there is,
    // because that is the difference between them: Vault has every note
    // from the first minute; Wiki has whatever has been filed, and says
    // "empty" until something has.
    if (this.mode === 'wiki') {
      setIcon(icon, 'library');
      const { cards, concepts } = this.wikiCounts();
      const label =
        cards + concepts === 0
          ? `${wikiDir()}/ · empty — Scan a folder to build it`
          : `${wikiDir()}/ · ${cards} card${cards === 1 ? '' : 's'}` +
            (concepts ? `, ${concepts} concept page${concepts === 1 ? '' : 's'}` : '');
      this.noteChipEl.createSpan({ text: label });
      this.noteChipEl.toggleClass('gemma4-chat-note-chip-none', cards + concepts === 0);
      return;
    }
    if (this.mode === 'vault') {
      setIcon(icon, 'folder-search');
      const prefix = `${wikiDir()}/`;
      const n = this.app.vault.getMarkdownFiles().filter((f) => !f.path.startsWith(prefix)).length;
      this.noteChipEl.createSpan({ text: `Your notes · ${n} file${n === 1 ? '' : 's'}` });
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

  /**
   * The Sources row's label says what kind of thing it lists, because the
   * same row under a Vault answer and a Wiki answer lists different things
   * — a note you wrote, or a card the plugin built — and the difference is
   * the whole point of having two modes.
   */
  private sourcesLabel(row: HTMLElement, grounding: string) {
    const kind = grounding.startsWith('wiki') ? 'cards' : grounding === 'vault' ? 'notes' : 'sources';
    const icon = row.createSpan({ cls: 'gemma4-chat-sources-icon' });
    setIcon(icon, kind === 'cards' ? 'library' : 'file-text');
    row.createSpan({ cls: 'gemma4-chat-sources-label', text: kind === 'cards' ? 'Cards' : kind === 'notes' ? 'Notes' : 'Sources' });
  }

  private appendUserMessage(text: string) {
    this.emptyStateEl.hide();
    const row = this.messagesEl.createDiv({ cls: 'gemma4-chat-row gemma4-chat-row-user' });
    const bubble = row.createDiv({ cls: 'gemma4-chat-bubble-user', text });
    const edit = row.createEl('button', { cls: 'gemma4-chat-edit-btn', text: 'Edit' });
    edit.setAttribute('aria-label', 'Edit this question and ask again');
    edit.addEventListener('click', () => this.beginEdit(row, bubble, edit, text));
    this.scrollToBottom();
  }

  /**
   * Rewrite a question you already asked, and ask it again from there.
   *
   * A wrong question is the common case in a panel this narrow — a typo, a
   * word the model read the other way, a request that turned out to need one
   * more sentence. Without this the only repair is to retype the whole thing
   * and leave the failed exchange sitting in the transcript above the good
   * one, which makes the thread progressively harder to read back.
   *
   * Everything from the edited question onward is dropped, from the DOM and
   * from `turns` together. That is the honest thing to do: the answers below
   * were responses to the old wording, and keeping them would leave the model
   * reading its own replies to a question that no longer exists as history for
   * the new one.
   */
  private beginEdit(
    row: HTMLElement,
    bubble: HTMLElement,
    editBtn: HTMLElement,
    original: string
  ) {
    if (this.busy) return;
    bubble.hide();
    editBtn.hide();

    const box = row.createDiv({ cls: 'gemma4-chat-edit-box' });
    const area = box.createEl('textarea', { cls: 'gemma4-chat-edit-area' });
    area.value = original;

    const actions = box.createDiv({ cls: 'gemma4-chat-edit-actions' });
    const dropped = this.turnsAfter(original);
    if (dropped > 0) {
      actions.createSpan({
        cls: 'gemma4-chat-edit-note',
        text: dropped === 1 ? 'Replaces 1 later message' : `Replaces ${dropped} later messages`,
      });
    }
    const cancel = actions.createEl('button', { cls: 'gemma4-chat-hatch-btn', text: 'Cancel' });
    const send = actions.createEl('button', { cls: 'gemma4-chat-hatch-btn', text: 'Ask again' });

    const close = () => {
      box.remove();
      bubble.show();
      editBtn.show();
    };
    cancel.addEventListener('click', close);

    const submit = () => {
      const next = area.value.trim();
      if (!next || this.busy) return;
      // Drop this row and everything after it, then re-ask. Removing the row
      // itself matters: runGeneration draws its own question bubble, so
      // leaving this one would show the question twice.
      const rows = Array.from(this.messagesEl.children);
      const from = rows.indexOf(row);
      if (from >= 0) rows.slice(from).forEach((r) => r.remove());
      this.dropTurnsFrom(original);
      void this.runGeneration(next);
    };
    send.addEventListener('click', submit);
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });

    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }

  /** How many recorded turns follow the last time this question was asked. */
  private turnsAfter(question: string): number {
    const at = this.turns.map((t) => t.content).lastIndexOf(question);
    return at < 0 ? 0 : this.turns.length - at - 1;
  }

  /** Forget the last occurrence of this question and everything after it. */
  private dropTurnsFrom(question: string) {
    const at = this.turns.map((t) => t.content).lastIndexOf(question);
    if (at >= 0) this.turns = this.turns.slice(0, at);
    void this.persistThread();
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
    promptLabel?: string
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
      if (this.turns.at(-1)?.role === 'assistant') this.turns.pop();
      if (this.turns.at(-1)?.role === 'user') this.turns.pop();
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
      const title = answerTitle(question, promptLabel, sources);
      const stem = safeFileName(
        `${MODEL_PREFIX} — ${title}`,
        `${MODEL_PREFIX} — answer ${window.moment().format('YYYY-MM-DD HHmmss')}`
      );
      const notePath = this.freePath(folder, stem);
      const content = buildAnswerNote(question, answer, sources, {
        model: MODEL_LABEL,
        // The H1 carries the title without the prefix. Inside the note,
        // `written_by` is two lines above it and says the same thing better;
        // the prefix exists for the file explorer, which is the one place the
        // frontmatter cannot be seen.
        titleLabel: title,
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
      const target = this.app.vault.getAbstractFileByPath(`${first.linkPath}.md`);
      if (target instanceof TFile) {
        // In This-note mode a source IS one of your notes, so its own folder is
        // the answer. Only in Wiki mode is it a card, which has to be followed
        // back through `source:` to the note it summarises.
        //
        // The check is on the path, not on the presence of the field. Reading
        // `source:` off any file that happens to have one is how an answer
        // about a note whose frontmatter says `source: https://example.com/x`
        // — a citation, which is what most people use that word for — ends up
        // filed in a folder called `https:`.
        if (target.path.startsWith(`${wikiSourcesDir()}/`)) {
          const src = fmOf(this.app, target)?.source;
          if (typeof src === 'string' && src.endsWith('.md')) return parentOf(src);
        } else {
          return target.parent?.path && target.parent.path !== '/' ? target.parent.path : '';
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
  private async handleSend(
    opts: { text?: string; wholeWiki?: boolean; promptLabel?: string; ungrounded?: boolean } = {}
  ) {
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
    this.appendUserMessage(question);
    await this.runGeneration(question, opts.ungrounded ?? false, opts.wholeWiki ?? false, opts.promptLabel);
  }

  /**
   * The card that says "wrong mode" and offers the right one. Each target is
   * a button that re-asks the same question there, in place — no retyping,
   * and the answer lands under the card so the thread reads as one attempt
   * that found its footing.
   */
  private routeCard(parent: HTMLElement, text: string, question: string, targets: RouteTarget[]) {
    const card = parent.createDiv({ cls: 'gemma4-chat-hatch gemma4-chat-route' });
    card.createDiv({ cls: 'gemma4-chat-route-text', text });
    const bar = card.createDiv({ cls: 'gemma4-chat-route-actions' });
    const hasNote = !!this.app.workspace.getActiveFile();
    const buttons: HTMLButtonElement[] = [];
    for (const t of targets) {
      if (t === 'note' && !hasNote) continue;
      const label =
        t === 'wiki' ? 'Ask the wiki'
        : t === 'note' ? 'Ask the open note'
        : 'Ask across your vault';
      const btn = bar.createEl('button', { cls: 'gemma4-chat-hatch-btn', text: label });
      buttons.push(btn);
      btn.addEventListener('click', () => {
        if (this.busy) return;
        for (const b of buttons) b.disabled = true;
        void this.askInMode(t, question);
      });
    }
    this.scrollToBottom();
  }

  /** Re-ask a question in another mode, switching the panel to it first. */
  private async askInMode(target: RouteTarget, question: string) {
    this.setMode(target);
    // A vault question routed to Wiki mode is about the collection, not about
    // whichever pages happen to share its words — ground it in every page.
    const wholeWiki = target === 'wiki' && asksAboutOwnNotes(question);
    await this.runGeneration(question, false, wholeWiki);
  }

  /**
   * Vault mode: search every raw note first, then decide what the answer is
   * made of. This is what every "chat with your vault" is underneath — the
   * plugin finds the few notes that matter, the model reads those — and the
   * search is lexical over what the metadata cache already knows (titles,
   * tags, headings) plus the bodies of the likely ones. The wiki folder is
   * excluded: that layer has its own mode.
   *
   * Bodies: every note in a vault of up to 400, because a match that lives
   * only in a body ("tried a new coffee today" in a daily note) is common and
   * cachedRead is cheap at that size. Above that, only the notes metadata
   * already put forward, so a ten-thousand-note vault does not read ten
   * thousand files per question.
   */
  private async buildVaultContext(
    question: string,
    historyTokens: number
  ): Promise<Awaited<ReturnType<ChatView['buildContext']>>> {
    const prefix = `${wikiDir()}/`;
    const files = this.app.vault.getMarkdownFiles().filter((f) => !f.path.startsWith(prefix));
    const docs: VaultDoc[] = files.map((f) => {
      const cache = this.app.metadataCache.getFileCache(f);
      return {
        path: f.path,
        title: f.basename,
        tags: cache ? (getAllTags(cache) ?? []) : [],
        headings: (cache?.headings ?? []).map((h) => h.heading),
      };
    });
    const link = (path: string) => {
      const base = path.replace(/^.*\//, '').replace(/\.md$/, '');
      const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      return { base, folder, linkPath: path.replace(/\.md$/, '') };
    };

    // "What did I write recently" is answered by the file system, not by
    // search: the eight most recently edited notes, newest first, with the
    // date each was touched. The model adds a line per note from its
    // opening; it is not asked to know when anything happened.
    if (looksLikeRecentQuery(question)) {
      const recent = [...files].sort((a, b) => b.stat.mtime - a.stat.mtime).slice(0, 8);
      const hits = recent.map((f) => ({ title: `${link(f.path).base} (${new Date(f.stat.mtime).toISOString().slice(0, 10)})`, linkPath: link(f.path).linkPath }));
      let material = '';
      for (const f of recent) {
        const body = (await this.app.vault.cachedRead(f)).slice(0, 1200);
        material += `## Note: ${link(f.path).base} — edited ${new Date(f.stat.mtime).toISOString().slice(0, 10)}\n${body}\n\n`;
      }
      return {
        systemPrompt:
          'The user asked what they wrote or edited recently. The plugin has already listed ' +
          'the notes below, newest first, with the date each was last edited — you are not ' +
          'being asked to find them, and you have no other knowledge of dates. For each note, ' +
          'in the order given, write one line: its title in bold, then what it is about, from ' +
          'its text. Do not add notes that are not listed.\n\n' +
          'Be concise. Use a markdown list.\n\n' +
          clampToTokens(material, VAULT_MATERIAL_TOKENS).text,
        sourcePath: indexPath(),
        sources: hits,
        grounding: 'vault',
        vault: { kind: 'list', hits },
      };
    }

    const ranked = rankVaultDocs(question, docs, 80);
    const rankedSet = new Set(ranked.map((h) => h.path));
    const toRead = files.length <= 400 ? files : files.filter((f) => rankedSet.has(f.path));
    const bodies = new Map<string, string>();
    for (const f of toRead) bodies.set(f.path, (await this.app.vault.cachedRead(f)).slice(0, 20000));
    const hits = rescoreWithBodies(question, ranked, bodies, 4);
    const attachments = await this.readAttachments();
    // Not the whole chat budget. At a 64k context that is 48k tokens, and
    // five long notes filled it — a minute of prefill during which WebGPU
    // starved the renderer and the panel showed nothing at all. Four notes,
    // twelve hundred tokens each, as windows around the question's words
    // rather than the note's opening, is a few seconds and says more.
    const budget = Math.min(VAULT_MATERIAL_TOKENS, Math.max(1200, this.plugin.budget('chat') - historyTokens));
    // Two notes with the same name in different folders would show as two
    // identical Sources chips; the folder goes on when the name is shared.
    const seen = new Map<string, number>();
    for (const h of hits) seen.set(link(h.path).base, (seen.get(link(h.path).base) ?? 0) + 1);
    const titled = (path: string) => {
      const { base, folder, linkPath } = link(path);
      return { title: (seen.get(base) ?? 0) > 1 && folder ? `${base} (${folder})` : base, linkPath };
    };

    if (!hits.length && !attachments.blocks) {
      if (asksAboutOwnNotes(question)) {
        // "What's in my vault" matches no note by its words, because it is
        // about all of them. Hand the model the shape instead: folders with
        // counts, and the notes touched most recently.
        const tree = formatVaultTree(files.map((f) => f.path), { exclude: wikiDir() });
        const recent = [...files]
          .sort((a, b) => b.stat.mtime - a.stat.mtime)
          .slice(0, 25)
          .map((f) => `- ${f.basename}${f.parent && f.parent.path !== '/' ? ` (${f.parent.path})` : ''}`)
          .join('\n');
        return {
          systemPrompt:
            "The user is asking about their own Obsidian vault as a whole. You have NOT read any " +
            'note; below is only the folder layout with note counts, and the titles of the notes ' +
            'edited most recently. Answer from that: what the vault seems to be about, how it is ' +
            'organised, what is recent. Name folders and titles as they appear. Do not invent ' +
            'contents of notes you have not seen — if asked what a note says, say you would need ' +
            'it opened or asked about by name.\n\n' +
            'Be concise. You may use markdown.\n\n' +
            `## Folder layout\n\`\`\`\n${tree || '(empty vault)'}\n\`\`\`\n\n` +
            `## Recently edited notes\n${recent || '(none)'}`,
          sourcePath: indexPath(),
          sources: [],
          grounding: 'vault',
          vault: { kind: 'overview', hits: [] },
        };
      }
      // Nothing in the notes. The model answers on its own — this is the
      // Direct answer, under one line that says the notes were looked at.
      return {
        systemPrompt: DIRECT_PROMPT,
        sourcePath: indexPath(),
        sources: [],
        ungrounded: true,
        grounding: 'direct',
        vault: { kind: 'none', hits: [] },
      };
    }

    // Notes matched (or were attached). Each gets an equal share of the
    // budget, so five short notes arrive whole and five long ones arrive
    // as their openings — the part most likely to say what they are about.
    const hitSources = hits.map((h) => titled(h.path));
    const share = Math.min(
      VAULT_NOTE_TOKENS,
      Math.max(300, Math.floor((budget - estimateTokens(attachments.blocks)) / Math.max(1, hits.length)))
    );
    const terms = queryTerms(question);
    let material = '';
    for (const h of hits) {
      const body = bodies.get(h.path) ?? '';
      const src = titled(h.path);
      // ~3.4 chars per token for Latin text; CJK is denser, and clampToTokens
      // below catches the case where the estimate was generous.
      const excerpt = clampToTokens(excerptAround(body, terms, share * 3), share).text;
      material += `## Note: ${src.title} (${h.path})\n${excerpt}\n\n`;
    }
    material += attachments.blocks;
    const sources = [...attachments.sources, ...hitSources];

    if (looksLikeListQuery(question) && hits.length) {
      return {
        systemPrompt:
          'The user asked which of their notes are about something. The plugin has already ' +
          'searched the vault and found the notes below — you are not being asked to search, ' +
          'and you cannot. For each note, in the order given, write one line: its title in bold, ' +
          'then what it is about and why it fits the question, from its text. Do not add notes ' +
          'that are not listed. Do not summarise the topic itself. If a listed note does not ' +
          'really fit, say so in its line.\n\n' +
          'Be concise. Use a markdown list.\n\n' +
          material,
        sourcePath: indexPath(),
        sources,
        grounding: 'vault',
        vault: { kind: 'list', hits: hitSources },
      };
    }

    return {
      systemPrompt:
        "Use ONLY the notes below, from the user's own vault, to answer the first part of this " +
        'reply: what their notes say about the question. Quote or paraphrase what is there, name ' +
        'the note it came from, and say plainly if the notes touch the subject without answering ' +
        'it. Never claim a note says something it does not, and never invent detail and present ' +
        'it as theirs. Do not add general knowledge here — that comes separately, after.\n\n' +
        'A note is named ONLY by the title in its "## Note:" header. Headings and numbered ' +
        'sections inside a note are parts of that note, not notes of their own — never list ' +
        'them as if they were separate notes.\n\n' +
        'If the user asks you to work with the material — summarise, list actions, turn into ' +
        'questions — do that from the notes. If the request is unclear, say you did not follow ' +
        'it rather than reporting that the notes lack something.\n\n' +
        'Be concise. You may use markdown.\n\n' +
        material,
      sourcePath: indexPath(),
      sources,
      grounding: 'vault',
      vault: { kind: 'both', hits: hitSources },
    };
  }

  // Builds the grounding context for one question, or returns null with a
  // user-facing Notice when there is nothing to ground in. Wiki mode is
  // honest by design: no matching pages means "not in your wiki", not a
  // guess from the model's own knowledge.
  private async buildContext(
    question: string,
    ungrounded = false,
    wholeWiki = false,
    historyTokens = 0
  ): Promise<{
    systemPrompt: string;
    sourcePath: string;
    sources: { title: string; linkPath: string }[];
    ungrounded?: boolean;
    noPageMatch?: boolean;
    /** Which body of material this answer stands on — see ChatTurnRecord. */
    grounding: string;
    /**
     * Vault mode's shape for this answer. `none`: nothing in the notes, the
     * model answers alone under a line saying so. `overview`: the question
     * was about the vault itself and nothing matched lexically, so the model
     * is handed its folder layout and recent notes. `list`: the question
     * wanted notes, not an answer — the hits are drawn as links first, and
     * the model adds a line each. `both`: notes matched, so the grounded
     * answer comes first and the model's own answer after, each labelled.
     */
    vault?: { kind: 'none' | 'overview' | 'list' | 'both'; hits: { title: string; linkPath: string }[] };
  } | null> {
    // Escape hatch (issue #7): the user explicitly asked to bypass grounding
    // and let Gemma answer from its own knowledge. No retrieval, no sources,
    // and the answer is marked ungrounded so the trust model stays intact.
    if (ungrounded) {
      return {
        systemPrompt: DIRECT_PROMPT,
        sourcePath: indexPath(),
        sources: [],
        ungrounded: true,
        grounding: 'direct',
      };
    }
    if (this.mode === 'vault') {
      return this.buildVaultContext(question, historyTokens);
    }
    if (this.mode === 'wiki') {
      const entries = await readIndexEntries(this.app.vault);
      if (!entries.length) {
        this.appendInfoMessage(
          `Your ${wikiDir()}/ folder is empty, so there is nothing to answer from. Build it ` +
            'first — nothing is written without your approval — or switch to Vault to search ' +
            'your notes as they are.',
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
        Math.max(1200, this.plugin.budget('chat') - historyTokens)
      );
      if (clampedWiki.truncated) {
        this.appendInfoMessage(
          `Only the first ~${Math.round(Math.max(1200, this.plugin.budget('chat') - historyTokens) / 1000)}k tokens of the retrieved ` +
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
        // The wiki is one body of material, so wiki turns follow each other —
        // but a whole-wiki sweep and a retrieval question read different
        // subsets, and only the retrieval thread is about a specific subject.
        grounding: wholeWiki ? 'wiki:all' : 'wiki',
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
    let noteBodyChars = 0;
    const sources: { title: string; linkPath: string }[] = [];
    if (file) {
      const noteContent = await this.app.vault.read(file);
      // Frontmatter is not material a question can be answered from, so it
      // does not count towards whether this note has anything to say.
      noteBodyChars = noteContent.replace(/^---\n[\s\S]*?\n---\n?/, '').trim().length;
      noteBlock = `## Open note: ${file.basename}\n${noteContent}\n\n`;
      sources.push({ title: file.basename, linkPath: file.path.replace(/\.md$/, '') });
    }
    sources.push(...attachments.sources);
    const materialBudget = Math.max(1200, this.plugin.budget('chat') - historyTokens);
    const clamped = clampToTokens(noteBlock + attachments.blocks, materialBudget);
    if (clamped.truncated) {
      // Say whose limit this is. "Longer than the model can hold" blamed the
      // model for a cap the plugin sets, and left the reader with nothing to
      // do about it.
      this.appendInfoMessage(
        `Only the first ~${Math.round(materialBudget / 1000)}k tokens of this note were ` +
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
      // The same signal wiki mode sets, for the same reason: there is nothing
      // here to answer from. An empty or near-empty note is the note you have
      // open when you have just made one — ask anything general of it and the
      // honest refusal was the whole answer, while the identical question in
      // wiki mode offered a way forward. Thin is 80 characters of body,
      // roughly a title and a line: below that no question is really being
      // answered "from the note".
      //
      // Deliberately not set for a note with content. There the refusal is
      // the correct and complete answer, and a hatch under every good answer
      // would be an invitation to leave grounding by default.
      noPageMatch: noteBodyChars < 80 && !attachments.blocks,
      // The note IS the thread here. Attachments deliberately do not enter the
      // key: adding one extends the same conversation, and dropping history
      // because a pill appeared would surprise nobody in a good way.
      grounding: `note:${file?.path ?? ''}`,
    };
  }

  /**
   * The turns that a follow-up is allowed to see.
   *
   * `turns` used to be written and never read: every question built a fresh
   * Conversation holding a system prompt and that one question, so the panel
   * looked like a conversation and was not one. Asking "why?" after an answer
   * sent the model the word "why?" and nothing else.
   *
   * Two limits, both deliberate:
   *
   * Only turns sharing the current grounding key. The transcript is one
   * scroll, but the material under it changes when you switch note or mode,
   * and history from another note is worse than no history — the model
   * answers confidently about the wrong thing and the Sources row says
   * otherwise.
   *
   * And a token ceiling of its own, taken from the most recent turns
   * backwards. History competes with the retrieved material for the same
   * window, and material is what the answer has to be true to, so history
   * yields first. An answer is capped at 1024 output tokens, so a handful of
   * exchanges fits comfortably inside this.
   */
  /**
   * One model pass: open a conversation on the given prompt and history,
   * stream the reply into `body` as plain text, then replace it with one
   * markdown render. Returns the text and the conversation (so the caller
   * can delete it). Shared by the ordinary answer and by the second half of
   * a Vault answer, which is the same thing under a different prompt.
   */
  private async streamAnswer(
    engine: Awaited<ReturnType<LiteRtSpikePlugin['ensureEngine']>>,
    opts: {
      systemPrompt: string;
      history: { role: 'user' | 'assistant'; content: string }[];
      question: string;
      body: HTMLElement;
      typing: HTMLElement;
      sourcePath: string;
    }
  ): Promise<{ text: string; conversation: Conversation }> {
    const { SamplerType } = await import('@litert-lm/core');
    // System prompt, then the exchanges this question is a follow-up to.
    // The material lives in the system prompt and is rebuilt every turn, so
    // history carries only what was said — the pronouns and the "that" a
    // follow-up depends on — never a second copy of the note.
    const conversation = await engine.createConversation({
      preface: {
        messages: [
          { role: 'system', content: opts.systemPrompt + standingInstructions(this.plugin.settings.chatInstructions) },
          ...opts.history.map((t) => ({ role: t.role, content: t.content })),
        ],
      },
      sessionConfig: {
        samplerParams: { type: SamplerType.GREEDY },
        maxOutputTokens: 1024,
      },
    });
    this.activeConversation = conversation;

    const streamTextEl = opts.body.createDiv({ cls: 'gemma4-chat-stream-text' });
    let text = '';
    let firstChunk = true;
    const stream = conversation.sendMessageStreaming(opts.question);
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
          opts.typing.remove();
          firstChunk = false;
        }
        text += chunk;
        streamTextEl.setText(text);
        this.scrollToBottom();
      }
    }

    // Streaming shows plain text (cheap, no flicker); the finished
    // answer gets one proper markdown render pass.
    opts.typing.remove();
    streamTextEl.remove();
    const rendered = opts.body.createDiv({ cls: 'gemma4-chat-markdown' });
    await MarkdownRenderer.render(this.app, text, rendered, opts.sourcePath, this);
    return { text, conversation };
  }

  private groundingKey(ungrounded: boolean, wholeWiki: boolean): string {
    if (ungrounded) return 'direct';
    if (this.mode === 'vault') return 'vault';
    if (this.mode === 'wiki') return wholeWiki ? 'wiki:all' : 'wiki';
    return `note:${this.app.workspace.getActiveFile()?.path ?? ''}`;
  }

  private historyFor(grounding: string): { role: 'user' | 'assistant'; content: string }[] {
    // A share of the chat budget, not an addition to it. Adding on top
    // overflowed the smallest window: at a 4,096-token context the material
    // clamp is already 2,400, and 2,400 + history + instructions + 1,024
    // output does not fit — the kind of overrun that fails deep inside
    // generation with nothing the user can act on. What history takes here,
    // buildContext gives up in material.
    const ceiling = Math.max(600, Math.floor(this.plugin.budget('chat') * 0.15));
    const picked: { role: 'user' | 'assistant'; content: string }[] = [];
    let spent = 0;
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const t = this.turns[i];
      if (t.grounding !== grounding) continue;
      const cost = estimateTokens(t.content);
      if (spent + cost > ceiling) break;
      spent += cost;
      picked.unshift({ role: t.role, content: t.content });
    }
    // Never open on an assistant turn: a leading answer with no question in
    // front of it reads as something the user said.
    while (picked.length && picked[0].role === 'assistant') picked.shift();
    // Nor end on a user turn. One can only be there if its generation failed
    // — the assistant turn is recorded on success — and a question with no
    // answer under it invites the model to answer that one instead of this.
    while (picked.length && picked.at(-1)!.role === 'user') picked.pop();
    return picked;
  }

  private async runGeneration(question: string, ungrounded = false, wholeWiki = false, promptLabel?: string) {
    // History is chosen before the material is, because the material is
    // clamped against what history leaves behind rather than the other way
    // round: a follow-up whose "that" has fallen out of context is a wrong
    // answer, while a note truncated a few hundred tokens earlier is a
    // shorter one.
    const history = this.historyFor(this.groundingKey(ungrounded, wholeWiki));
    const historyTokens = history.reduce((n, t) => n + estimateTokens(t.content), 0);
    // Vault mode reads the vault before it can say anything; say that it is
    // reading. Removed as soon as the context is built, so the line never
    // outlives the search it describes.
    const searching =
      this.mode === 'vault' && !ungrounded
        ? this.messagesEl.createDiv({
            cls: 'gemma4-chat-row gemma4-chat-row-assistant gemma4-chat-searching',
            text: `Searching ${this.app.vault.getMarkdownFiles().length} notes…`,
          })
        : null;
    this.emptyStateEl.hide();
    this.scrollToBottom();
    let context: Awaited<ReturnType<ChatView['buildContext']>>;
    try {
      context = await this.buildContext(question, ungrounded, wholeWiki, historyTokens);
    } finally {
      searching?.remove();
    }
    if (!context) return;

    // Recorded here, not at the input box: this is the first point at which
    // the question's grounding is known, and every entry point — typing, a
    // chip, a skill, the ungrounded hatch — passes through it.
    this.turns.push({ role: 'user', content: question, grounding: context.grounding });

    this.busy = true;
    this.stopRequested = false;
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

      // Vault mode says what it found before anything streams. Nothing: one
      // line, so the model's own answer underneath is never mistaken for a
      // reading of the notes. A list: the notes themselves, as links, drawn
      // by the plugin — the model's lines follow and can be wrong, the links
      // cannot. Both are visible while the model is still thinking.
      if (context.vault?.kind === 'none') {
        body.createDiv({
          cls: 'gemma4-chat-vault-none',
          text: 'Nothing in your notes on this — Gemma 4 E4B answers on its own.',
        });
      } else if (context.vault?.kind === 'list') {
        const list = body.createDiv({ cls: 'gemma4-chat-vault-list' });
        list.createSpan({ cls: 'gemma4-chat-vault-list-label', text: `${context.vault.hits.length} matching notes` });
        for (const hit of context.vault.hits) {
          const a = list.createEl('a', { cls: 'gemma4-chat-source-link', text: hit.title });
          a.addEventListener('click', (evt) => {
            evt.preventDefault();
            void this.app.workspace.openLinkText(hit.linkPath, '', false);
          });
        }
      } else if (context.vault?.kind === 'both') {
        body.createDiv({ cls: 'gemma4-chat-part-label', text: 'From your notes' });
      } else if (context.vault?.kind === 'overview') {
        body.createDiv({ cls: 'gemma4-chat-part-label', text: 'From the shape of your vault' });
      }

      const first = await this.streamAnswer(engine, {
        systemPrompt: context.systemPrompt,
        history,
        question,
        body,
        typing,
        sourcePath: context.sourcePath,
      });
      conversation = first.conversation;
      answer = first.text;

      if (context.ungrounded) {
        // Ungrounded answer: no sources, an explicit warning label so it is
        // never mistaken for a grounded, citable answer.
        const warnRow = body.createDiv({ cls: 'gemma4-chat-sources' });
        warnRow.createSpan({
          cls: 'gemma4-chat-sources-label',
          text: '⚠ Gemma general knowledge — not from your notes',
        });
      } else if (context.vault?.kind !== 'list') {
        // Deterministic source attribution: list exactly the notes/pages the
        // answer was grounded in, as clickable links — not left to the model.
        // A list answer already drew them above the model's lines.
        const sourcesRow = body.createDiv({ cls: 'gemma4-chat-sources' });
        this.sourcesLabel(sourcesRow, context.grounding);
        for (const src of context.sources) {
          const link = sourcesRow.createEl('a', { cls: 'gemma4-chat-source-link', text: src.title });
          link.addEventListener('click', (evt) => {
            evt.preventDefault();
            void this.app.workspace.openLinkText(src.linkPath, '', false);
          });
        }
      }

      // The second half of a Vault answer: the model on its own, under its
      // own label and its own warning. A second conversation rather than a
      // second section of the first, because a 4B model asked to keep "what
      // the notes say" and "what I know" apart in one reply lets them bleed;
      // two prompts with different rules cannot. The transcript carries both
      // in one turn so a follow-up sees what was actually said.
      if (context.vault?.kind === 'both' && !this.stopRequested) {
        body.createDiv({ cls: 'gemma4-chat-part-label gemma4-chat-part-label-adds', text: 'Gemma 4 E4B adds' });
        const typing2 = this.showTypingIndicator(body);
        const second = await this.streamAnswer(engine, {
          systemPrompt: ADDS_PROMPT,
          history: [],
          question,
          body,
          typing: typing2,
          sourcePath: context.sourcePath,
        });
        conversation = second.conversation;
        const warnRow = body.createDiv({ cls: 'gemma4-chat-sources' });
        warnRow.createSpan({
          cls: 'gemma4-chat-sources-label',
          text: '⚠ Gemma general knowledge — not from your notes',
        });
        answer = `${answer}\n\n---\n**Gemma 4 E4B adds (not from your notes):**\n\n${second.text}`;
      }

      this.turns.push({
        role: 'assistant',
        content: answer,
        sources: context.ungrounded ? [] : context.sources,
        grounding: context.grounding,
      });
      void this.persistThread();
      // Ungrounded answers can't be saved to the wiki — filing model guesses
      // as sourced pages is exactly the pollution the grounding model avoids.
      this.addAssistantActions(row, () => answer, question, context.sources, !context.ungrounded, promptLabel);

      // Routing (issue #7, widened). Two signals say the question was asked
      // in the wrong mode: retrieval found nothing to ground in, or the
      // answer is the model declining — "I do not have access", "the note
      // does not mention", "is unclear". Either way the card under the answer
      // names the modes that could answer, and re-asks there in one click.
      // Default stays grounded; the escalation is explicit and per answer.
      // A collection-shaped question answered from four raw notes is a
      // shallow answer, and Vault cannot do better — the cards can. Say so
      // under the answer, with the count that makes it concrete, or with the
      // button that starts building them.
      if (context.vault && looksLikeCollectionQuery(question)) {
        const { cards } = this.wikiCounts();
        const card = body.createDiv({ cls: 'gemma4-chat-hatch gemma4-chat-route' });
        if (cards > 0) {
          card.createDiv({
            cls: 'gemma4-chat-route-text',
            text: `Questions across your whole collection are what Wiki is for — you have ${cards} card${cards === 1 ? '' : 's'}.`,
          });
          const b = card.createDiv({ cls: 'gemma4-chat-route-actions' }).createEl('button', { cls: 'gemma4-chat-hatch-btn', text: 'Ask the wiki' });
          b.addEventListener('click', () => {
            if (this.busy) return;
            b.disabled = true;
            this.setMode('wiki');
            void this.runGeneration(question, false, true);
          });
        } else {
          card.createDiv({
            cls: 'gemma4-chat-route-text',
            text: `Questions across your whole collection are what Wiki is for. Build cards with Scan a folder first — nothing is in ${wikiDir()}/ yet.`,
          });
          const b = card.createDiv({ cls: 'gemma4-chat-route-actions' }).createEl('button', { cls: 'gemma4-chat-hatch-btn', text: 'Scan a folder' });
          b.addEventListener('click', () => this.runSuggestion({ label: 'Scan a folder', action: 'scan' }));
        }
      }

      // Vault mode carries no other card: it already searched, and what it
      // did not find it said. The two narrower modes route to it.
      const refused = looksLikeRefusal(answer);
      if (!context.vault && !context.ungrounded && (context.noPageMatch || refused)) {
        const inNote = context.grounding.startsWith('note:');
        this.routeCard(
          body,
          inNote
            ? 'Not in this note? The wiki it built, or every note in your vault:'
            : 'Not in the wiki? The note you have open, or every note in your vault:',
          question,
          inNote ? ['wiki', 'vault'] : ['note', 'vault']
        );
      }

      this.scrollToBottom();
    } catch (err) {
      console.error('[gemma-litert-wiki] chat failed', err);
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
