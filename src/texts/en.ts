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
    'The language of the plugin. Follows Obsidian by default. Command names change after the plugin reloads. Prompts, what the plugin writes into your vault, and the [Test] developer commands stay in English.',
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

  // Command names, as the palette shows them
  'cmd.chat': 'Chat with active note (local Gemma)',
  'cmd.checkSetup': 'Check setup (diagnostics)',
  'cmd.concept': 'Build a concept page from a tag or mention (local Gemma)',
  'cmd.contradictions': 'Find contradictions in wiki (local Gemma)',
  'cmd.download': 'Download model (one-time, ~3GB)',
  'cmd.improve': 'Improve formatting of active note (local Gemma)',
  'cmd.ingest': 'Ingest this note into wiki (local Gemma)',
  'cmd.provenance': 'Provenance spot-check (local Gemma)',
  'cmd.reviewBoard': 'Review board (low-confidence, drifted, and stale pages)',
  'cmd.scan': 'Scan a folder into the wiki (batch, local Gemma)',
  'cmd.stopScan': 'Stop the running scan',
  'cmd.suggest': 'Suggest tags & links for active note (local Gemma)',
  'cmd.tidy': 'Tidy the wiki (check, then fix what you approve)',

  // What a running task says, in its notice and the status bar
  'status.answering': 'Answering',
  'status.askingVocab': 'Asking Gemma to organize the vocabulary…',
  'status.bar.runningTip': '{what} — click to bring the message back',
  'status.bar.toReview.one': '{n} to review',
  'status.bar.toReview.other': '{n} to review',
  'status.bar.toReviewTip': 'New or changed notes — click to scan and review',
  'status.checkingModel': 'Checking for an existing model…',
  'status.checkingPage': 'Checking {i}/{n} — {title}…',
  'status.checkingPair': 'Checking {i}/{n} — {a} vs {b}…',
  'status.checkingWiki': 'Checking the wiki…',
  'status.choosingPages': 'Choosing the pages to check…',
  'status.collecting': 'Collecting wiki pages…',
  'status.downloadingFirst': 'Downloading model (first run, ~3GB)…',
  'status.downloadingModel': 'Downloading model… {mb} MB',
  'status.drafting': 'Drafting {i}/{n} — {name} · {step}',
  'status.draftingRelated': 'Drafting {i}/{n} — {name} · finding related pages…',
  'status.extracting': 'Extracting…',
  'status.extractingRetry': 'Extracting (retry)…',
  'status.fetchingRuntime': 'Fetching the local runtime — {file}…',
  'status.fetchingRuntimeMb': 'Fetching the local runtime… {mb} MB',
  'status.improving': 'Improving "{name}"…',
  'status.improvingLabel': 'Improving "{name}"{label}…',
  'status.improvingPass': ' — pass {pass}/{passes}',
  'status.improvingStep': 'Improving "{name}" — {step}',
  'status.ingesting': 'Ingesting "{name}"…',
  'status.ingestingRelated': 'Ingesting "{name}" — finding related pages…',
  'status.ingestingStep': 'Ingesting "{name}" — {step}',
  'status.loadingModel': 'Loading model…',
  'status.mappingTags.one': 'Mapping {n} old tag to the vocabulary…',
  'status.mappingTags.other': 'Mapping {n} old tags to the vocabulary…',
  'status.movingToGpu': 'Moving model onto the GPU…',
  'status.organizing': 'Organizing the tag vocabulary…',
  'status.preparingDownload': 'Preparing model download…',
  'status.ready': 'Ready.',
  'status.relinking': 'Relinking {i}/{n} — {title}…',
  'status.relinkingPlaced': ' ({n} placed without the model)',
  'status.renaming': 'Renaming {prev} → {next}…',
  'status.resumingModel': 'Resuming model… {mb} MB',
  'status.scanRunning': 'a scan is running',
  'status.scanning': 'Scanning for new or changed notes…',
  'status.stopping': 'Stopping — the note being drafted right now will finish first',
  'status.suggesting': 'Suggesting tags & links for "{name}"…',
  'status.suggestingStep': 'Suggesting for "{name}" — {step}',
  'status.writingConcept': 'Writing a concept overview for "{tag}"…',

  // Notices
  'notice.allDraftsFailed': 'Every draft failed to generate — nothing to review.',
  'notice.allInPlace': 'Everything is already in place under {dir}/.',
  'notice.allRejected': 'Every proposed tag is on the Rejected list — nothing to write.',
  'notice.alreadyLinked': 'Those pages already link to each other.',
  'notice.answersMoved':
    'Saved answers now go into your own notes, beside the note they came from.\n\nThis folder is no longer written to and nothing was moved:\n{list}\n\nAnything worth keeping can go wherever you keep notes — and once it is there, a scan can turn it into a wiki card like any other note.',
  'notice.busy': 'Busy: {what}. Wait for that to finish.',
  'notice.changedDuringImprove':
    '"{name}" changed while Improve was running, so nothing was written — your edit is intact. Run Improve again to work from the current text.',
  'notice.codeBlockImprove':
    'Nothing to improve — this note is one oversized code block, which is preserved as-is.',
  'notice.conceptWritten': 'Concept page written: {path}',
  'notice.consistent': 'Wiki is already consistent — no links to deleted pages.',
  'notice.contextGranted':
    'Context window: asked for {asked} tokens, the model granted {granted}. Gemma Wiki is using the real number.',
  'notice.createdMissing.one': 'Created {n} missing item:\n{list}',
  'notice.createdMissing.other': 'Created {n} missing items:\n{list}',
  'notice.emptyImprove': 'Note is empty — nothing to improve.',
  'notice.emptyIngest': 'Note is empty — nothing to ingest.',
  'notice.emptySuggest': 'Note is empty — nothing to suggest.',
  'notice.emptyVocab': 'The model returned an empty vocabulary — nothing to write.',
  'notice.failed': '{what} failed{reason}. Run the command "{check}" to see what is missing.',
  'notice.folderDeleted.empty': 'It was empty.',
  'notice.folderDeleted.lost':
    'Deleted "{path}". {pages} The folder comes back when Obsidian restarts, or from Settings → Repair folders — the pages do not. Undo now with Cmd/Ctrl+Z, or restore them from Obsidian\'s trash, then run "Tidy the wiki" if you decide to let them go.',
  'notice.folderDeleted.nothingLost':
    'Deleted "{path}". {pages} The folder comes back when Obsidian restarts, or from Settings → Repair folders — nothing was lost.',
  'notice.folderDeleted.pages.one': '{n} page went with it.',
  'notice.folderDeleted.pages.other': '{n} pages went with it.',
  'notice.folderFollowed': 'Knowledge folder is now "{path}" — Gemma Wiki followed the rename.',
  'notice.frontmatterImprove': 'Note is only frontmatter — nothing to improve.',
  'notice.frontmatterIngest': 'Note is only frontmatter — nothing to ingest.',
  'notice.ingestDismissed': 'Nothing written — "{name}" was not added to the wiki.',
  'notice.ingestTruncated':
    'Only the first ~{k}k tokens of "{name}" were read — the page below is based on that much. Raise Context window in settings to read more.',
  'notice.keptTags': 'The model kept every old tag as-is — nothing to retag.',
  'notice.linkedPairs': 'Linked {pairs} across {pages}.',
  'notice.listEnd': '.',
  'notice.listSep': '; ',
  'notice.modelReady': 'Model ready — {gb} GB, cached. It never downloads again.',
  'notice.needTwoPages': 'Need at least two wiki pages to compare.',
  'notice.needTwoRelink': 'Need at least two indexed pages to relink.',
  'notice.noConcept':
    'No tag or mention is shared by {n}+ pages yet (concept threshold = {n}). Ingest more notes, or lower the threshold in schema.md.',
  'notice.noKeyPointPages': 'No ingested pages with key points to check.',
  'notice.noNotesInScope': 'No notes in scope to scan.',
  'notice.noPairs': 'No tag-sharing page pairs to check — nothing can contradict.',
  'notice.noSameSubject': 'No same-subject pairs to link.',
  'notice.noTagsYet':
    'No tags yet — the vocabulary is built from the tags your ingested notes already produced. Ingest a few notes first, then run "Tidy the wiki".',
  'notice.noVocab':
    'No vocabulary in schema.md yet — rebuild it first: run "Tidy the wiki" and tick the vocabulary repair, or add tags to schema.md by hand.',
  'notice.notChecked.one': '{n} more pair not checked this run (cap {cap})',
  'notice.notChecked.other': '{n} more pairs not checked this run (cap {cap})',
  'notice.noteUpdated': 'Note updated: {name}',
  'notice.nothingToRelink':
    'Nothing to relink — every link is already mutual, and no new matches were found.',
  'notice.openNoteFirst': 'Open a note first.',
  'notice.pageWritten': 'Wiki page written: {path}',
  'notice.passesFailed':
    '{failed} of {passes} passes failed; those sections are unchanged in the preview. Press Cmd/Ctrl+Opt+I for the full error.',
  'notice.pendingGrowing':
    '{n} tags are waiting in schema.md\'s Pending list. Run "Tidy the wiki" to fold them into the vocabulary — until then, similar notes keep coining near-duplicate tags.',
  'notice.relinked.one': 'Related sections updated on {n} page.',
  'notice.relinked.other': 'Related sections updated on {n} pages.',
  'notice.removedDeleted.one':
    'Removed {n} deleted page from the index, and any related links pointing at it.',
  'notice.removedDeleted.other':
    'Removed {n} deleted pages from the index, and any related links pointing at them.',
  'notice.renamed': 'Wiki folder is now "{next}".',
  'notice.renamedSkipped.one':
    'Wiki folder is now "{next}". {n} file already existed there and was left as it was — the original is still in "{prev}/".',
  'notice.renamedSkipped.other':
    'Wiki folder is now "{next}". {n} files already existed there and were left as they were — the originals are still in "{prev}/".',
  'notice.restored.one':
    'Restored {n} missing item in {dir}/:\n{list}\n\nPages that were deleted are not restored — run "Tidy the wiki" to drop their index entries.',
  'notice.restored.other':
    'Restored {n} missing items in {dir}/:\n{list}\n\nPages that were deleted are not restored — run "Tidy the wiki" to drop their index entries.',
  'notice.retagged.one': 'Retagged {n} page.',
  'notice.retagged.other': 'Retagged {n} pages.',
  'notice.runtimeFailed': 'Runtime download failed — {message}',
  'notice.scanRunning': 'A scan is already running — run "Stop the running scan" to cancel it.',
  'notice.scanStarted.one':
    'Scanning {n} note — about one model call each, so this takes a while. Close Settings and keep working: progress runs in the status bar, and the review dialog waits for you there rather than interrupting. (To stop early, run "Stop the running scan".)',
  'notice.scanStarted.other':
    'Scanning {n} notes — about one model call each, so this takes a while. Close Settings and keep working: progress runs in the status bar, and the review dialog waits for you there rather than interrupting. (To stop early, run "Stop the running scan".)',
  'notice.scanStopped': 'You stopped the scan — the notes it had not reached are offered again next time.',
  'notice.scanStoppedEmpty': 'Scan stopped — no drafts were finished.',
  'notice.scannedNothing.one': 'Scanned {n} note — nothing new or changed to ingest.{quiet}',
  'notice.scannedNothing.other': 'Scanned {n} notes — nothing new or changed to ingest.{quiet}',
  'notice.schemaWritten': 'Schema written: {path}',
  'notice.skillsReady': 'Skills folder ready at {path}. Open its README, then add a .md file per skill.',
  'notice.skippedQuiet': ' ({n} skipped — edited within the quiet period)',
  'notice.stopping': 'Stopping — the note being drafted right now will finish first.',
  'notice.suggestDone': 'Updated "{name}" — tags & links added.',
  'notice.tagsMatch': 'All page tags already match the vocabulary — nothing to retag.',
  'notice.unjudged': '{n} of {total} pairs could not be judged (see console)',
  'notice.vocabNotWritten': 'Vocabulary was not written, so pages were left alone.',
  'notice.vocabReady': 'Vocabulary ready — review it below.',
  'notice.wrotePages.one': 'Wrote {n} page to the wiki.',
  'notice.wrotePages.other': 'Wrote {n} pages to the wiki.',
  'notice.wrotePagesCoined':
    ' Their tags were coined page by page — "Tidy the wiki" folds near-duplicates into one vocabulary.',

  // Operation names, as a failure notice says "{what} failed"
  'op.concept': 'Concept page',
  'op.contradictions': 'Contradiction scan',
  'op.download': 'Downloading the model',
  'op.improve': 'Improve',
  'op.ingest': 'Ingest',
  'op.linkSame': 'Link same-subject pages',
  'op.organizeTags': 'Organize tags',
  'op.provenance': 'Provenance check',
  'op.prune': 'Prune',
  'op.preparingAnswer': 'Preparing the answer',
  'op.relink': 'Relink',
  'op.rename': 'Rename',
  'op.renameFolder': 'Renaming the wiki folder',
  'op.retag': 'Retag',
  'op.scan': 'Scan',
  'op.startup': 'Startup',
  'op.suggest': 'Suggest',
  'op.wikiFolder': 'Wiki folder',

  // Confirmation dialogs
  'modal.allIn.body.one':
    'No new or changed notes{quiet} — but {n} note is already ingested and unchanged. Re-ingest to regenerate its page (summary, tags, related) with the current vocabulary and prompts? You still review every draft before writing.',
  'modal.allIn.body.other':
    'No new or changed notes{quiet} — but {n} notes are already ingested and unchanged. Re-ingest to regenerate their pages (summary, tags, related) with the current vocabulary and prompts? You still review every draft before writing.',
  'modal.allIn.confirm.one': 'Re-ingest {n} note',
  'modal.allIn.confirm.other': 'Re-ingest {n} notes',
  'modal.allIn.title': 'Everything here is already in the wiki',
  'modal.alreadyIn.body':
    '"{name}" is already ingested and unchanged. Re-ingest anyway? This regenerates its wiki page (summary, tags, related links) and overwrites the existing one — you still review before it is written.',
  'modal.alreadyIn.confirm': 'Re-ingest',
  'modal.alreadyIn.title': 'Already in the wiki',
  'modal.foundWiki.body':
    'This vault already contains "{found}/", which has an index and a cards folder — but this machine is configured to use "{configured}/", which is not here.\n\nThat usually means the folder was renamed on another machine and the setting did not sync.\n\nUse the folder that is actually here? Choosing "No" creates a second, empty wiki at "{configured}/".',
  'modal.foundWiki.confirm': 'Use "{found}/"',
  'modal.foundWiki.title': 'Found an existing Gemma Wiki',
  'modal.longImprove.body':
    '{what} is ~{tokens} tokens — more than one pass fits in the model\'s context window, so Improve will work through it in {passes} passes, split on headings and blank lines, and stitch the result back together.\n\nBudget roughly half a minute per pass. You still review the whole result before anything is written.',
  'modal.longImprove.confirm': 'Run {passes} passes',
  'modal.longImprove.selection': 'The selection',
  'modal.longImprove.title': 'Improve a long note',
  'modal.retag.body':
    'Old tags are rewritten to their vocabulary equivalents so past and future pages cluster together. Wiki pages only — your raw notes are not touched.\n\n{summary}',
  'modal.retag.confirm': 'Retag pages',
  'modal.retag.title.one': 'Retag {n} page to the vocabulary',
  'modal.retag.title.other': 'Retag {n} pages to the vocabulary',

  // Counts used inside other text
  'count.pages.one': '{n} page',
  'count.pages.other': '{n} pages',
  'count.pairs.one': '{n} pair',
  'count.pairs.other': '{n} pairs',

  // File explorer
  'badge.inWiki': 'In wiki',

  // Dialogs
  'modal.approve': 'Approve and write',
  'modal.board.none': 'Nothing flagged. Your wiki looks fresh and confident.',
  'modal.board.staleConcept':
    'Stale concept overviews: run "Build a concept page from a tag" on the same tag to rewrite the overview — that clears the flag.',
  'modal.board.summary':
    '{n} of {total} pages worth a look — low-confidence extractions, changed sources, concept overviews whose members changed, and pages untouched for {days}+ days.',
  'modal.board.tip':
    'Tip: open a flagged page, check its claims against the source note it links to, and re-ingest the source if the summary drifted.',
  'modal.board.title': 'Wiki review board',
  'modal.cancel': 'Cancel',
  'modal.close': 'Close',
  'modal.concept.placeholder': 'Pick a tag to build a concept page for…',
  'modal.contra.hint':
    'Open both pages, check them against their source notes, and re-ingest whichever drifted. Nothing was changed.',
  'modal.contra.none': 'No contradictions flagged.',
  'modal.contra.rotate': ' (most recently changed first; run again after edits to rotate coverage)',
  'modal.contra.summary':
    'Checked {checked} of {pairs} sharing a tag{rotate}. {flagged} flagged for a human look — these are candidates, not verdicts.',
  'modal.contra.title': 'Contradiction candidates',
  'modal.diag.blocked': 'Something here has to be fixed first',
  'modal.diag.copied': 'Copied',
  'modal.diag.copy': 'Copy report',
  'modal.diag.note':
    'The text below is what to paste into a bug report. It carries versions, hardware and file sizes — no note titles, no paths, nothing from your vault.',
  'modal.diag.ok': 'Everything checks out',
  'modal.diag.pending': 'Ready, with the downloads still to do',
  'modal.download.free':
    'Gemma Wiki is completely free — no API key, no subscription, no usage fees, ever. The model runs entirely on your machine, so ingest and chat as much as you want. It downloads once, then works fully offline.',
  'modal.download.gpu': 'Runs on your GPU via WebGPU — desktop only, no cloud, no API key.',
  'modal.download.notNow': 'Not now',
  'modal.download.partial': 'A partial download of {gb} GB is on disk — this will resume from there.',
  'modal.download.resume': 'If the download is interrupted, run it again — it resumes where it stopped.',
  'modal.download.size': 'Size: ~2.97 GB, downloaded one time and cached on disk.',
  'modal.download.space': 'Free space: keep ~5 GB free for the download and its temporary file.',
  'modal.download.title': 'Download the local model',
  'modal.drafts.changed': 'changed',
  'modal.drafts.confidence.high': 'high confidence',
  'modal.drafts.confidence.low': 'low confidence',
  'modal.drafts.confidence.med': 'med confidence',
  'modal.drafts.failed': ' · {n} failed and were skipped',
  'modal.drafts.generated.one': '{n} draft generated',
  'modal.drafts.generated.other': '{n} drafts generated',
  'modal.drafts.new': 'new',
  'modal.drafts.overwrites': 'overwrites existing page',
  'modal.drafts.refresh': 're-ingest',
  'modal.drafts.title': 'Review drafts before they enter the wiki',
  'modal.drafts.toggleAll': 'Toggle all',
  'modal.drafts.untick':
    '. Untick anything that looks wrong, then write the rest. Nothing is saved until you do.',
  'modal.drafts.write': 'Write {n} to wiki',
  'modal.nothingSelected': 'Nothing selected',
  'modal.preview.cardWarning':
    'Anything edited by hand in that file will be replaced. Generated pages are rebuilt from their source each time — to keep a correction, put it in the note instead.',
  'modal.preview.create': 'Will create: {path}',
  'modal.preview.improveTitle': 'Review your note before it is rewritten',
  'modal.preview.overwrite': 'Will overwrite: {path}',
  'modal.preview.schemaWarning':
    'Your current vocabulary is replaced by the one above. Tags you moved to Rejected are kept.',
  'modal.preview.title': 'Review wiki page before writing',
  'modal.prov.clean': 'No unsupported key points found in the pages that were checked.',
  'modal.prov.drawn': ' — drawn at random',
  'modal.prov.hint':
    'Open the page, check each flagged point against its source note, and re-ingest if the summary drifted. Nothing was changed.',
  'modal.prov.noneChecked': 'No page could be checked.',
  'modal.prov.ranked': ' — least borne out by its note',
  'modal.prov.read': 'Pages read this run ({n})',
  'modal.prov.summary.one':
    'Checked {n} page: mostly the ones whose source note bears them out least, and a few drawn at random so every page is read in time. {flagged} have key points or mentions the note may not support — candidates to re-ingest, not verdicts.',
  'modal.prov.summary.other':
    'Checked {n} pages: mostly the ones whose source note bears them out least, and a few drawn at random so every page is read in time. {flagged} have key points or mentions the note may not support — candidates to re-ingest, not verdicts.',
  'modal.prov.title': 'Provenance spot-check',
  'modal.prov.unchecked.one':
    '{n} page could not be checked — the model\'s reply was unusable or ran out of room. That page was not verified; run the check again to retry it.',
  'modal.prov.unchecked.other':
    '{n} pages could not be checked — the model\'s reply was unusable or ran out of room. Those pages were not verified; run the check again to retry them.',
  'modal.relink.summary.one': '{n} page will gain a Related section. Nothing else is changed.',
  'modal.relink.summary.other': '{n} pages will gain a Related section. Nothing else is changed.',
  'modal.relink.title': 'Review related-link additions',
  'modal.scan.allFiled':
    'Nothing new to file — every note outside the wiki is already ingested and unchanged.',
  'modal.scan.aside':
    'This is the batch. For just the note you have open, close this and press Cmd/Ctrl+P → "Ingest this note into wiki".',
  'modal.scan.estimate': '{notes}, about one model call each — roughly {minutes}.',
  'modal.scan.firstSlow':
    'The first one is slower if the model has not loaded yet. You can stop partway and still review what was drafted.',
  'modal.scan.folderCount': '{n} new or changed',
  'modal.scan.folderNone': 'nothing new',
  'modal.scan.go': 'Scan',
  'modal.scan.goN.one': 'Scan {n} note',
  'modal.scan.goN.other': 'Scan {n} notes',
  'modal.scan.lede':
    'Sweeps the folders you pick for new or changed notes and drafts a page for each. One model call per note, so it takes a while — you can close this and keep working; progress runs in the status bar, and the review list waits for you there if you moved on. Nothing is ever written without your tick.',
  'modal.scan.noFolders': 'No folders found to scan.',
  'modal.scan.nothingNew': 'Nothing new in the folders you ticked — they are all already filed.',
  'modal.scan.pickOne': 'Pick at least one folder.',
  'modal.scan.title': 'Scan a folder into the wiki',
  'modal.setup.demoAfter': ' — 23 short scenes, arrow keys to step through.',
  'modal.setup.demoBefore': 'Prefer to see it first? Every feature is shown at ',
  'modal.setup.foot':
    'Each folder holds a README explaining what belongs in it. Rename the folder, or check that nothing is missing, in Settings → Gemma Wiki.',
  'modal.setup.lede':
    'Everything this plugin writes goes in that one folder. Your own notes are never moved or modified — they are read and closed.',
  'modal.setup.openIndex': 'Open index.md',
  'modal.setup.showPanel': 'Show me the panel',
  'modal.setup.title': 'Gemma Wiki set up "{dir}/"',
  'modal.setup.whereAfter':
    ' in the ribbon down the left edge of the window. It is opening now so you can see where it is.',
  'modal.setup.whereBefore': 'You talk to it from the side panel — click ',
  'modal.suggest.links': 'Links to add',
  'modal.suggest.nothing': 'Nothing to suggest — no new tags and no related pages found.',
  'modal.suggest.path':
    'Will edit: {path} — merges tags into frontmatter, appends a Related section. Nothing else changes.',
  'modal.suggest.tags': 'Tags to add',
  'modal.suggest.title': 'Review tags & links before writing',
  'modal.tidy.allInVocab': 'Tag vocabulary — all {inUse} tags your pages use are in it',
  'modal.tidy.andMore': 'and {n} more',
  'modal.tidy.andMoreDot': '…and {n} more.',
  'modal.tidy.dupes.one': '{n} pair of pages looks like it is about the same thing',
  'modal.tidy.dupes.other': '{n} pairs of pages look like they are about the same thing',
  'modal.tidy.dupesHint':
    'Links each pair to the other, so the relationship is at least recorded. Nothing is merged and nothing is deleted — two notes about one subject are two pieces of writing, and which to keep is yours. Where a pair is really a cluster, "Build a concept page" is the better answer. No model, nothing to review beyond the preview.',
  'modal.tidy.dupesNone': 'Same-subject pages — no unlinked pair looks like one subject',
  'modal.tidy.dupesOf': ' (of {total} found)',
  'modal.tidy.gaps.one': '{n} subject with enough pages for a concept page',
  'modal.tidy.gaps.other': '{n} subjects with enough pages for a concept page',
  'modal.tidy.gapsHint':
    'Each is a tag or mention that many pages share, with no page written above them yet. Close this and run "Build a concept page from a tag or mention" to write one.',
  'modal.tidy.missing.one': '{n} index entry pointing at a deleted page',
  'modal.tidy.missing.other': '{n} index entries pointing at deleted pages',
  'modal.tidy.missingHint':
    'Drops dead index entries and any Related links pointing at them. No model, nothing to review.',
  'modal.tidy.missingNone': 'Index — no entries point at deleted pages',
  'modal.tidy.noVocab': 'No tag vocabulary yet — {inUse} different tags in use, {pending} waiting',
  'modal.tidy.noVocabHint': 'Ingest has nothing to reuse, so every note coins its own. ',
  'modal.tidy.offVocab': 'Tag vocabulary — {off} of the {inUse} tags your pages use are not in it',
  'modal.tidy.organizeHint':
    'Rebuilds the vocabulary in schema.md from the tags your pages actually use, folding near-duplicates together. One model call, one preview.',
  'modal.tidy.orphans.one': '{n} page with no inbound link',
  'modal.tidy.orphans.other': '{n} pages with no inbound link',
  'modal.tidy.orphansHint':
    'Makes existing links mutual, fills empty Related sections, and drops links to pages that are gone. A page that genuinely relates to nothing stays an orphan.',
  'modal.tidy.orphansNone': 'Related sections — every page has an inbound link',
  'modal.tidy.retag': 'Apply the vocabulary to existing pages',
  'modal.tidy.retagHint':
    'Rewrites page tags to the vocabulary in schema.md — including a vocabulary you edited by hand. Tick this with the box above to do both, or on its own after editing schema.md. One model call, one preview.',
  'modal.tidy.run': 'Run {n} of these',
  'modal.tidy.summary.one': '{n} page checked. Nothing is written until you approve each repair.',
  'modal.tidy.summary.other': '{n} pages checked. Nothing is written until you approve each repair.',
  'modal.tidy.title': 'Tidy the wiki',
  'modal.tidy.unindexed.one': '{n} page missing from the index',
  'modal.tidy.unindexed.other': '{n} pages missing from the index',
  'modal.tidy.unindexedHint':
    'Retrieval reads the index first, so these can never be found. Re-ingest the note behind each one.',

  // Review board reasons
  'board.age': '{days}d since ingest',
  'board.lowConfidence': 'low confidence',
  'board.medConfidence': 'medium confidence',
  'board.membersChanged': 'members changed — rebuild this concept page',
  'board.missingMentions.one': '{n} mention not in the source note',
  'board.missingMentions.other': '{n} mentions not in the source note',
  'board.sourceChanged': 'source changed since ingest',

  // Counts used inside other text
  'count.minutes.one': '{n} minute',
  'count.minutes.other': '{n} minutes',
  'count.notes.one': '{n} note',
  'count.notes.other': '{n} notes',

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
