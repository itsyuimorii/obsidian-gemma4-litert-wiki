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
    'The language of the chat panel. Follows Obsidian by default. Prompts and what the plugin writes into your vault stay in English.',
  'settings.language.auto': 'Same as Obsidian',
  'settings.language.reopen': 'Reopen the chat panel to see it in the new language.',
};

export type TextKey = keyof typeof texts;

/** Every key, for the fallback and for the test that holds the other files to it. */
export const EN_TEXTS: Readonly<Record<TextKey, string>> = texts;

export const en: Language = { code: 'en', name: 'English', texts };
