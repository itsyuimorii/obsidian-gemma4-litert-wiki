# Demo script

A 3-4 minute walkthrough, in presentation order. Each scene: what to do, what to say.

## Scene 1 — The hook (30s)

**Do:** Fresh Obsidian vault, plugin enabled, Activity Monitor visible in the corner showing no Ollama/LM Studio process.

**Say:** "Every 'local AI' plugin for Obsidian still needs a second app running — Ollama, LM Studio. This one doesn't. The model runs inside Obsidian's own process, through WebGPU. No server, no API key, no network after a one-time download."

## Scene 2 — Chat with a note (40s)

**Do:** Open a note. Click the ribbon logo icon. Click the "Summarize this note" starter chip. Answer streams in; point at the Sources row and click it.

**Say:** "Ask anything about the open note. Answers stream from Gemma 4 running on the GPU — sub-second to first token once warm. And the Sources row is written by the plugin, not the model — it lists exactly what the answer was grounded in."

## Scene 3 — Honest refusal (20s)

**Do:** Ask something the note doesn't contain.

**Say:** "It's grounded-or-refuse. If the material doesn't contain the answer, it says so — it never pads with the model's own guesses."

## Scene 4 — Build the wiki (60s)

**Do:** Run "Ingest active note into wiki". Show the review modal — summary, tags, key points, Related links. Approve. Show the file-explorer badge, then `wiki/index.md`, then Graph view with cross-links. Ingest a second note quickly.

**Say:** "This is Karpathy's LLM-wiki pattern: your raw notes stay read-only, and the plugin maintains a separate wiki layer — one card per note, cross-linked, cataloged in an index, logged append-only. Nothing is ever written without this review step."

## Scene 5 — Query the wiki (40s)

**Do:** Switch the pill to Wiki. Ask a question spanning both ingested notes. Then ask "what did I add today?"

**Say:** "Wiki mode reads the index first, loads only the relevant pages, and answers from them — with sources. It also carries the activity log, so it can answer questions about the wiki itself."

## Scene 6 — Compounding (30s)

**Do:** On a good answer, click save-to-wiki, approve, then re-ask a related question and show the saved answer appearing as a source.

**Say:** "Good answers get filed back into the wiki. Ask once, keep forever — your explorations compound like your notes do."

## Scene 7 — Skills and Improve (30s)

**Do:** ⚡ → Quiz me. Then select a messy paragraph, click ✨ Improve formatting, show the preview, approve.

**Say:** "Canned skills turn the wiki into a study tool — quizzes, flashcards, gap-finding. And Improve is the one feature that edits your note: formatting and typos only, your wording preserved, always previewed first."

## Closing line

"Everything you just saw ran on this laptop, inside Obsidian, offline. Gemma Wiki — install it, download the model once, and your notes start compounding."
