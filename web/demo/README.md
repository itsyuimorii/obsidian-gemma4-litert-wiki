# Demo recording deck

Twenty-two scripted scenes, one HTML file each, built for screen recording. Open
`index.html` and pick one; inside a scene, **Space** advances one step.

Nothing here runs the plugin. These are mock-ups of the Obsidian window with the
copy, command names, folder paths and modal titles taken from `src/` — the
numbers are representative and no model runs on the page.

## Keys

| | |
|---|---|
| `Space` / `→` / `Enter` / click | next step |
| `R` / `←` | start over — every take is identical, nothing is random |
| `H` | hide the recording chrome (hint bar, scene nav, narration) |
| `T` | toggle the scene title card |
| `P` | toggle the PROTOTYPE badge — leave it on for anything public |

Before recording: press `H`, then decide on `P`.

## Layout

| File | What it is |
|---|---|
| `index.html` | the deck — all 22 scenes, grouped into seven acts |
| `demo-runner.js` | the step driver, the typewriter, and the icon set |
| `ob-shell.js` | the mock Obsidian window, the shared vault, and the chat-panel pieces |
| `demo-shared.css` | every style in the deck |
| `NN-name.html` | one scene |

A scene supplies only its content and its list of beats. The window, the file
tree, the status bar and the chat panel are built once in `ob-shell.js`, so
changing the UI is one edit rather than twenty-two.

The vault is shared too: `VAULT` in `ob-shell.js` holds the same four research
notes and the same knowledge folder for every scene, which is what lets scene 14
drift a card that scene 04 wrote.

## Order

The deck is ordered by the **loop**, not by the UI surface. Notes go in,
questions come out, answers go back in, and then five scenes on what keeps that
from rotting. Scenes 01 → 22 read as one continuous story in one vault; any
single act also stands alone.

| Act | Scenes | |
|---|---|---|
| A | 01–03 | Start — first run, ask immediately, settings |
| B | 04–07 | Filing — one note, a folder, stopping, tags & links |
| C | 08–11 | Asking — the wiki, attachments, skills, the escape hatch |
| D | 12–13 | Compounding — saving an answer, and the trust ladder |
| E | 14–18 | Staying honest — drift, provenance, contradictions, review, lint |
| F | 19–21 | Growing structure — concept pages, vocabulary, retag |
| G | 22 | The closer — pull the cable |

## Adding a scene

Copy the nearest existing scene. Then add it to `SCENES` in `demo-runner.js`
(which draws the prev/next nav) and to the act tables in `index.html`. A scene
missing from `SCENES` still runs; it just has no nav.
