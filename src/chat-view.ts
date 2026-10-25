import {
  asksAboutOwnNotes,
  dedupeByName,
  describedForList,
  excerptAround,
  formatVaultTree,
  looksLikeCollectionQuery,
  looksLikeListQuery,
  looksLikeRecentQuery,
  looksLikeRefusal,
  parseExpansion,
  rankVaultDocs,
  rescoreWithBodies,
  standingInstructions,
  stripLeadingRefusal,
  subjectOf,
  followUpQuery,
  groundingKeyFor,
  pickHistory,
  VAULT_MATCH_MIN,
  vaultHistoryText,
  weightedTerms,
  type VaultDoc,
} from './pure';
import {
  App,
  FuzzySuggestModal,
  ItemView,
  Menu,
  MarkdownRenderer,
  SuggestModal,
  getAllTags,
  setIcon,
  setTooltip,
  TFile,
  WorkspaceLeaf,
  normalizePath,
} from 'obsidian';
import type { Conversation } from '@litert-lm/core';
import {
  archiveThread,
  capThread,
  parseHistory,
  removeThread,
  serializeHistory,
  type ArchivedThread,
} from './chat-archive';
import { textOf } from './model-output';
import { t, tn } from './i18n';
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
import { notify, failureText } from './notify';

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
    this.setPlaceholder(t('chat.attachPlaceholder'));
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

const newThreadId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * 🕘: past threads, most recent first, searchable by their questions. A
 * SuggestModal rather than a dropdown of our own, so it looks, scrolls and
 * takes the keyboard the way every other list in Obsidian does.
 */
class ChatHistoryModal extends SuggestModal<ArchivedThread> {
  private threads: ArchivedThread[];
  private handlers: { onPick: (t: ArchivedThread) => void; onDelete: (id: string) => void };

  constructor(
    app: App,
    threads: ArchivedThread[],
    handlers: { onPick: (t: ArchivedThread) => void; onDelete: (id: string) => void }
  ) {
    super(app);
    this.threads = threads;
    this.handlers = handlers;
    this.setPlaceholder(t('chat.history.placeholder'));
    this.emptyStateText = t('chat.history.noMatch');
    this.setInstructions([
      { command: '↵', purpose: t('chat.history.reopen') },
      { command: 'esc', purpose: t('chat.history.close') },
    ]);
  }

  getSuggestions(query: string): ArchivedThread[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.threads;
    // Every question in the thread, not only the first: a chat is often
    // remembered by where it ended up.
    return this.threads.filter((t) =>
      t.turns.some((turn) => turn.role === 'user' && turn.content.toLowerCase().includes(q))
    );
  }

  renderSuggestion(thread: ArchivedThread, el: HTMLElement): void {
    el.addClass('gemma4-history-item');
    setIcon(el.createSpan({ cls: 'gemma4-history-icon' }), scopes()[thread.mode].icon);
    const text = el.createDiv({ cls: 'gemma4-history-text' });
    text.createDiv({ cls: 'gemma4-history-title', text: thread.title });
    const asked = thread.turns.filter((t) => t.role === 'user').length;
    text.createDiv({
      cls: 'gemma4-history-meta',
      text: tn('chat.history.meta', asked, {
        mode: scopes()[thread.mode].label,
        when: window.moment(thread.savedAt).fromNow(),
      }),
    });
    const del = el.createEl('button', {
      cls: 'gemma4-history-delete',
      attr: { 'aria-label': t('chat.history.delete', { title: thread.title }) },
    });
    setIcon(del, 'trash-2');
    setTooltip(del, t('chat.history.deleteTip'));
    del.addEventListener('mousedown', (evt) => evt.stopPropagation());
    del.addEventListener('click', (evt) => {
      // The row underneath is "reopen"; this button must not also be that.
      evt.preventDefault();
      evt.stopPropagation();
      this.handlers.onDelete(thread.id);
      this.threads = this.threads.filter((t) => t.id !== thread.id);
      if (!this.threads.length) {
        this.close();
        return;
      }
      this.inputEl.dispatchEvent(new Event('input'));
    });
  }

  onChooseSuggestion(thread: ArchivedThread): void {
    this.handlers.onPick(thread);
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
      { label: t('chat.chip.findNotes'), fill: 'Which of my notes are about: ' },
      { label: t('chat.chip.explain'), fill: 'Explain, in plain terms: ' },
      { label: t('chat.chip.outline'), fill: 'Draft a short outline for: ' },
    ];
  }
  if (mode === 'note') {
    // "Key points" went: it and "Summarize" are the same operation in two
    // layouts, and they were two of the three slots. The freed slot goes to
    // the action that was missing entirely — This-note mode had no way to put
    // the note you are looking at into the wiki, even though actions can ONLY
    // live in this row and that one is the plugin's core loop.
    return [
      { label: t('chat.chip.summarize'), ask: 'Summarize this note' },
      { label: t('chat.chip.tidy'), action: 'improve' },
      { label: t('chat.chip.addToWiki'), action: 'ingest' },
    ];
  }
  // Fixed, and the same whatever state the wiki is in.
  //
  // An earlier version swapped these out for "Scan a folder / File this note"
  // when nothing was filed yet. It meant the row you learned was not the row
  // you kept, and it hid Find connections from the person most likely to be
  // wondering what this thing does. Asking a wiki question against an empty
  // wiki now simply answers "there is nothing here", and that answer carries
  // the buttons to fix it — the remedy travels with the problem instead of
  // rearranging the furniture in advance.
  //
  // Two, because the row is permanent screen space and only two things
  // earn it. Scan takes one because it is an action, and a skill file is
  // frontmatter plus a prompt with no way to express "do this". Find
  // connections is the question this mode exists for, and the one whose
  // answer is not already sitting in a file you could open — which is what
  // ruled out "What's in my wiki?" (index.md) and, in the end, "Added
  // recently?" too: that list is index.md, dated, without asking anything.
  // "What's still open?" went the same way, to the ⚡ menu's Find gaps.
  return [
    { label: t('chat.chip.scan'), action: 'scan' },
    {
      label: t('chat.chip.connections'),
      ask: 'What connections or common themes link the pages in my wiki? Cite the pages.',
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
/**
 * The most notes a grounded answer will ever quote, whatever the budget
 * allows. Past a dozen the answer stops being "what your notes say" and
 * becomes a digest, and the Sources row stops being readable at a glance.
 */
const VAULT_MAX_NOTES = 12;
/** Below this much budget left, there is no room for a paragraph worth reading. */
const VAULT_NOTE_MIN = 300;

/**
 * The subject of a search, expanded by the model before the search runs.
 * Lexical search finds the word it is given; "js" finds main.js and misses
 * the note on closures that never spells out JavaScript. Asked first what
 * "js" is and what it covers, the model hands back javascript, ecmascript,
 * closures and their Chinese and Japanese names — and the search finds the
 * notes that are about it.
 */
const EXPAND_PROMPT =
  'You expand a search subject into keywords for finding notes in a personal vault. Reply with ' +
  'up to 8 keywords, one per line, and nothing else: the full name of any abbreviation, close ' +
  'synonyms, the two or three most specific sub-topics, and the usual Chinese and Japanese names ' +
  'when the subject is technical. Every keyword must be one that would appear in a note ABOUT ' +
  'the subject and rarely in notes about other things — never generic words like web, app, ' +
  'code, data, system, tool. Single words or short phrases only. No numbering, no ' +
  'explanations, no sentences.';

/** The model on its own: no notes, and it must not pretend otherwise. */
/** The first half of a grounded Vault answer: what the notes below say, and nothing else. */
const groundedVaultPrompt = (material: string): string =>
  "Use ONLY the notes below, from the user's own vault, to answer the first part of this " +
  'reply: what their notes say about the question. Quote or paraphrase what is there, name ' +
  'the note it came from, and say plainly if the notes touch the subject without answering ' +
  'it. Never claim a note says something it does not, and never invent detail and present ' +
  'it as theirs. Do not add general knowledge here — that comes separately, after.\n\n' +
  'The notes below are the ONLY material. Earlier turns in this conversation are not ' +
  'material: a note named in an earlier answer is not available to you now unless it is ' +
  'below. Never name, cite or summarise a note that is not below.\n\n' +
  'A note is named ONLY by the title in its "## Note:" header. Headings and numbered ' +
  'sections inside a note are parts of that note, not notes of their own — never list ' +
  'them as if they were separate notes.\n\n' +
  'If the user asks you to work with the material — summarise, list actions, turn into ' +
  'questions — do that from the notes. If the request is unclear, say you did not follow ' +
  'it rather than reporting that the notes lack something.\n\n' +
  'Be concise. You may use markdown.\n\n' +
  material;

const DIRECT_PROMPT =
  "Answer the user's question from your own general knowledge. You do NOT have access to " +
  "the user's notes or wiki here — never claim a fact came from them. If you are unsure, " +
  'say so plainly. Be concise. You may use markdown.';

/**
 * What each mode reads, said once per surface: as a row in the empty panel,
 * and as an item in the menu behind the scope button under the box. The two
 * are the same switch, so they share one table — the panel used to describe
 * each mode in three places (the empty state, the placeholder and the pills),
 * in three different wordings. `{wiki}` is filled in from the setting; the
 * folder is named as a folder so a reader who has never heard the word
 * "wiki" knows where to look.
 */
const scopes = (): Record<ChatMode, { label: string; icon: string; desc: string; title: string }> => ({
  note: {
    label: t('chat.scope.note.label'),
    icon: 'file-text',
    desc: t('chat.scope.note.desc'),
    title: t('chat.scope.note.title'),
  },
  vault: {
    label: t('chat.scope.vault.label'),
    icon: 'database',
    desc: t('chat.scope.vault.desc'),
    title: t('chat.scope.vault.title'),
  },
  wiki: {
    label: t('chat.scope.wiki.label'),
    icon: 'library',
    desc: t('chat.scope.wiki.desc', { wiki: wikiDir() }),
    title: t('chat.scope.wiki.title', { wiki: wikiDir() }),
  },
});

/** Append a translated sentence whose `{b}` is a bold word. */
function appendWithBold(el: HTMLElement, sentence: string, bold: string): void {
  const [before, after = ''] = sentence.split('{b}');
  el.appendText(before);
  el.createEl('b', { text: bold });
  el.appendText(after);
}

const SCOPE_ORDER: ChatMode[] = ['note', 'vault', 'wiki'];

/**
 * A button in a route card: the next step after a refusal, so it reads as
 * one — the brand colour and the target mode's icon. In the hatch's grey it
 * was the same pill as the source tag above it.
 */
function routeButton(parent: HTMLElement, label: string, icon: string): HTMLButtonElement {
  const btn = parent.createEl('button', { cls: 'gemma4-chat-route-btn' });
  setIcon(btn.createSpan({ cls: 'gemma4-chat-route-btn-icon' }), icon);
  btn.createSpan({ text: label });
  return btn;
}

/** Where past threads live: the plugin's own folder, never the vault. */
const HISTORY_FILE = 'chat-history.json';

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
  /** The one mode switch under the box: names the mode, opens the menu of all three. */
  private scopeButton: HTMLButtonElement | null = null;
  private inputWrap!: HTMLElement;
  /** The one-time pointer at the scope button, shown under a first answer. */
  private scopeHintEl: HTMLElement | null = null;
  /** The open scope menu, and what removes its outside-click listener. */
  private scopeMenuEl: HTMLElement | null = null;
  private scopeMenuCleanup: (() => void) | null = null;
  /** History writes run one after another, so two quick ＋ presses cannot interleave. */
  private historyWrite: Promise<void> = Promise.resolve();
  /** Set by Stop; a two-part Vault answer checks it before starting part two. */
  private stopRequested = false;
  /** The "Searching N notes…" line, while a Vault search runs; the expansion is written into it. */
  private searchingEl: HTMLElement | null = null;
  /** Subject → the model's expansion, so a repeated subject costs no second call. */
  private expansions = new Map<string, string[]>();
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
        attr: { 'aria-label': t('chat.removeAttached') },
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
    // A pill whose note has been deleted or renamed out from under it: drop
    // it rather than throw. The vault-delete listener catches the common
    // case, but a rename or an external change can still land here.
    this.attachedFiles = this.attachedFiles.filter((f) => this.app.vault.getAbstractFileByPath(f.path) === f);
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

    // Two lines about the mode you are in — what it is, and exactly what it
    // reads, naming the note or the folder rather than describing them — then
    // the three modes as one switch. The panel used to explain the other two
    // modes in prose, again in the placeholder, and again as the pills; a new
    // user read three paragraphs and still had to find the buttons.
    const all = scopes();
    const scope = all[this.mode];
    const wikiEmpty = this.mode === 'wiki' && this.wikiEmpty;
    const file = this.app.workspace.getActiveFile();
    el.createDiv({
      cls: 'gemma4-chat-empty-title',
      text: wikiEmpty ? t('chat.empty.wikiEmptyTitle', { wiki: wikiDir() }) : scope.title,
    });
    const reads =
      this.mode === 'wiki'
        ? wikiEmpty
          ? t('chat.empty.wikiEmpty')
          : t('chat.empty.wiki')
        : this.mode === 'vault'
          ? t('chat.empty.vault')
          : file
            ? t('chat.empty.note', { note: file.basename })
            : t('chat.empty.noNote');
    el.createDiv({ cls: 'gemma4-chat-empty-hint', text: reads });

    // The switch itself. Real buttons in a radio group, so Tab and the
    // screen reader both find them; the scope button under the box is the
    // same switch for once the conversation has started.
    // Named by its heading through aria-labelledby, not aria-label: Obsidian
    // turns every aria-label into a hover tooltip, and "Answer from" floated
    // over the rows whenever the pointer crossed them.
    const headingId = `gemma4-scope-heading-${newThreadId()}`;
    el.createDiv({ cls: 'gemma4-chat-scope-heading', text: t('chat.scope.heading'), attr: { id: headingId } });
    const group = el.createDiv({
      cls: 'gemma4-chat-scope-list',
      attr: { role: 'radiogroup', 'aria-labelledby': headingId },
    });
    for (const mode of SCOPE_ORDER) {
      const s = all[mode];
      const on = mode === this.mode;
      const row = group.createEl('button', {
        cls: on ? 'gemma4-chat-scope-row is-active' : 'gemma4-chat-scope-row',
        attr: { role: 'radio', 'aria-checked': on ? 'true' : 'false' },
      });
      setIcon(row.createSpan({ cls: 'gemma4-chat-scope-row-icon' }), s.icon);
      const text = row.createSpan({ cls: 'gemma4-chat-scope-row-text' });
      text.createSpan({ cls: 'gemma4-chat-scope-row-name', text: s.label });
      text.createSpan({ cls: 'gemma4-chat-scope-row-desc', text: s.desc });
      if (on) setIcon(row.createSpan({ cls: 'gemma4-chat-scope-row-check' }), 'check');
      row.addEventListener('click', () => {
        if (mode !== this.mode) this.setMode(mode);
        // Point at the button under the box: the same switch, and the only one
        // left once a question has been sent.
        this.pulseScopeButton();
      });
    }
    const caption = el.createDiv({ cls: 'gemma4-chat-scope-caption' });
    appendWithBold(caption, t('chat.scope.caption'), `${scope.label} ▾`);
  }

  /** Draw the scope button under the box for the current mode. */
  private renderScopeButton() {
    const btn = this.scopeButton;
    if (!btn) return;
    const s = scopes()[this.mode];
    btn.empty();
    setIcon(btn.createSpan({ cls: 'gemma4-chat-scope-icon' }), s.icon);
    btn.createSpan({ text: s.label });
    setIcon(btn.createSpan({ cls: 'gemma4-chat-scope-chevron' }), 'chevron-down');
    btn.setAttribute('aria-label', t('chat.scope.buttonLabel', { mode: s.label }));
    setTooltip(btn, t('chat.scope.buttonTip'));
  }

  /**
   * The menu behind the scope button, drawn by the plugin rather than with
   * Obsidian's Menu. With native menus on (the macOS default), Menu is handed
   * to the OS, which keeps only plain text: the icons went, and each mode's
   * name and description ran together on one line.
   */
  private openScopeMenu() {
    if (this.scopeMenuEl) {
      this.closeScopeMenu();
      return;
    }
    this.dismissScopeHint();
    const btn = this.scopeButton;
    if (!btn) return;
    // aria-labelledby, not aria-label, which Obsidian shows as a tooltip.
    const headingId = `gemma4-scope-menu-heading-${newThreadId()}`;
    const menu = this.inputWrap.createDiv({
      cls: 'gemma4-scope-menu',
      attr: { role: 'menu', 'aria-labelledby': headingId },
    });
    menu.createDiv({ cls: 'gemma4-scope-menu-heading', text: t('chat.scope.heading'), attr: { id: headingId } });
    const items: HTMLButtonElement[] = [];
    const all = scopes();
    for (const mode of SCOPE_ORDER) {
      const s = all[mode];
      const on = mode === this.mode;
      const item = menu.createEl('button', {
        cls: on ? 'gemma4-scope-menu-item is-active' : 'gemma4-scope-menu-item',
        attr: { role: 'menuitemradio', 'aria-checked': on ? 'true' : 'false' },
      });
      setIcon(item.createSpan({ cls: 'gemma4-scope-menu-icon' }), s.icon);
      const text = item.createSpan({ cls: 'gemma4-scope-menu-text' });
      text.createSpan({ cls: 'gemma4-scope-menu-name', text: s.label });
      text.createSpan({ cls: 'gemma4-scope-menu-desc', text: s.desc });
      if (on) setIcon(item.createSpan({ cls: 'gemma4-scope-menu-check' }), 'check');
      item.addEventListener('click', () => {
        this.closeScopeMenu();
        if (mode !== this.mode) this.setMode(mode);
        btn.focus();
      });
      items.push(item);
    }
    menu.addEventListener('keydown', (evt) => {
      const at = items.indexOf(activeDocument.activeElement as HTMLButtonElement);
      if (evt.key === 'ArrowDown' || evt.key === 'ArrowUp') {
        evt.preventDefault();
        const step = evt.key === 'ArrowDown' ? 1 : items.length - 1;
        items[(at + step) % items.length].focus();
      } else if (evt.key === 'Escape') {
        evt.preventDefault();
        evt.stopPropagation();
        this.closeScopeMenu();
        btn.focus();
      } else if (evt.key === 'Tab') {
        this.closeScopeMenu();
      }
    });
    // Above the button, wherever the toolbar has wrapped it to.
    const wrap = this.inputWrap.getBoundingClientRect();
    const at = btn.getBoundingClientRect();
    menu.setCssStyles({ left: `${at.left - wrap.left}px`, bottom: `${wrap.bottom - at.top + 6}px` });
    // A press anywhere else closes it, the way a menu does.
    const onPointer = (evt: MouseEvent) => {
      const target = evt.target as Node;
      if (!menu.contains(target) && !btn.contains(target)) this.closeScopeMenu();
    };
    activeDocument.addEventListener('mousedown', onPointer, true);
    this.scopeMenuCleanup = () => activeDocument.removeEventListener('mousedown', onPointer, true);
    this.scopeMenuEl = menu;
    btn.setAttribute('aria-expanded', 'true');
    items[SCOPE_ORDER.indexOf(this.mode)]?.focus();
  }

  private closeScopeMenu() {
    this.scopeMenuCleanup?.();
    this.scopeMenuCleanup = null;
    this.scopeMenuEl?.remove();
    this.scopeMenuEl = null;
    this.scopeButton?.setAttribute('aria-expanded', 'false');
  }

  /** Draw the eye to the scope button, without moving anything. */
  private pulseScopeButton() {
    const btn = this.scopeButton;
    if (!btn) return;
    btn.removeClass('is-pulsing');
    // Restart the animation even when it is already running.
    void btn.offsetWidth;
    btn.addClass('is-pulsing');
    window.setTimeout(() => btn.removeClass('is-pulsing'), 900);
  }

  /**
   * The pointer at the scope button, shown from the first time the panel
   * opens until it is answered: Got it, or opening the menu it points at.
   * Once the first question is sent, the empty panel and its three rows are
   * gone and this button is the only switch left — and a button that names
   * the current mode reads, unexplained, as a label.
   */
  private showScopeHint() {
    if (this.plugin.settings.scopeHintSeen || this.scopeHintEl || !this.scopeButton) return;
    const hint = this.inputWrap.createDiv({ cls: 'gemma4-chat-scope-hint', attr: { role: 'status' } });
    hint.createDiv({ cls: 'gemma4-chat-scope-hint-text' });
    const ok = hint.createEl('button', { cls: 'gemma4-chat-scope-hint-ok', text: t('chat.scope.gotIt') });
    ok.addEventListener('click', () => this.dismissScopeHint());
    this.scopeHintEl = hint;
    this.renderScopeHintText();
    this.placeScopeHint();
  }

  /** The hint names the current mode and the other two, so it follows a switch. */
  private renderScopeHintText() {
    const text = this.scopeHintEl?.querySelector('.gemma4-chat-scope-hint-text');
    if (!(text instanceof HTMLElement)) return;
    const all = scopes();
    const others = SCOPE_ORDER.filter((m) => m !== this.mode).map((m) => all[m].label);
    text.empty();
    appendWithBold(
      text,
      t('chat.scope.hint', { others: others.join(t('chat.scope.hintOr')) }),
      all[this.mode].label
    );
  }

  /**
   * Above the button it points at, wherever the toolbar has wrapped it to.
   * A panel opened collapsed has no layout yet; onResize places it once it
   * has one.
   */
  private placeScopeHint() {
    const hint = this.scopeHintEl;
    const btn = this.scopeButton;
    if (!hint || !btn) return;
    const at = btn.getBoundingClientRect();
    hint.toggleClass('is-unplaced', at.width === 0);
    if (at.width === 0) return;
    const wrap = this.inputWrap.getBoundingClientRect();
    hint.setCssStyles({ left: `${at.left - wrap.left}px`, bottom: `${wrap.bottom - at.top + 10}px` });
  }

  /**
   * Close the pointer for good: it has been seen, and said what it had to.
   * Not if it never got on screen — a pointer nobody saw has not done its job.
   */
  private dismissScopeHint() {
    const hint = this.scopeHintEl;
    if (!hint) return;
    const seen = !hint.hasClass('is-unplaced');
    hint.remove();
    this.scopeHintEl = null;
    if (seen && !this.plugin.settings.scopeHintSeen) {
      this.plugin.settings.scopeHintSeen = true;
      void this.plugin.saveSettings();
    }
  }

  onResize(): void {
    this.placeScopeHint();
    // A menu left open while the panel changes width would point at nothing.
    this.closeScopeMenu();
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
      scan: t('chat.chip.scanTip'),
      ingest: t('chat.chip.ingestTip'),
      improve: t('chat.chip.improveTip'),
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
      const label = isScanChip && scanning ? t('chat.chip.stopScan') : spec.label;
      const chip = this.suggestionRow.createEl('button', {
        cls: spec.action ? 'gemma4-chat-suggestion gemma4-chat-suggestion-write' : 'gemma4-chat-suggestion',
      });
      if (spec.action) setIcon(chip.createSpan(), isScanChip && scanning ? 'square' : ACTION_ICON[spec.action]);
      chip.createSpan({ text: label });
      if (isScanChip && scanning) {
        chip.addClass('gemma4-chat-suggestion-running');
        setTooltip(chip, t('chat.chip.stopScanTip'));
        chip.addEventListener('click', () => {
          this.plugin.cancelScan();
          notify('info', t('chat.chip.stopping'));
        });
        continue;
      }
      if (busy) {
        chip.disabled = true;
        chip.addClass('gemma4-chat-suggestion-disabled');
        setTooltip(chip, t('chat.busy', { what: this.plugin.runningLabel() ?? t('chat.busySomething') }));
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
      notify('noop', t('chat.saveNothing'));
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
        notify('done', t('chat.saved', { path: notePath }));
      })().catch((err) => {
        console.error('[gemma-litert-wiki] saving the conversation failed', err);
        notify('error', t('chat.saveFailed', { reason: err instanceof Error ? err.message : String(err) }));
      });
    }, t('chat.reviewBeforeWriting')).open();
  }

  /**
   * ＋: move the thread on screen into history and start an empty one.
   *
   * This replaced a bin that deleted the thread outright. Starting over is
   * the common case and should cost nothing; deleting is the rare one, and
   * lives in the history list, one thread at a time.
   */
  private async newChat() {
    if (this.busy) {
      this.stopRequested = true;
      this.activeConversation?.cancel();
    }
    await this.updateHistory((h) => archiveThread(h, this.turns, Date.now(), newThreadId));
    this.showEmptyThread();
    this.inputEl.focus();
  }

  private showEmptyThread() {
    this.lastQuestion = null;
    this.turns = [];
    this.messagesEl.empty();
    this.buildEmptyState();
    // The saved copy goes too, or the next open would bring the thread back.
    void this.persistThread();
  }

  private historyPath(): string {
    const dir = this.plugin.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.plugin.manifest.id}`;
    return normalizePath(`${dir}/${HISTORY_FILE}`);
  }

  private async loadHistory(): Promise<ArchivedThread[]> {
    const adapter = this.app.vault.adapter;
    const path = this.historyPath();
    try {
      return (await adapter.exists(path)) ? parseHistory(await adapter.read(path)) : [];
    } catch (err) {
      console.error('[gemma-litert-wiki] reading chat history failed', err);
      return [];
    }
  }

  /**
   * Read, change and write the history file as one step. Queued, so a second
   * change starts from what the first one wrote rather than from the same
   * stale read.
   */
  private updateHistory(change: (h: ArchivedThread[]) => ArchivedThread[]): Promise<void> {
    const run = async () => {
      const before = await this.loadHistory();
      const after = change(before);
      if (after === before) return;
      try {
        await this.app.vault.adapter.write(this.historyPath(), serializeHistory(after));
      } catch (err) {
        console.error('[gemma-litert-wiki] writing chat history failed', err);
        notify('error', t('chat.history.saveFailed', { reason: err instanceof Error ? err.message : String(err) }));
      }
    };
    this.historyWrite = this.historyWrite.then(run, run);
    return this.historyWrite;
  }

  private async openHistory() {
    await this.historyWrite;
    const history = await this.loadHistory();
    if (!history.length) {
      notify('noop', t('chat.history.none'));
      return;
    }
    new ChatHistoryModal(this.app, history, {
      onPick: (thread) => void this.reopenThread(thread),
      onDelete: (id) => void this.updateHistory((h) => removeThread(h, id)),
    }).open();
  }

  /**
   * Put a past thread back on screen. The one on screen goes into history
   * in its place, so reopening never loses anything, and the reopened one
   * leaves the list — it is the live thread now, and ＋ files it again.
   */
  private async reopenThread(thread: ArchivedThread) {
    if (this.busy) {
      notify('noop', t('chat.history.busy'));
      return;
    }
    await this.updateHistory((h) =>
      archiveThread(removeThread(h, thread.id), this.turns, Date.now(), newThreadId)
    );
    this.showEmptyThread();
    this.setMode(thread.mode);
    await this.renderThread(thread.turns, 'history');
    await this.persistThread();
  }

  /**
   * Keep the thread across a close (#100). Capped by capThread, because
   * unbounded plugin data is how a data.json becomes megabytes without anyone
   * noticing.
   */
  private async persistThread(): Promise<void> {
    const kept = capThread(this.turns);
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
    await this.renderThread(saved, 'session');
  }

  private async renderThread(saved: ChatTurnRecord[], from: 'session' | 'history'): Promise<void> {
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
          text: t('chat.generalKnowledge'),
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
      const name =
        was.slice('note:'.length).split('/').pop()?.replace(/\.md$/, '') ?? t('chat.restored.anotherNote');
      const lead = from === 'session' ? t('chat.restored.session') : t('chat.restored.history');
      this.appendInfoMessage(t('chat.restored.moved', { lead, name }));
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
    setTooltip(this.expandButton, this.inputExpanded ? t('chat.input.shrink') : t('chat.input.expand'));
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
    this.closeScopeMenu();
    this.activeConversation?.cancel();
    this.plugin.setChatBusy(false);
    await this.persistThread();
  }

  getViewType(): string {
    return VIEW_TYPE_CHAT;
  }

  getDisplayText(): string {
    return t('chat.viewTitle');
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
    titleRow.createSpan({ cls: 'gemma4-chat-title-badge', text: t('chat.badge') });
    // Grouped at the right so the icons sit together, not pushed to opposite
    // ends by the title's auto margin.
    const headerActions = titleRow.createDiv({ cls: 'gemma4-chat-header-actions' });
    const headerButton = (icon: string, label: string, run: () => void) => {
      const btn = headerActions.createEl('button', { cls: 'gemma4-chat-header-btn', attr: { 'aria-label': label } });
      setIcon(btn, icon);
      setTooltip(btn, label);
      btn.addEventListener('click', run);
    };
    // The per-message save keeps one answer; this keeps the thread — including
    // the questions, which are the half you cannot reconstruct from the answers.
    headerButton('save', t('chat.header.save'), () => void this.saveConversation());
    headerButton('plus', t('chat.header.new'), () => void this.newChat());
    headerButton('history', t('chat.header.history'), () => void this.openHistory());

    // The mode switch lives in the composer toolbar; the header keeps only
    // the context chip.
    this.noteChipEl = header.createDiv({ cls: 'gemma4-chat-note-chip' });

    // Message list with an empty-state hint shown until the first send.
    this.messagesEl = container.createDiv({ cls: 'gemma4-chat-messages' });
    this.buildEmptyState();

    // Input area, concept D: suggestion chips above one unified composer
    // card (Claudian-style) holding context pills, a borderless textarea,
    // and a hairline toolbar — the scope button left, tools middle, send right.
    const inputWrap = container.createDiv({ cls: 'gemma4-chat-input-wrap' });
    this.inputWrap = inputWrap;
    this.suggestionRow = inputWrap.createDiv({ cls: 'gemma4-chat-suggestion-row' });
    const composer = inputWrap.createDiv({ cls: 'gemma4-composer' });
    this.contextRow = composer.createDiv({ cls: 'gemma4-chat-context-row' });
    this.contextRow.hide();
    this.inputEl = composer.createEl('textarea', {
      cls: 'gemma4-chat-input',
      attr: { placeholder: t('chat.input.note'), rows: '3' },
    });
    const buttonRow = composer.createDiv({ cls: 'gemma4-composer-bar' });

    const modeRow = buttonRow.createDiv({ cls: 'gemma4-chat-mode-row' });
    // One button that names the mode and opens a menu of all three, in place
    // of three pills. The pills were the widest thing in the toolbar and,
    // with the empty panel and the placeholder, the third place the panel
    // explained the modes. "This note", not "Note": users repeatedly read
    // "Note" as "search my notes" and were confused when it only saw the
    // open file.
    this.scopeButton = modeRow.createEl('button', {
      cls: 'gemma4-chat-scope',
      attr: { 'aria-haspopup': 'menu' },
    });
    this.scopeButton.addEventListener('click', () => this.openScopeMenu());

    // Beside the scope button, Vault only. A statement of what will happen, not a
    // setting name: ticked, the notes are searched first; unticked, the
    // model answers alone and the chip above says so.
    this.searchBoxRow = modeRow.createEl('label', { cls: 'gemma4-chat-search-toggle' });
    this.searchBox = this.searchBoxRow.createEl('input', { attr: { type: 'checkbox' } });
    this.searchBox.checked = true;
    // Two words, not five: "Search my notes first" was the single widest
    // thing in the row and what pushed Send out of a sidebar narrower than
    // 480px. The full sentence is the tooltip, and the chip under the title
    // says the same thing at length while the box is off.
    this.searchBoxRow.appendText(t('chat.notesFirst'));
    setTooltip(this.searchBoxRow, t('chat.notesFirstTip'));
    this.searchBox.addEventListener('change', () => {
      this.searchNotes = !!this.searchBox?.checked;
      this.refreshVaultSurface();
    });

    const attachBtn = buttonRow.createEl('button', {
      cls: 'gemma4-chat-attach',
      attr: { 'aria-label': t('chat.attach') },
    });
    setIcon(attachBtn, 'plus');
    setTooltip(attachBtn, t('chat.attach'));
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
      attr: { 'aria-label': t('chat.skills') },
    });
    setIcon(skillsBtn, 'zap');
    setTooltip(skillsBtn, t('chat.skills'));
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
        label: t('chat.skills.quiz'),
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
        label: t('chat.skills.flashcards'),
        icon: 'layers',
        mode: 'note',
        prompt:
          'Create 8 flashcards from this material. Format each as **Q:** question then **A:** ' +
          'answer on the next line, with a blank line between cards.',
      },
      {
        label: t('chat.skills.gaps'),
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
        label: t('chat.skills.folders'),
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
          const want = scopes()[all[0].mode ?? 'note'].label;
          menu.addItem((item) => item.setTitle(t('chat.skills.switchTo', { mode: want })).setDisabled(true));
          menu.addSeparator();
        }
        // A skill spends the engine too, so it obeys the same one-at-a-time
        // rule as the chips rather than queueing behind whatever is running.
        const busy = this.plugin.isBusy();
        if (busy) {
          menu.addItem((item) =>
            item.setTitle(t('chat.busy', { what: this.plugin.runningLabel() ?? t('chat.busySomething') })).setDisabled(true)
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
      attr: { 'aria-label': t('chat.input.expand') },
    });
    setIcon(this.expandButton, 'maximize-2');
    setTooltip(this.expandButton, t('chat.input.expand'));
    this.expandButton.addEventListener('click', () => this.toggleInputExpand());

    this.inputEl.addEventListener('input', () => this.autoGrowInput());

    this.stopButton = buttonRow.createEl('button', { cls: 'gemma4-chat-stop' });
    setIcon(this.stopButton, 'square');
    this.stopButton.createSpan({ text: t('chat.stop') });
    this.stopButton.hide();
    // No mod-cta: it applies the theme's accent color, which defeats the
    // monochrome design (a pink theme accent turned the button pink).
    this.sendButton = buttonRow.createEl('button', { cls: 'gemma4-chat-send' });
    setIcon(this.sendButton, 'arrow-up');
    setTooltip(this.sendButton, t('chat.send'));

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

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        this.updateNoteChip();
        // The empty panel names the open note, so it follows it.
        if (this.mode === 'note') void this.renderEmptyState();
      })
    );
    // A pill for a note that has been deleted is a pill that will fail the
    // next question, and every question after it. Drop it when the note goes,
    // and redraw so the row on screen matches what will actually be read.
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        const before = this.attachedFiles.length;
        this.attachedFiles = this.attachedFiles.filter((f) => f.path !== file.path);
        if (this.attachedFiles.length !== before) this.renderContextPills();
      })
    );
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
    // After layout, so the pointer can be placed over the button it means.
    window.requestAnimationFrame(() => this.showScopeHint());
  }

  /**
   * Whether a Vault question searches the notes before the model answers.
   * Ticked by default, and ticked again every time Vault is (re)selected:
   * it is a modifier for a stretch of questions, not a setting, and a box
   * left unticked would turn "what did I write about React" into an answer
   * the model made up, with no Sources row to give it away. While unticked
   * the chip under the title and the placeholder both say so.
   */
  private searchNotes = true;
  private searchBox?: HTMLInputElement;
  private searchBoxRow?: HTMLElement;

  private vaultPlaceholder(): string {
    return this.searchNotes ? t('chat.input.vault') : t('chat.input.vaultOff');
  }

  /** Everything on screen that says whether the notes will be searched. */
  private refreshVaultSurface() {
    if (this.searchBox) this.searchBox.checked = this.searchNotes;
    this.searchBoxRow?.toggleClass('is-off', !this.searchNotes);
    if (this.mode === 'vault') this.inputEl?.setAttribute('placeholder', this.vaultPlaceholder());
    this.updateNoteChip();
  }

  private setMode(mode: ChatMode) {
    this.mode = mode;
    this.searchNotes = true;
    if (this.searchBoxRow) this.searchBoxRow.hidden = mode !== 'vault';
    this.searchBoxRow?.removeClass('is-off');
    if (this.searchBox) this.searchBox.checked = true;
    this.renderScopeButton();
    // The hint stays: a switch from the empty panel's rows, a route card or
    // the history list is not the button it points at. It names the new mode.
    this.renderScopeHintText();
    this.closeScopeMenu();
    // The placeholder says what to type into this mode and nothing more. It
    // used to name the other two modes as well — "Wiki or Vault above", for
    // pills that were below — which the empty panel's rows and the scope
    // button now do. Vault's says whether the notes will be searched, the
    // one thing that changes about its answers.
    this.inputEl?.setAttribute(
      'placeholder',
      mode === 'note'
        ? t('chat.input.note')
        : mode === 'wiki'
          ? t('chat.input.wiki', { wiki: wikiDir() })
          : this.vaultPlaceholder()
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
          ? t('chat.context.wikiEmpty', { wiki: wikiDir() })
          : tn('chat.context.cards', cards, { wiki: wikiDir() }) +
            (concepts ? tn('chat.context.concepts', concepts) : '');
      this.noteChipEl.createSpan({ text: label });
      this.noteChipEl.toggleClass('gemma4-chat-note-chip-none', cards + concepts === 0);
      return;
    }
    if (this.mode === 'vault') {
      if (!this.searchNotes) {
        setIcon(icon, 'sparkles');
        this.noteChipEl.createSpan({ text: t('chat.context.vaultOff') });
        this.noteChipEl.addClass('gemma4-chat-note-chip-none');
        return;
      }
      setIcon(icon, 'folder-search');
      const prefix = `${wikiDir()}/`;
      const n = this.app.vault.getMarkdownFiles().filter((f) => !f.path.startsWith(prefix)).length;
      this.noteChipEl.createSpan({ text: tn('chat.context.note', n) });
      this.noteChipEl.removeClass('gemma4-chat-note-chip-none');
      return;
    }
    const file = this.app.workspace.getActiveFile();
    setIcon(icon, 'file-text');
    this.noteChipEl.createSpan({
      text: file ? file.basename : t('chat.context.noNote'),
    });
    this.noteChipEl.toggleClass('gemma4-chat-note-chip-none', !file);
    if (file && getIngestedSourcePaths(this.app).has(file.path)) {
      const check = this.noteChipEl.createSpan({ cls: 'gemma4-chat-chip-check' });
      setIcon(check, 'check');
      check.setAttribute('aria-label', t('chat.context.inWiki'));
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
    row.createSpan({
      cls: 'gemma4-chat-sources-label',
      text: t(kind === 'cards' ? 'chat.sources.cards' : kind === 'notes' ? 'chat.sources.notes' : 'chat.sources.sources'),
    });
  }

  private appendUserMessage(text: string) {
    this.emptyStateEl.hide();
    const row = this.messagesEl.createDiv({ cls: 'gemma4-chat-row gemma4-chat-row-user' });
    const bubble = row.createDiv({ cls: 'gemma4-chat-bubble-user', text });
    const edit = row.createEl('button', { cls: 'gemma4-chat-edit-btn', text: t('chat.edit') });
    edit.setAttribute('aria-label', t('chat.editLabel'));
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
        text: tn('chat.edit.replaces', dropped),
      });
    }
    const cancel = actions.createEl('button', { cls: 'gemma4-chat-hatch-btn', text: t('chat.cancel') });
    const send = actions.createEl('button', { cls: 'gemma4-chat-hatch-btn', text: t('chat.askAgain') });

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

  /**
   * The answer when the search found nothing about the subject: a sentence,
   * the notes that merely name it as links, and a button. No generation runs
   * — not even the engine is loaded — so this is instant, and Vault mode
   * never produces an answer out of the model's own head that the user did
   * not ask for.
   */
  private renderNothingFound(question: string, passing: { title: string; linkPath: string }[]) {
    const { body } = this.appendAssistantMessage();
    const none = body.createDiv({ cls: 'gemma4-chat-vault-none' });
    if (passing.length) {
      none.appendText(tn('chat.nothing.passing', passing.length));
      passing.forEach((hit, i) => {
        if (i > 0) none.appendText(t('chat.listSeparator'));
        const a = none.createEl('a', { cls: 'gemma4-chat-source-link', text: hit.title });
        a.addEventListener('click', (evt) => {
          evt.preventDefault();
          void this.app.workspace.openLinkText(hit.linkPath, '', false);
        });
      });
      none.appendText(t('chat.listEnd'));
    } else {
      none.appendText(t('chat.nothing'));
    }
    const bar = body.createDiv({ cls: 'gemma4-chat-route-actions' });
    const ask = bar.createEl('button', { cls: 'gemma4-chat-hatch-btn', text: t('chat.nothing.askAnyway') });
    ask.addEventListener('click', () => {
      if (this.busy) return;
      ask.disabled = true;
      // The ungrounded path, the same one the per-answer escape hatch uses:
      // its own warning, its own history, and never filed into the wiki.
      void this.runGeneration(question, true);
    });
    // A turn, so the transcript keeps alternating and a follow-up is not sent
    // two user messages in a row. It carries what happened, not an answer.
    this.turns.push({
      role: 'assistant',
      content: t('chat.nothing.record'),
      sources: [],
      grounding: 'vault',
      historyText: '(Nothing in the notes was about this, and no answer was given.)',
    });
    void this.persistThread();
    this.scrollToBottom();
  }

  /**
   * Back to idle. One place, because busy is now raised before the context is
   * built and there are four ways out of the middle of a turn; each of them
   * forgetting one of these flags is how a panel wedges.
   */
  private releaseBusy() {
    this.activeConversation = null;
    this.busy = false;
    this.plugin.setChatBusy(false);
    this.sendButton.disabled = false;
    this.stopButton.hide();
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
      attr: { 'aria-label': t('chat.answer.copy') },
    });
    setIcon(copyBtn, 'copy');
    setTooltip(copyBtn, t('chat.answer.copy'));
    copyBtn.addEventListener('click', () => {
      void navigator.clipboard.writeText(getAnswer());
      notify('done', t('chat.answer.copied'));
    });

    const regenBtn = actions.createEl('button', {
      cls: 'gemma4-chat-action clickable-icon',
      attr: { 'aria-label': t('chat.answer.regenerate') },
    });
    setIcon(regenBtn, 'refresh-cw');
    setTooltip(regenBtn, t('chat.answer.regenerateTip'));
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
      attr: { 'aria-label': t('chat.answer.save') },
    });
    setIcon(saveBtn, 'file-plus-2');
    setTooltip(saveBtn, t('chat.answer.saveTip'));
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
          notify('done', t('chat.saved', { path: notePath }));
        })();
      }, t('chat.reviewBeforeWriting')).open();
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
      notify('warn', t('chat.busyWait', { what: this.plugin.runningLabel() ?? t('chat.busySomething') }));
      return;
    }
    const typed = opts.text === undefined;
    const question = (opts.text ?? this.inputEl.value).trim();
    if (!question) return;
    if (typed) this.inputEl.value = '';
    this.autoGrowInput();
    this.lastQuestion = question;
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
    for (const target of targets) {
      if (target === 'note' && !hasNote) continue;
      const label =
        target === 'wiki' ? t('chat.route.wiki')
        : target === 'note' ? t('chat.route.note')
        : t('chat.route.vault');
      const btn = routeButton(bar, label, scopes()[target].icon);
      buttons.push(btn);
      btn.addEventListener('click', () => {
        if (this.busy) return;
        for (const b of buttons) b.disabled = true;
        void this.askInMode(target, question);
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
   * Ask the model what a subject is and what it covers, before searching for
   * it. One short call, greedy, cached per subject. Skipped for a subject
   * that is already specific (five or more words and not short) and on any
   * failure, in which case the search runs on the typed words alone.
   */
  private async expandSubject(subject: string): Promise<string[]> {
    const key = subject.trim().toLowerCase();
    const cached = this.expansions.get(key);
    if (cached) return cached;
    if (!key || ([...key.matchAll(/\S+/g)].length >= 5 && key.length > 24)) return [];
    let terms: string[] = [];
    let conversation: Conversation | undefined;
    try {
      const engine = await this.plugin.ensureEngine(() => undefined);
      const { SamplerType } = await import('@litert-lm/core');
      conversation = await engine.createConversation({
        preface: { messages: [{ role: 'system', content: EXPAND_PROMPT }] },
        sessionConfig: { samplerParams: { type: SamplerType.GREEDY }, maxOutputTokens: 96 },
      });
      this.activeConversation = conversation;
      const message = await conversation.sendMessage(subject);
      terms = parseExpansion(textOf(message.content), subject);
    } catch (err) {
      console.warn('[gemma-litert-wiki] subject expansion skipped', err);
      terms = [];
    } finally {
      await conversation?.delete().catch(() => {});
    }
    this.expansions.set(key, terms);
    return terms;
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
    historyTokens: number,
    searchAs = question
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

    // The box beside the pills is unticked: no expansion, no search, no
    // "Searching N notes" line. Notes the user attached with + are still
    // used — "do not search" is not "ignore what I handed you" — and then
    // the answer is grounded on those alone. With nothing attached the
    // model answers from itself under the usual warning, and the line above
    // the answer says the notes were not searched, with a button that
    // ticks the box and asks again.
    if (!this.searchNotes) {
      const attachments = await this.readAttachments();
      if (attachments.blocks) {
        return {
          systemPrompt: groundedVaultPrompt(attachments.blocks),
          sourcePath: indexPath(),
          sources: attachments.sources,
          grounding: 'vault',
          vault: { kind: 'both', hits: [] },
        };
      }
      return {
        systemPrompt: DIRECT_PROMPT,
        sourcePath: indexPath(),
        sources: [],
        ungrounded: true,
        grounding: 'direct',
        vault: { kind: 'none', hits: [], skipped: true },
      };
    }

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
        vault: { kind: 'list', hits, adds: false },
      };
    }

    // "What connects my notes" is about the collection, and four raw notes
    // found by the word "connects" are noise wearing a Sources row. The
    // honest material for a collection question here is the shape of the
    // vault; the cards, in Wiki mode, are the real answer, and the line
    // under this one says so.
    const overview = () => {
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
          'it opened or asked about by name. Earlier turns in this conversation are not ' +
          'material either.\n\n' +
          'Be concise. You may use markdown.\n\n' +
          `## Folder layout\n\`\`\`\n${tree || '(empty vault)'}\n\`\`\`\n\n` +
          `## Recently edited notes\n${recent || '(none)'}`,
        sourcePath: indexPath(),
        sources: [],
        grounding: 'vault',
        vault: { kind: 'overview' as const, hits: [] },
      };
    };
    if (looksLikeCollectionQuery(question)) return overview();

    // What the subject IS, from the model, before what the notes SAY. The
    // line that said "Searching N notes…" now says what it is searching
    // for, so the reading the model gave the question is visible.
    const subject = subjectOf(searchAs);
    const extra = await this.expandSubject(subject);
    if (this.searchingEl) {
      const shown = [subject, ...extra].slice(0, 7).join(', ');
      this.searchingEl.setText(
        t('chat.searchingFor', { n: files.length, terms: `${shown}${extra.length > 6 ? '…' : ''}` })
      );
    }
    const ranked = rankVaultDocs(searchAs, docs, 80, extra);
    const rankedSet = new Set(ranked.map((h) => h.path));
    const toRead = files.length <= 400 ? files : files.filter((f) => rankedSet.has(f.path));
    const bodies = new Map<string, string>();
    for (const f of toRead) bodies.set(f.path, (await this.app.vault.cachedRead(f)).slice(0, 20000));
    // A list question asks for every note that names the subject, so the
    // bar is only "a subject term is in it"; an answer question keeps the
    // rarity threshold, since one mention of a common word is not material.
    const listQuestion = looksLikeListQuery(question);
    const allHits = dedupeByName(rescoreWithBodies(searchAs, ranked, bodies, 12, listQuestion ? 0.05 : VAULT_MATCH_MIN, extra));
    const about = allHits.filter((h) => h.tier === 'about');
    const mentions = allHits.filter((h) => h.tier === 'mentions');
    // The notes read are the ones ABOUT the subject; a note that names it
    // once in an example sentence is listed under the answer, not read into
    // it. A list question lists both, labelled.
    // A ceiling, not a quota. The notes actually read are chosen below by
    // what fits the token budget, so four long ones and a dozen short ones
    // both arrive full rather than the count deciding for the budget.
    const candidates = about.slice(0, VAULT_MAX_NOTES);
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
    for (const h of allHits) seen.set(link(h.path).base, (seen.get(link(h.path).base) ?? 0) + 1);
    const titled = (path: string) => {
      const { base, folder, linkPath } = link(path);
      return { title: (seen.get(base) ?? 0) > 1 && folder ? `${base} (${folder})` : base, linkPath };
    };

    // "What did I write about coffee" when nothing is about coffee and six
    // notes mention it: the answer is where it comes up in those six, one
    // line each — a list, followed by the model's own answer about coffee.
    // Asking the model the question as typed produced "I do not have access
    // to your notes" under a line that had just listed the notes.
    const aboutOwn = asksAboutOwnNotes(question);
    const asList = listQuestion || (aboutOwn && !candidates.length && mentions.length > 0);
    if (!candidates.length && !attachments.blocks && !(asList && mentions.length)) {
      // "What's in my vault" matches no note by its words, because it is
      // about all of them. Hand the model the shape instead.
      if (aboutOwn) return overview();
      // Nothing in the notes is ABOUT this. The model answers on its own,
      // under one line that says so — and names the notes that mention it
      // in passing, as links, so nothing found is hidden.
      return {
        // Never read: the caller sees kind 'none' without `skipped` and
        // reports what the search found instead of generating, so no prompt
        // from this branch reaches the model. The field is the shape every
        // branch returns, not an instruction.
        systemPrompt: '',
        sourcePath: indexPath(),
        sources: [],
        ungrounded: true,
        // The Vault thread, like the turn renderNothingFound records under
        // it. Filed as 'direct' the question sat in a thread nobody had
        // opened, and the follow-up to it found no question before it.
        grounding: 'vault',
        vault: { kind: 'none', hits: mentions.slice(0, 6).map((h) => ({ ...titled(h.path), tier: 'mentions' as const })) },
      };
    }

    // The same weights the ranking used, heaviest first: the excerpt of a
    // note is the text around the words that got it here.
    const terms = weightedTerms(searchAs, bodies, extra)
      .filter((w) => w.weight > 0)
      .sort((a, b) => b.weight - a.weight)
      .map(({ t, whole }) => ({ t, whole }));

    // Fill the budget, best-ranked first, instead of dividing it four ways.
    // Dividing was what a fixed count forced: four notes of three hundred
    // tokens each spent twelve hundred of four thousand eight hundred and
    // left the fifth and sixth matches unread with most of the budget
    // unspent. A note takes what it needs up to VAULT_NOTE_TOKENS, the next
    // one takes what is left, and the loop stops when what remains is too
    // small to carry a paragraph. Long notes still cap out at four or so;
    // short ones now arrive together.
    let remaining = Math.max(300, budget - estimateTokens(attachments.blocks));
    const hits: typeof candidates = [];
    let material = '';
    for (const h of candidates) {
      if (remaining < VAULT_NOTE_MIN) break;
      const body = bodies.get(h.path) ?? '';
      const src = titled(h.path);
      const share = Math.min(VAULT_NOTE_TOKENS, remaining);
      // ~3.4 chars per token for Latin text; CJK is denser, and clampToTokens
      // below catches the case where the estimate was generous.
      const block = `## Note: ${src.title} (${h.path})\n${clampToTokens(excerptAround(body, terms, share * 3), share).text}\n\n`;
      material += block;
      // What this note actually cost, not what it was allowed: a short note
      // leaves the rest for the next one, which is the whole point.
      remaining -= Math.max(estimateTokens(block), VAULT_NOTE_MIN);
      hits.push(h);
    }
    material += attachments.blocks;
    const hitSources = hits.map((h) => ({ ...titled(h.path), tier: h.tier }));
    const sources = [...attachments.sources, ...hitSources];

    if (asList && allHits.length) {
      // Every hit, about first, each labelled; the model gets an excerpt of
      // each and writes one line, told which tier the plugin put it in.
      // Described: the abouts, or the mentions when there are no abouts.
      // Shown: everything, as links — the chips row lists them all.
      const described = describedForList(about, mentions, 8);
      const shown = [...about, ...mentions].slice(0, 12);
      let listMaterial = '';
      for (const h of described) {
        const body = bodies.get(h.path) ?? '';
        const src = titled(h.path);
        const excerpt = clampToTokens(excerptAround(body, terms, 600 * 3), 600).text;
        listMaterial += `## Note: ${src.title} (${h.path}) — ${h.tier === 'about' ? 'ABOUT the subject' : 'MENTIONS it in passing'}\n${excerpt}\n\n`;
      }
      const listed2 = shown.map((h) => ({ ...titled(h.path), tier: h.tier }));
      return {
        systemPrompt:
          'The user asked which of their notes are about something. The plugin has already ' +
          'searched the vault and found the notes below — you are not being asked to search, ' +
          'and you cannot. Each note is labelled ABOUT or MENTIONS; the label is the plugin\'s ' +
          'and is not to be repeated or explained. There are ' + described.length + ' notes below. ' +
          'Write exactly ' + described.length + ' lines, one per note, in the order given, then stop. ' +
          'Each line: the note\'s title in bold, then in your own words one specific thing that ' +
          'note covers and where the subject comes up in it. Do not quote the note; describe it. ' +
          'A line that could describe any note is wrong. A MENTIONS note is usually about ' +
          'something else; say what, and how the subject appears. Do not add notes that are not ' +
          'listed. Do not summarise the subject itself.\n\n' +
          'Be concise. Use a markdown list.\n\n' +
          listMaterial,
        sourcePath: indexPath(),
        sources: listed2,
        grounding: 'vault',
        // A list is the whole answer. Someone asking which notes are about
        // JavaScript wants the notes; a paragraph on what JavaScript is under
        // them is filler, and when the subject was a folder name it was a
        // dictionary entry for "in progress". The model's own answer follows
        // a subject question, not a list question.
        vault: { kind: 'list', hits: listed2, adds: false },
      };
    }

    return {
      systemPrompt: groundedVaultPrompt(material),
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
    historyTokens = 0,
    /** The question as retrieval should read it — see followUpQuery. */
    searchAs = question
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
    vault?: {
      kind: 'none' | 'overview' | 'list' | 'both';
      hits: { title: string; linkPath: string; tier?: 'about' | 'mentions' }[];
      /** Run the model's own answer after the grounded one (a list that stood in for "what did I write about X"). */
      adds?: boolean;
      /** The box beside the pills was unticked: no search ran, and the line above the answer says so. */
      skipped?: boolean;
    };
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
      return this.buildVaultContext(question, historyTokens, searchAs);
    }
    if (this.mode === 'wiki') {
      const entries = await readIndexEntries(this.app.vault);
      if (!entries.length) {
        this.appendInfoMessage(t('chat.info.wikiEmpty', { wiki: wikiDir() }), [
          { label: t('chat.chip.scan'), action: 'scan' },
          { label: t('chat.chip.ingestThis'), action: 'ingest' },
        ]);
        return null;
      }
      // A whole-wiki question is not a retrieval problem. Scoring "what
      // connects my pages" against page summaries matches nothing, because the
      // question is about the shape of the collection and not about anything
      // in it — so every page is the right answer to "which pages", and
      // loadPages fills up to the budget and stops.
      const selected = wholeWiki ? entries : scoreEntries(searchAs, entries);
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
          t('chat.info.cutWiki', {
            k: Math.round(Math.max(1200, this.plugin.budget('chat') - historyTokens) / 1000),
          })
        );
      }
      return {
        systemPrompt:
          `Today is ${new Date().toLocaleDateString('en-CA')}. ` +
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
      this.appendInfoMessage(t('chat.info.noNote'));
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
      this.appendInfoMessage(t('chat.info.cutNote', { k: Math.round(materialBudget / 1000) }));
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
      /** Applied to the finished text before it is rendered and returned. */
      finalText?: (text: string) => string;
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
    if (opts.finalText) text = opts.finalText(text);
    const rendered = opts.body.createDiv({ cls: 'gemma4-chat-markdown' });
    await MarkdownRenderer.render(this.app, text, rendered, opts.sourcePath, this);
    return { text, conversation };
  }

  private groundingKey(ungrounded: boolean, wholeWiki: boolean): string {
    return groundingKeyFor({
      ungrounded,
      wholeWiki,
      mode: this.mode,
      searchNotes: this.searchNotes,
      // Counted the way readAttachments reads them: a pill whose note is gone
      // contributes nothing, and the turn is then filed as the model alone.
      attached: this.attachedFiles.filter((f) => this.app.vault.getAbstractFileByPath(f.path) === f).length,
      notePath: this.app.workspace.getActiveFile()?.path ?? '',
    });
  }

  private historyFor(grounding: string): { role: 'user' | 'assistant'; content: string }[] {
    // A share of the chat budget, not an addition to it. Adding on top
    // overflowed the smallest window: at a 4,096-token context the material
    // clamp is already 2,400, and 2,400 + history + instructions + 1,024
    // output does not fit — the kind of overrun that fails deep inside
    // generation with nothing the user can act on. What history takes here,
    // buildContext gives up in material.
    const ceiling = Math.max(600, Math.floor(this.plugin.budget('chat') * 0.15));
    return pickHistory(this.turns, grounding, ceiling, estimateTokens);
  }

  private async runGeneration(question: string, ungrounded = false, wholeWiki = false, promptLabel?: string) {
    // History is chosen before the material is, because the material is
    // clamped against what history leaves behind rather than the other way
    // round: a follow-up whose "that" has fallen out of context is a wrong
    // answer, while a note truncated a few hundred tokens earlier is a
    // shorter one.
    const history = this.historyFor(this.groundingKey(ungrounded, wholeWiki));
    const historyTokens = history.reduce((n, t) => n + estimateTokens(t.content), 0);
    // History reaches the model; this is what reaches the search. The last
    // thing asked that is not this same question — "Ask anyway" and
    // Regenerate re-ask the same words — whatever thread it was filed under:
    // a fragment continues what is on screen above it.
    const previous = [...this.turns].reverse().find((t) => t.role === 'user' && t.content !== question)?.content;
    const searchAs = followUpQuery(question, previous);
    // Vault mode reads the vault before it can say anything; say that it is
    // reading. Removed as soon as the context is built, so the line never
    // outlives the search it describes.
    const searching =
      this.mode === 'vault' && !ungrounded && this.searchNotes
        ? this.messagesEl.createDiv({
            cls: 'gemma4-chat-row gemma4-chat-row-assistant gemma4-chat-searching',
            text: t('chat.searching', {
              n: this.app.vault.getMarkdownFiles().filter((f) => !f.path.startsWith(`${wikiDir()}/`)).length,
            }),
          })
        : null;
    this.searchingEl = searching;
    this.emptyStateEl.hide();
    this.scrollToBottom();
    // Busy from here, not from the first token. Building the context is the
    // expensive half — in Vault mode a model call to expand the subject and a
    // read of every note body — and it used to run with every guard in the
    // plugin reading "idle": a second Enter started a genuinely concurrent
    // generation on one engine, both writing activeConversation so Stop
    // reached only one, and refuseIfBusy waved Ingest and Improve through.
    this.busy = true;
    this.stopRequested = false;
    this.plugin.setChatBusy(true);
    this.sendButton.disabled = true;
    let context: Awaited<ReturnType<ChatView['buildContext']>>;
    try {
      context = await this.buildContext(question, ungrounded, wholeWiki, historyTokens, searchAs);
    } catch (err) {
      // Reached by a stale attachment: readAttachments calls vault.read on a
      // note the user has since deleted. This used to escape runGeneration
      // entirely and land in a `void` at the call site, leaving the question
      // on screen with nothing under it, no error, and the dead pill still in
      // the list to do it again on every later question.
      console.error('[gemma-litert-wiki] building the context failed', err);
      const { body } = this.appendAssistantMessage();
      body.createDiv({
        cls: 'gemma4-chat-error',
        text: failureText(t('op.preparingAnswer'), err).text,
      });
      this.releaseBusy();
      return;
    } finally {
      searching?.remove();
      this.searchingEl = null;
    }
    if (!context) {
      this.releaseBusy();
      return;
    }

    // Recorded here, not at the input box: this is the first point at which
    // the question's grounding is known, and every entry point — typing, a
    // chip, a skill, the ungrounded hatch — passes through it.
    this.turns.push({ role: 'user', content: question, grounding: context.grounding });

    // Nothing in the notes is about this, and the box says to search them.
    // Say so and stop. Answering anyway put a paragraph the model invented
    // under a line reporting the notes had nothing — two different kinds of
    // thing, one after the other, with only a warning label between them.
    // The model is one button away and it is the user who presses it.
    // Nothing here needs the engine, so this returns before it is loaded.
    if (context.vault?.kind === 'none' && !context.vault.skipped) {
      this.renderNothingFound(question, context.vault.hits);
      this.releaseBusy();
      return;
    }

    this.stopButton.show();

    const { body, row } = this.appendAssistantMessage();
    const typing = this.showTypingIndicator(body);
    const status = body.createDiv({ cls: 'gemma4-chat-status' });

    let conversation: Conversation | undefined;
    let answer = '';
    try {
      const engine = await this.plugin.ensureEngine((text) => status.setText(text));
      status.remove();

      // Vault mode says what it found before anything streams. A search that
      // found nothing never reaches here — it reports and stops without an
      // answer (renderNothingFound), so `none` here means only that the box
      // was unticked and the model was asked deliberately. A list: the notes
      // themselves, as links, drawn by the plugin — the model's lines follow
      // and can be wrong, the links cannot.
      if (context.vault?.kind === 'none') {
        const none = body.createDiv({ cls: 'gemma4-chat-vault-none' });
        none.appendText(t('chat.vault.notSearched'));
        const again = none.createEl('button', { cls: 'gemma4-chat-hatch-btn', text: t('chat.vault.searchAgain') });
        again.addEventListener('click', () => {
          if (this.busy) return;
          again.disabled = true;
          this.searchNotes = true;
          this.refreshVaultSurface();
          void this.askInMode('vault', question);
        });
      } else if (context.vault?.kind === 'list') {
        const list = body.createDiv({ cls: 'gemma4-chat-vault-list' });
        const hits = context.vault.hits;
        const nAbout = hits.filter((h) => h.tier === 'about').length;
        const nMention = hits.length - nAbout;
        list.createSpan({
          cls: 'gemma4-chat-vault-list-label',
          text: tn('chat.vault.tally', nMention, { about: nAbout }),
        });
        for (const hit of hits) {
          const a = list.createEl('a', {
            cls: `gemma4-chat-source-link${hit.tier === 'mentions' ? ' gemma4-chat-source-mention' : ''}`,
            text: hit.title,
          });
          a.setAttribute('aria-label', hit.tier === 'about' ? t('chat.vault.about') : t('chat.vault.mentions'));
          a.addEventListener('click', (evt) => {
            evt.preventDefault();
            void this.app.workspace.openLinkText(hit.linkPath, '', false);
          });
        }
      } else if (context.vault?.kind === 'both') {
        body.createDiv({ cls: 'gemma4-chat-part-label', text: t('chat.part.notes') });
      } else if (context.vault?.kind === 'overview') {
        body.createDiv({ cls: 'gemma4-chat-part-label', text: t('chat.part.shape') });
      }

      const first = await this.streamAnswer(engine, {
        systemPrompt: context.systemPrompt,
        history,
        question,
        body,
        typing,
        sourcePath: context.sourcePath,
        finalText: context.vault?.kind === 'none' ? stripLeadingRefusal : undefined,
      });
      conversation = first.conversation;
      answer = first.text;

      if (context.ungrounded) {
        // Ungrounded answer: no sources, an explicit warning label so it is
        // never mistaken for a grounded, citable answer.
        const warnRow = body.createDiv({ cls: 'gemma4-chat-sources' });
        warnRow.createSpan({
          cls: 'gemma4-chat-sources-label',
          text: t('chat.generalKnowledge'),
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
      const groundedPart = answer;
      if ((context.vault?.kind === 'both' || context.vault?.adds) && !this.stopRequested) {
        body.createDiv({ cls: 'gemma4-chat-part-label gemma4-chat-part-label-adds', text: t('chat.part.adds') });
        const typing2 = this.showTypingIndicator(body);
        // The question is reframed, not forwarded: asked "what did I write
        // about coffee" a 4B model answers that it cannot see the notes, and
        // no system prompt talks it out of it. Asked about the subject of
        // that question, it writes about coffee. What slips through anyway
        // is trimmed after.
        const second = await this.streamAnswer(engine, {
          systemPrompt: ADDS_PROMPT,
          history: [],
          question: `About the subject of this question, from general knowledge only: ${searchAs}`,
          body,
          typing: typing2,
          sourcePath: context.sourcePath,
          finalText: stripLeadingRefusal,
        });
        // The first conversation is finished with, and the variable the
        // finally deletes is about to point at the second one: let go of the
        // first here or it is never released, once per two-part answer for
        // as long as the panel is open.
        await conversation?.delete().catch(() => {});
        conversation = second.conversation;
        const warnRow = body.createDiv({ cls: 'gemma4-chat-sources' });
        warnRow.createSpan({
          cls: 'gemma4-chat-sources-label',
          text: t('chat.generalKnowledge'),
        });
        answer = `${answer}\n\n---\n**Gemma 4 E4B adds (not from your notes):**\n\n${second.text}`;
      }

      this.turns.push({
        role: 'assistant',
        content: answer,
        sources: context.ungrounded ? [] : context.sources,
        grounding: context.grounding,
        historyText: context.vault ? vaultHistoryText(context.vault.kind, groundedPart) : undefined,
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
            text: tn('chat.route.collection', cards),
          });
          const b = routeButton(card.createDiv({ cls: 'gemma4-chat-route-actions' }), t('chat.route.wiki'), scopes().wiki.icon);
          b.addEventListener('click', () => {
            if (this.busy) return;
            b.disabled = true;
            this.setMode('wiki');
            void this.runGeneration(question, false, true);
          });
        } else {
          card.createDiv({
            cls: 'gemma4-chat-route-text',
            text: t('chat.route.collectionEmpty', { wiki: wikiDir() }),
          });
          const scan = t('chat.chip.scan');
          const b = routeButton(card.createDiv({ cls: 'gemma4-chat-route-actions' }), scan, 'folder-search');
          b.addEventListener('click', () => this.runSuggestion({ label: scan, action: 'scan' }));
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
            ? t('chat.route.fromNote')
            : t('chat.route.fromWiki'),
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
        text: t('chat.failed', { reason: err instanceof Error ? err.message : String(err) }),
      });
    } finally {
      // Release first, tidy up after. The answer is fully rendered by now, so
      // the panel LOOKS idle — but this ran `await conversation.delete()`
      // before clearing the flags, leaving a window where a press was silently
      // refused because a teardown nobody can see had not finished.
      this.releaseBusy();
      this.inputEl.focus();
      await conversation?.delete().catch(() => {});
    }
  }
}
