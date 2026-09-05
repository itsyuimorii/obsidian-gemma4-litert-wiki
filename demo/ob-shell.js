/* ============================================================
   The mock Obsidian window.

   Every scene runs inside the same Obsidian, so the window is built once here
   and each scene supplies only its content and its beats. One change to the
   window is one edit, instead of twenty-two scenes drifting out of alignment.

   The same rule applies to the vault: VAULT below is the one set of notes the
   whole deck uses, so scene 14 can drift a card that scene 04 wrote and the
   filenames still line up.

   Usage:
     OB.render({ vault, tab, tree, editor, right, chip });
   A scene can then reach these ids directly:
     #host #tree #editor #right #notices #palette #modalScrim #runStatus
   ============================================================ */

/* ------------------------------------------------------------
   The vault the deck is set in. Four research notes plus the knowledge
   folder the plugin creates — small enough to read on screen, and the same
   four every time so the story is continuous across scenes.
   ------------------------------------------------------------ */
const VAULT = {
    name: 'itsyuimorii2026',

    /* The notes that were already there. These are yours; the plugin never
       writes to them. */
    notes: [
        { name: 'research', kind: 'folder' },
        { name: 'litert on device', kind: 'file', indent: 1, badge: true, id: 'litert' },
        { name: 'webmcp notes', kind: 'file', indent: 1, badge: true, id: 'webmcp' },
        { name: 'agent interfaces', kind: 'file', indent: 1, badge: true, id: 'agentif' },
        { name: 'browser apis', kind: 'file', indent: 1, badge: true, id: 'browserapi' },
    ],

    /* What the knowledge folder looks like at each point in the story:
         'none'    the plugin has not run yet
         'empty'   scaffolded, nothing filed
         'filed'   four cards
         'full'    cards plus a concept page                              */
    wiki(stage = 'empty') {
        if (stage === 'none') return [];
        const rows = [
            { name: 'gemma-wiki', kind: 'folder' },
            { name: 'cards', kind: 'folder', indent: 1, id: 'gw-cards' },
        ];
        if (stage === 'filed' || stage === 'full') {
            rows.push(
                { name: 'litert-on-device', kind: 'file', indent: 2, id: 'c-litert' },
                { name: 'webmcp-notes', kind: 'file', indent: 2, id: 'c-webmcp' },
                { name: 'agent-interfaces', kind: 'file', indent: 2, id: 'c-agentif' },
                { name: 'browser-apis', kind: 'file', indent: 2, id: 'c-browserapi' },
            );
        }
        // chats/ collects saved conversations — written by the plugin and
        // excluded from every path that could read one back. No answers/: an
        // answer you keep is written into your own notes, an ordinary file.
        rows.push({ name: 'chats', kind: 'folder', indent: 1, id: 'gw-chats' });
        rows.push({ name: 'concepts', kind: 'folder', indent: 1, id: 'gw-concepts' });
        if (stage === 'full') {
            rows.push({ name: 'on-device', kind: 'file', indent: 2, id: 'k-ondevice' });
        }
        rows.push(
            { name: 'skills', kind: 'folder', indent: 1, id: 'gw-skills' },
            { name: 'index.md', kind: 'file', indent: 1, id: 'gw-index' },
            { name: 'log.md', kind: 'file', indent: 1, id: 'gw-log' },
            { name: 'schema.md', kind: 'file', indent: 1, id: 'gw-schema' },
        );
        return rows;
    },

    /* The whole tree, with one note marked open. */
    tree(stage = 'empty', activeId = null) {
        const notes = VAULT.notes.map(n => (n.id === activeId ? { ...n, active: true } : n));
        return [...notes, ...VAULT.wiki(stage)];
    },
};

const OB = (() => {

    /* The left ribbon. The gemma entry is the icon the plugin registers — the
       actual glyph from main.ts, not a stand-in — and the rest are Obsidian's
       own, present only so the window looks real. */
    function ribbon() {
        return `
        <div class="ob-ribbon">
            <div class="rb">${icon('search')}</div>
            <div class="rb">${icon('folder')}</div>
            <div class="rb gemma" id="ribbonGemma" title="Gemma Wiki — ask your notes (local, free)">${icon('gemma-wiki-logo')}</div>
            <div class="spacer"></div>
            <div class="rb">${icon('settings')}</div>
        </div>`;
    }

    /* The file tree. One row = { name, kind, indent, active, badge, id }
         kind   'folder' | 'file'
         badge  true if this row can show the "filed" badge (drawn hidden;
                OB.badge(id) lights it)
       The badge is decoration in the explorer — the note file itself is
       never written to. */
    function rowHTML(r) {
        const cls = [
            'ob-row',
            r.kind === 'folder' ? 'folder' : '',
            r.indent === 1 ? 'indent' : r.indent === 2 ? 'indent2' : '',
            r.active ? 'active' : '',
        ].filter(Boolean).join(' ');
        const ic = r.kind === 'folder' ? icon('folder', 'ic') : icon('file-text', 'ic');
        // Drawn but not lit; OB.badge(id) reveals it.
        const badge = r.badge
            ? `<svg class="badge" data-badge="${r.id || ''}" viewBox="0 0 24 24">${ICON_PATHS['book-check']}</svg>`
            : '';
        return `<div class="${cls}"${r.id ? ` id="row-${r.id}"` : ''}>${ic}<span class="nm">${r.name}</span>${badge}</div>`;
    }

    function tree(rows = []) {
        return `
        <div class="ob-sidebar">
            <div class="ob-sb-head">Files</div>
            <div class="ob-tree" id="tree">${rows.map(rowHTML).join('')}</div>
        </div>`;
    }

    function main(tab, editor) {
        const t = tab || { name: 'Untitled', icon: 'file-text' };
        return `
        <div class="ob-main">
            <div class="ob-tabbar">
                <div class="ob-tab active" id="tab">${icon(t.icon || 'file-text')}<span>${t.name}</span></div>
            </div>
            <div class="ob-editor" id="editor">${editor || ''}</div>
        </div>`;
    }

    function right(html) {
        // Absent by default: most scenes pull the panel in on their first beat.
        return `<div class="ob-right${html ? '' : ' hidden'}" id="right">${html || ''}</div>`;
    }

    /* One status-bar slot, because the plugin has one. Whichever of the three
       claimants is loudest owns it; see GemmaDemo.status / statusDone /
       statusReview. */
    function statusbar() {
        return `
        <div class="ob-statusbar">
            <span class="ob-status-run hidden" id="runStatus"></span>
            <span id="wordCount">0 words</span>
        </div>`;
    }

    function render(cfg = {}) {
        const stage = document.querySelector('.stage') || (() => {
            const s = document.createElement('div');
            s.className = 'stage';
            document.body.appendChild(s);
            return s;
        })();

        stage.innerHTML = `
        <div class="ob-window" id="host">
            <div class="ob-titlebar">
                <span class="tl r"></span><span class="tl y"></span><span class="tl g"></span>
                <span class="vault">${cfg.vault || VAULT.name} — Obsidian</span>
            </div>
            <div class="ob-body">
                ${ribbon()}
                ${tree(cfg.tree || [])}
                ${main(cfg.tab, cfg.editor)}
                ${right(cfg.right)}
            </div>
            ${statusbar()}

            <div class="ob-notices" id="notices"></div>

            <div class="ob-palette-scrim hidden" id="paletteScrim">
                <div class="ob-palette">
                    <div class="q" id="paletteQ"><span class="ph">Type a command…</span></div>
                    <div class="hits" id="paletteHits"></div>
                </div>
            </div>

            <div class="ob-menu hidden" id="obMenu"></div>
            <div class="ob-modal-scrim hidden" id="modalScrim"></div>
        </div>`;

        if (cfg.words) document.getElementById('wordCount').textContent = cfg.words;
        return stage;
    }

    /* ---- Command palette. hits are the candidates to show; the first is
       highlighted. ---- */
    function palette(query, hits = [], opts = {}) {
        const scrim = document.getElementById('paletteScrim');
        const q = document.getElementById('paletteQ');
        const box = document.getElementById('paletteHits');
        scrim.classList.remove('hidden');
        q.dataset.ph = opts.placeholder || 'Type a command…';
        box.innerHTML = hits.map((h, i) =>
            `<div class="hit${i === 0 ? ' sel' : ''}">${icon(h.icon || 'gemma-wiki-logo')}<span>${h.name}</span>${h.key ? `<span class="k">${h.key}</span>` : ''}</div>`
        ).join('');
        GemmaDemo.typeHTML(q, query, { speed: 26, onDone: opts.onDone });
    }
    function closePalette() {
        document.getElementById('paletteScrim')?.classList.add('hidden');
    }

    /* ---- Obsidian's own dropdown, used by the ⚡ skills button. An item can
       be { label, icon, note } or { sep: true }; disabled items carry the
       reason they are disabled, which is the whole point of showing them at
       all instead of hiding them. ---- */
    function menu(items, opts = {}) {
        const el = document.getElementById('obMenu');
        if (!el) return;
        el.innerHTML = items.map(it => {
            if (it.sep) return '<div class="sep"></div>';
            const cls = ['mi', it.disabled ? 'off' : '', it.hot ? 'hot' : ''].filter(Boolean).join(' ');
            return `<div class="${cls}">${it.icon ? icon(it.icon) : '<span class="noic"></span>'}<span class="l">${it.label}</span>${it.note ? `<span class="n">${it.note}</span>` : ''}</div>`;
        }).join('');
        // Anchored above the ⚡ button, which is where Obsidian puts it.
        el.style.right = (opts.right ?? 26) + 'px';
        el.style.bottom = (opts.bottom ?? 74) + 'px';
        el.classList.remove('hidden');
        return el;
    }
    function closeMenu() {
        document.getElementById('obMenu')?.classList.add('hidden');
    }

    /* ---- Modal. Takes html, returns the container so a scene can keep
       filling it in. ---- */
    function modal(html, cls = '') {
        const scrim = document.getElementById('modalScrim');
        scrim.classList.remove('hidden');
        scrim.innerHTML = `<div class="ob-modal ${cls}">${html}</div>`;
        return scrim.querySelector('.ob-modal');
    }
    function closeModal() {
        const scrim = document.getElementById('modalScrim');
        if (!scrim) return;
        scrim.classList.add('hidden');
        scrim.innerHTML = '';
    }

    /* ---- Light the filed badge on a tree row. ---- */
    function badge(id) {
        document.querySelector(`[data-badge="${id}"]`)?.classList.add('on');
    }

    /* ---- Insert a row into the tree — the moment a wiki page is written. ---- */
    function addRow(row, afterId) {
        const t = document.getElementById('tree');
        if (!t) return;
        const el = document.createElement('div');
        el.innerHTML = rowHTML(row);
        const node = el.firstElementChild;
        node.classList.add('appearing');
        const after = afterId ? document.getElementById(`row-${afterId}`) : null;
        if (after) after.after(node); else t.appendChild(node);
        return node;
    }

    /* ---- The right panel: reveal it, or swap its contents. ---- */
    function openRight(html) {
        const r = document.getElementById('right');
        if (!r) return;
        if (html !== undefined) r.innerHTML = html;
        r.classList.remove('hidden');
        r.classList.add('entering');
        document.getElementById('ribbonGemma')?.classList.add('lit');
    }

    /* ---- Open a file in the editor pane, tab label and all. ---- */
    function openFile(name, html, opts = {}) {
        const tab = document.getElementById('tab');
        if (tab) tab.innerHTML = `${icon(opts.icon || 'file-text')}<span>${name}</span>`;
        const ed = document.getElementById('editor');
        if (ed) ed.innerHTML = html;
        document.querySelectorAll('.ob-row.active').forEach(r => r.classList.remove('active'));
        if (opts.rowId) document.getElementById(`row-${opts.rowId}`)?.classList.add('active');
    }

    return {
        render, palette, closePalette, menu, closeMenu, modal, closeModal,
        badge, addRow, openRight, openFile, rowHTML,
    };
})();

/* ============================================================
   Reusable pieces of the chat panel. Most of the deck opens it, and hand
   copying the header into each scene would eventually copy it wrong.
   ============================================================ */
const GW = {
    /* The chip under the title says what the panel is grounded in, and it is
       decided by the mode rather than by the caller: in Wiki mode the plugin
       shows "Wiki (ingested pages)" with a library glyph, whatever file
       happens to be open. A tick appears when the open note is already
       filed. */
    header(noteName, opts = {}) {
        const wiki = opts.mode === 'wiki';
        const chip = wiki
            ? `${icon('library')}<span class="nm">Wiki (ingested pages)</span>`
            : `${icon(opts.icon || 'file-text')}<span class="nm">${noteName}</span>` +
              (opts.filed ? `<span class="gw-chip-check">${icon('check')}</span>` : '');
        return `
        <div class="gw-header">
            <div class="gw-title-row">
                ${icon('gemma-wiki-logo', 'gw-logo')}
                <span class="gw-title">Gemma Wiki</span>
                <span class="gw-badge">Local</span>
                <span class="gw-actions">
                    <span class="b">${icon('save')}</span>
                    <span class="b">${icon('trash-2')}</span>
                </span>
            </div>
            <div class="gw-note-chip" id="noteChip">${chip}</div>
        </div>`;
    },

    /* How the panel looks before the first message is sent. */
    empty(opts = {}) {
        return `
        <div class="gw-messages" id="messages">
            <div class="gw-empty" id="emptyState">
                <span class="ic">${icon('gemma-wiki-logo')}</span>
                <span class="t">${opts.title || 'Ask about the open note'}</span>
                <span class="d">${opts.body || 'Answers come from a model running entirely inside Obsidian — nothing leaves your machine.'}</span>
            </div>
        </div>`;
    },

    messages(inner = '') {
        return `<div class="gw-messages" id="messages">${inner}</div>`;
    },

    /* The chip row, as suggestionsFor() defines it.
    
       What separates a chip that ASKS from one that DOES is a glyph — same
       pill, same text colour. The plugin tried a dashed border and a darker
       colour first; at 26px and 1px that read as "this label is in a different
       font", noticed as an inconsistency rather than as a meaning. An icon
       survives the size.
    
       opts.scanning turns the scan chip into the stop control, which is what it
       obviously is while a scan runs. opts.busy greys every other chip: taking
       the button away beats letting you press it and be told no. */
    suggestions(mode = 'note', opts = {}) {
        const items = mode === 'note'
            ? [['Summarize', null], ['Formatting', 'wand-2'], ['Ingest this note into wiki', 'file-plus-2']]
            : [['Scan a folder', 'folder-search'], ['Find connections', null], ["What's still open?", null]];
        return `<div class="gw-suggestions" id="suggestions">${
            items.map(([label, ic]) => {
                const isScan = label === 'Scan a folder';
                if (isScan && opts.scanning) {
                    return `<span class="gw-chip write stop">${icon('square')}Stop scan</span>`;
                }
                const off = opts.busy && !isScan ? ' off' : '';
                return `<span class="gw-chip${ic ? ' write' : ''}${off}">${ic ? icon(ic) : ''}${label}</span>`;
            }).join('')
        }</div>`;
    },

    /* mode: 'note' | 'wiki' — which pill is filled. */
    composer(mode = 'note', opts = {}) {
        const ph = opts.placeholder
            || (mode === 'wiki' ? 'Ask across your wiki… (Enter to send)' : 'Ask about this note… (Enter to send)');
        return `
        <div class="gw-composer">
            <div class="gw-pills" id="pills"></div>
            <div class="gw-input" id="input"><span class="ph">${ph}</span></div>
            <div class="gw-bar">
                <span class="gw-mode${mode === 'note' ? ' on' : ''}" id="modeNote">This note</span>
                <span class="gw-mode${mode === 'wiki' ? ' on' : ''}" id="modeWiki">Wiki</span>
                <span class="ib" id="btnAttach">${icon('plus')}</span>
                <span class="ib" id="btnSkills">${icon('zap')}</span>
                <span class="ib" id="btnExpand">${icon('maximize-2')}</span>
                <span class="sp"></span>
                <span class="ib send">${icon('arrow-up')}</span>
            </div>
        </div>`;
    },

    /* A whole panel in one call — the shape almost every scene wants. */
    panel(noteName, mode = 'note', opts = {}) {
        // The empty state follows the mode too, so a wiki panel can never come
        // up telling you to ask about the open note.
        const e = mode === 'wiki'
            ? {
                title: opts.title || 'Ask your wiki',
                body: opts.body || 'Answers are grounded in the pages you have filed. The plugin lists which ones it read.',
              }
            : opts;
        return GW.header(noteName, { ...opts, mode })
            + (opts.messages !== undefined ? GW.messages(opts.messages) : GW.empty(e))
            + GW.suggestions(mode, opts)
            + GW.composer(mode, opts);
    },

    /* While a generation is in flight the panel shows a thin spinner ring in
       the message row itself — not a status-bar line. The status bar belongs to
       operations you can walk away from; a chat answer is one you are watching.
       The row becomes the answer, so typing into #ans replaces the spinner. */
    thinking(id = 'ans') {
        return `<div class="gw-msg bot" id="${id}"><span class="gw-spinner"></span></div>`;
    },

    /* The deterministic Sources row — listed by the plugin, never cited by
       the model. */
    sources(items = []) {
        return `
        <div class="gw-sources">
            <span class="lb">Sources</span>
            ${items.map(s => `<span class="gw-src">${icon('file-text')}${s}</span>`).join('')}
        </div>`;
    },

    actions(opts = {}) {
        return `
        <div class="gw-msg-actions">
            <span class="a">${icon('copy')}Copy</span>
            <span class="a">${icon('refresh-cw')}Regenerate</span>
            <span class="a" id="btnSaveBack">${icon('file-plus-2')}${opts.saveLabel || 'Save as note'}</span>
        </div>`;
    },

    /* The ⚡ menu, as chat-view.ts builds it: three built-ins, a rule, then
       whatever .md files are sitting in skills/. */
    skillMenu(opts = {}) {
        const off = opts.wrongMode ? 'Switch to This note' : (opts.busy || '');
        const mk = (label, ic) => ({ label, icon: ic, disabled: !!off, note: off || undefined });
        return [
            ...(off ? [{ label: opts.wrongMode ? 'Switch to This note to use these' : `Busy: ${opts.busy}`, disabled: true }, { sep: true }] : []),
            mk('Quiz', 'graduation-cap'),
            mk('Flashcards', 'layers'),
            mk('Find gaps', 'search'),
            { sep: true },
            mk('Action items', 'list-checks'),
            mk('Unclear bits', 'circle-help'),
        ];
    },
};
