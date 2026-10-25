import type { Language } from './index.ts';

/**
 * The interface in English, and the list of keys every other language
 * translates (#166). A key another language lacks shows this text instead.
 *
 * `{name}` is filled in at the call site. A key ending in `.one` or `.other`
 * is a count: `tn()` picks one of the pair, and a language without plural
 * forms gives both the same text. `{b}` marks where a bold word goes.
 *
 * Prompts sent to the model, text written into the vault and the log stay in
 * English and are not here.
 */
const texts = {
  // The chat panel
  'chat.viewTitle': 'Chat with note',
  'chat.badge': 'local',
  'chat.header.save': 'Save conversation as a note',
  'chat.header.new': 'New chat',
  'chat.header.history': 'Chat history',

  'chat.scope.note.label': 'This note',
  'chat.scope.note.desc': 'Only the note you have open',
  'chat.scope.note.title': 'Ask about this note',
  'chat.scope.vault.label': 'Vault',
  'chat.scope.vault.desc': 'Any note in your vault, or anything general',
  'chat.scope.vault.title': 'Ask anything',
  'chat.scope.wiki.label': 'Wiki',
  'chat.scope.wiki.desc': 'Cards in {wiki}/ and what connects them',
  'chat.scope.wiki.title': 'Ask the cards in {wiki}/',
  'chat.scope.heading': 'Answer from',
  'chat.scope.caption': 'Change it any time with {b} under the box.',
  'chat.scope.buttonLabel': 'Answer from: {mode}. Change',
  'chat.scope.buttonTip': 'Where answers come from — click to change',
  'chat.scope.hint': 'Answers come from {b}. Switch to {others} here.',
  'chat.scope.hintOr': ' or ',
  'chat.scope.gotIt': 'Got it',

  'chat.empty.wikiEmptyTitle': 'Nothing is filed in {wiki}/ yet',
  'chat.empty.wikiEmpty': 'Press Scan a folder below to draft cards from your notes.',
  'chat.empty.wiki': 'Reads only the cards and concept pages you approved.',
  'chat.empty.vault': 'Searches every note in your vault, then Gemma 4 E4B adds its own answer — marked as its own.',
  'chat.empty.note': 'Reads only {note}, as you wrote it.',
  'chat.empty.noNote': 'Open a note to ask about it.',

  'chat.chip.findNotes': 'Find my notes on…',
  'chat.chip.explain': 'Explain a term…',
  'chat.chip.outline': 'Draft an outline…',
  'chat.chip.summarize': 'Summarize',
  'chat.chip.tidy': 'Tidy up formatting',
  'chat.chip.addToWiki': 'Add to wiki',
  'chat.chip.scan': 'Scan a folder',
  'chat.chip.connections': 'Find connections',
  'chat.chip.ingestThis': 'Ingest this note into wiki',
  'chat.chip.stopScan': 'Stop scan',
  'chat.chip.stopScanTip': 'Stop after the note being drafted right now finishes',
  'chat.chip.stopping': 'Stopping — the note being drafted right now will finish first.',
  'chat.chip.scanTip': 'Pick folders, see how many notes each holds, then draft a page for each',
  'chat.chip.ingestTip': 'Draft one wiki page from the note you have open — you review it before anything is written',
  'chat.chip.improveTip': 'Edits this note — you review before anything is written',

  'chat.busy': 'Busy: {what}',
  'chat.busyWait': 'Busy: {what}. Wait for that to finish.',
  'chat.busySomething': 'something is running',

  'chat.context.note.one': 'Your notes · {n} file',
  'chat.context.note.other': 'Your notes · {n} files',
  'chat.context.vaultOff': 'Gemma 4 E4B only · notes not searched',
  'chat.context.wikiEmpty': '{wiki}/ · empty — Scan a folder to build it',
  'chat.context.cards.one': '{wiki}/ · {n} card',
  'chat.context.cards.other': '{wiki}/ · {n} cards',
  'chat.context.concepts.one': ', {n} concept page',
  'chat.context.concepts.other': ', {n} concept pages',
  'chat.context.noNote': 'No note open',
  'chat.context.inWiki': 'Already in wiki',

  'chat.input.note': 'Ask about this note… (Enter to send)',
  'chat.input.wiki': 'Ask across the cards in {wiki}/… (Enter to send)',
  'chat.input.vault': 'Ask anything — your notes first, then Gemma 4 E4B (Enter to send)',
  'chat.input.vaultOff': 'Ask anything — answered by Gemma 4 E4B, your notes not searched (Enter to send)',
  'chat.input.expand': 'Expand input',
  'chat.input.shrink': 'Shrink input',
  'chat.notesFirst': 'Notes first',
  'chat.notesFirstTip': 'Search my notes first. Untick to ask Gemma 4 E4B directly, without searching.',
  'chat.attach': 'Add note as context',
  'chat.attachPlaceholder': 'Attach a note as context…',
  'chat.removeAttached': 'Remove',
  'chat.stop': 'Stop',
  'chat.send': 'Send (Enter)',

  'chat.skills': 'Run a skill',
  'chat.skills.quiz': 'Quiz',
  'chat.skills.flashcards': 'Flashcards',
  'chat.skills.gaps': 'Find gaps',
  'chat.skills.folders': 'Folder structure',
  'chat.skills.switchTo': 'Switch to {mode} to use these',

  'chat.sources.cards': 'Cards',
  'chat.sources.notes': 'Notes',
  'chat.sources.sources': 'Sources',
  'chat.generalKnowledge': '⚠ Gemma general knowledge — not from your notes',
  'chat.part.notes': 'From your notes',
  'chat.part.shape': 'From the shape of your vault',
  'chat.part.adds': 'Gemma 4 E4B adds',

  'chat.edit': 'Edit',
  'chat.editLabel': 'Edit this question and ask again',
  'chat.edit.replaces.one': 'Replaces {n} later message',
  'chat.edit.replaces.other': 'Replaces {n} later messages',
  'chat.cancel': 'Cancel',
  'chat.askAgain': 'Ask again',

  'chat.answer.copy': 'Copy answer',
  'chat.answer.copied': 'Copied.',
  'chat.answer.regenerate': 'Regenerate',
  'chat.answer.regenerateTip': 'Regenerate answer',
  'chat.answer.save': 'Save answer to wiki',
  'chat.answer.saveTip': 'Save as note',
  'chat.reviewBeforeWriting': 'Review note before writing',
  'chat.saved': 'Saved: {path}',
  'chat.saveNothing': 'Nothing to save yet — ask something first.',
  'chat.saveFailed': 'Could not save the conversation — {reason}',
  'chat.failed': 'Failed: {reason}',

  'chat.history.placeholder': 'Search past chats…',
  'chat.history.noMatch': 'No past chat matches.',
  'chat.history.reopen': 'reopen',
  'chat.history.close': 'close',
  'chat.history.meta.one': '{mode} · {n} question · {when}',
  'chat.history.meta.other': '{mode} · {n} questions · {when}',
  'chat.history.delete': 'Delete "{title}"',
  'chat.history.deleteTip': 'Delete this chat',
  'chat.history.none': 'No past chats yet. ＋ starts a new chat and moves this one here.',
  'chat.history.busy': 'Wait for the answer to finish, or press Stop, then reopen it.',
  'chat.history.saveFailed': 'Could not save chat history — {reason}',
  'chat.restored.session': 'Restored from your last session.',
  'chat.restored.history': 'Reopened from your chat history.',
  'chat.restored.moved':
    '{lead} Those answers are about "{name}"; this panel is now grounded in the note you have open, so a follow-up will be answered from that one.',
  'chat.restored.anotherNote': 'another note',

  'chat.searching': 'Searching {n} notes…',
  'chat.searchingFor': 'Searching {n} notes for: {terms}',
  'chat.nothing': 'Nothing in your notes is about this.',
  'chat.nothing.passing.one': 'Nothing in your notes is about this — {n} mentions it in passing: ',
  'chat.nothing.passing.other': 'Nothing in your notes is about this — {n} mention it in passing: ',
  'chat.nothing.record': 'Nothing in your notes is about this. Gemma 4 E4B was not asked.',
  'chat.nothing.askAnyway': 'Ask Gemma 4 E4B anyway',
  'chat.listSeparator': ', ',
  'chat.listEnd': '.',
  'chat.vault.notSearched': 'Your notes were not searched. ',
  'chat.vault.searchAgain': 'Search my notes and ask again',
  'chat.vault.tally.one': '{about} about · {n} mentions it',
  'chat.vault.tally.other': '{about} about · {n} mention it',
  'chat.vault.about': 'About the subject',
  'chat.vault.mentions': 'Mentions it in passing',

  'chat.route.wiki': 'Ask the wiki',
  'chat.route.note': 'Ask the open note',
  'chat.route.vault': 'Ask across your vault',
  'chat.route.fromNote': 'Not in this note? The wiki it built, or every note in your vault:',
  'chat.route.fromWiki': 'Not in the wiki? The note you have open, or every note in your vault:',
  'chat.route.collection.one': 'Questions across your whole collection are what Wiki is for — you have {n} card.',
  'chat.route.collection.other': 'Questions across your whole collection are what Wiki is for — you have {n} cards.',
  'chat.route.collectionEmpty':
    'Questions across your whole collection are what Wiki is for. Build cards with Scan a folder first — nothing is in {wiki}/ yet.',

  'chat.info.wikiEmpty':
    'Your {wiki}/ folder is empty, so there is nothing to answer from. Build it first — nothing is written without your approval — or switch to Vault to search your notes as they are.',
  'chat.info.noNote': 'Open a note first, or attach one with the + button — This-note mode needs something to ground in.',
  'chat.info.cutWiki':
    'Only the first ~{k}k tokens of the retrieved material were sent — the rest was cut to keep one answer fast.',
  'chat.info.cutNote':
    'Only the first ~{k}k tokens of this note were sent — the rest was cut to keep one answer fast. Raise Context window in settings to send more, or select a section and ask about that.',

  // Settings
  'settings.language.name': 'Interface language',
  'settings.language.desc':
    'The language of the chat panel and this page. Follows Obsidian by default. Prompts and what the plugin writes into your vault stay in English.',
  'settings.language.auto': 'Same as Obsidian',
  'settings.language.reopen': 'The chat panel is answering; reopen it afterwards to see the new language.',

  'settings.demo.before': 'New here? Every feature is demonstrated at ',
  'settings.demo.after': ' — 23 short scenes, nothing to install.',

  'settings.group.model': 'Model',
  'settings.group.wiki': 'Wiki',
  'settings.group.schema': 'Schema',
  'settings.group.skills': 'Skills',
  'settings.group.chat': 'Chat',
  'settings.group.review': 'Review',
  'settings.group.scan': 'Scan for new notes',

  'settings.model.name': 'Local model',
  'settings.model.desc': 'The model file on disk.',
  'settings.model.downloaded':
    'Downloaded ({gb} GB on disk). Completely free — runs offline on your GPU, no API key or subscription.',
  'settings.model.partial': 'Partial download on disk ({gb} GB). Resume to finish.',
  'settings.model.missing': 'Not downloaded yet (~2.97 GB, one time). Downloads on first use, or start it here.',
  'settings.model.redownload': 'Re-download',
  'settings.model.resume': 'Resume download',
  'settings.model.download': 'Download model',

  'settings.check.name': 'Check setup',
  'settings.check.desc':
    'Checks the five things a first answer depends on — desktop, WebGPU, disk space, the runtime, the model — and says what to do about anything missing. Produces a report you can paste into a bug report; it carries versions and file sizes, nothing from your vault.',
  'settings.check.run': 'Run check',

  'settings.context.name': 'Context window (tokens)',
  'settings.context.desc':
    'How much the model can hold at once — longer notes fit whole, and answers can ground on more material. Costs GPU memory and first-token latency. Takes effect after the plugin reloads. If the model fails to load or answers degrade after raising this, set it lower.',
  'settings.context.small': '4,096 (small / safest)',
  'settings.context.max': '64,000 (max)',
  'settings.context.saved': 'Context window saved — reload the plugin (toggle it off/on) to apply.',

  'settings.dev.name': 'Developer commands',
  'settings.dev.desc':
    'Adds the [Test] commands to the palette: check WebGPU, load the WASM runtime without the model, time a grammar fix, run the JSON-reliability test, and benchmark this machine. They are for diagnosing a broken setup, not for working with notes. Off by default.',
  'settings.dev.reload': 'Reload the plugin (toggle it off and on) for this to take effect.',

  'settings.folder.name': 'Knowledge folder name',
  'settings.folder.desc':
    'The one folder the plugin writes to. Your own notes are never moved or modified. Changing this renames the folder and rewrites internal links; blank resets to the default.',
  'settings.folder.apply': 'Apply',
  'settings.folder.notFolder': '"{name}" already exists and is not a folder.',
  'settings.folder.renameTitle': 'Rename the knowledge folder',
  'settings.folder.renameMoves.one': '{n} file will move, and links pointing into "{prev}/" will be rewritten.',
  'settings.folder.renameMoves.other': '{n} files will move, and links pointing into "{prev}/" will be rewritten.',
  'settings.folder.renameEmpty':
    '"{prev}/" is empty or missing, so nothing moves — the folders will simply be created under "{next}/".',
  'settings.folder.renameCheck': 'Check the spelling: a name you did not mean leaves your existing wiki behind.',
  'settings.folder.renameConfirm': 'Rename',

  'settings.map.name': 'What the plugin created',
  'settings.map.desc': 'Every folder and file this plugin owns, and whether each is present.',
  'settings.map.missing': 'missing',

  'settings.repair.name': 'Folders',
  'settings.repair.desc': 'Created when Obsidian starts; this is only for putting one back.',
  'settings.repair.someMissing': '{n} of {total} missing — they are normally created when Obsidian starts.',
  'settings.repair.allPresent':
    'All present. These are created when Obsidian starts; this button is only for putting one back.',
  'settings.repair.createMissing': 'Create {n} missing',
  'settings.repair.button': 'Repair folders',

  'settings.setupCard.name': 'What this plugin created',
  'settings.setupCard.desc':
    'The card shown the first time the folder was made — what each folder is for, and where the chat panel lives. Shown once on purpose; this is how to see it again.',
  'settings.setupCard.button': 'Show setup card',

  'settings.tags.name': 'Tag vocabulary & naming rules',
  'settings.tags.desc':
    'Tag rules live in schema.md, not here — config as a note; open it from the list above. "Organize tags" has local Gemma merge near-synonyms into one vocabulary and writes it back for you to review. The first run is slow while the model loads.',
  'settings.tags.button': 'Organize tags',

  'settings.skills.name': 'Custom skills',
  'settings.skills.desc':
    'One file per skill in skills/ — frontmatter for name/icon/mode, the body is the prompt. Each file becomes an entry in the ⚡ menu of the chat panel. The folder ships with a README and two examples.',
  'settings.skills.button': 'Open skills folder',

  'settings.mode.name': 'Default mode',
  'settings.mode.desc': 'Which mode a freshly opened chat panel starts in.',

  'settings.instructions.name': 'Standing instructions',
  'settings.instructions.desc':
    'Added to every answer in every mode — a language, a length, a tone, a format. They shape how an answer is written, not what it may draw on: a grounded mode still answers only from your material. Up to 2,000 characters.',
  'settings.instructions.placeholder': 'Answer in Japanese. Keep answers under 150 words.',

  'settings.stale.name': 'Stale after (days)',
  'settings.stale.desc': 'How old a page has to be before the review board calls it stale.',

  'settings.howToScan.name': 'How to run a scan',
  'settings.howToScan.desc':
    'Cmd/Ctrl+P → "Scan a folder into the wiki", or the button in the chat panel when your wiki is empty. It asks which folders, shows how many notes each one holds, and remembers your last pick. "Stop the running scan" cancels — whatever was drafted before you stopped is still offered for review.',

  'settings.answerFolder.name': 'Save answers into',
  'settings.answerFolder.desc':
    'Where the save button under an answer writes. Leave blank and it goes beside the note the answer came from — in Wiki mode, the note behind its first source. Name a folder here to put every saved answer in one place instead. Either way it is an ordinary note of yours, so the next scan can turn it into a wiki card like any other.',
  'settings.answerFolder.placeholder': 'beside the note it came from',

  'settings.exclude.name': 'Never scan these',
  'settings.exclude.desc':
    'Folders that are not notes — templates, attachments, an archive. Skipped by every scan and by the background count, whatever you tick in the dialog (comma-separated). The wiki folder is always excluded.',
  'settings.exclude.placeholder': 'Templates, Attachments',

  'settings.count.name': 'Show a background "to review" count',
  'settings.count.desc':
    'Periodically COUNT new/changed notes and show them in the status bar. Counting is instant and never runs the model — drafting only happens when you click the chip. Default off.',

  'settings.quiet.name': 'Quiet period (hours)',
  'settings.quiet.desc':
    'Background auto-scan skips notes edited within this many hours — you may still be writing them. Manual "Scan now" always includes them.',

  'settings.recount.name': 'Re-count every (hours)',
  'settings.recount.desc': 'How often the background count refreshes while Obsidian is open.',

  // What each folder and file of the wiki is for, in the settings table and the setup card
  'scaffold.readme': 'What this folder is, and the rules',
  'scaffold.cards': 'One summary card per ingested note',
  'scaffold.concepts': 'Pages built across a shared tag',
  'scaffold.skills': 'One file per ⚡ menu entry',
  'scaffold.chats': 'Conversations you chose to keep',
  'scaffold.index': 'Catalog — wiki chat reads this first',
  'scaffold.log': 'Append-only record of what ran',
  'scaffold.schema': 'Tag vocabulary, naming rules, rejected tags',
};

export type TextKey = keyof typeof texts;

/** Every key, for the fallback and for the test that holds the other files to it. */
export const EN_TEXTS: Readonly<Record<TextKey, string>> = texts;

export const en: Language = { code: 'en', name: 'English', texts };
