/* ============================================================
   The mock Obsidian window.

   Every scene runs inside the same Obsidian, so the window is built once here
   and each scene supplies only its content and its beats. One change to the
   window is one edit, instead of fourteen scenes drifting out of alignment.

   Usage:
     OB.render({ vault, tab, tree, editor, right, chip });
   A scene can then reach these ids directly:
     #host #tree #editor #right #notices #palette #modalScrim #runStatus #reviewChip
   ============================================================ */

const OB = (() => {

    /* The left ribbon. The gemma entry is the icon the plugin registers; the
       rest are Obsidian's own, present only so the window looks real. */
    function ribbon() {
        return `
        <div class="ob-ribbon">
            <div class="rb">${icon('search')}</div>
            <div class="rb">${icon('folder')}</div>
            <div class="rb gemma" id="ribbonGemma" title="Chat with note (Gemma, local)">${icon('sparkles')}</div>
            <div class="spacer"></div>
            <div class="rb">${icon('settings')}</div>
        </div>`;
    }

    /* The file tree. One row = { name, kind, indent, active, badge, id }
         kind   'folder' | 'file'
         badge  true if this row can show the "ingested" badge (drawn hidden;
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

    function statusbar(chip) {
        return `
        <div class="ob-statusbar">
            <span class="ob-status-run hidden" id="runStatus"></span>
            <span class="ob-chip${chip ? '' : ' hidden'}" id="reviewChip">${chip || ''}</span>
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
                <span class="vault">${cfg.vault || 'itsyuimorii2026'} — Obsidian</span>
            </div>
            <div class="ob-body">
                ${ribbon()}
                ${tree(cfg.tree || [])}
                ${main(cfg.tab, cfg.editor)}
                ${right(cfg.right)}
            </div>
            ${statusbar(cfg.chip)}

            <div class="ob-notices" id="notices"></div>

            <div class="ob-palette-scrim hidden" id="paletteScrim">
                <div class="ob-palette">
                    <div class="q" id="paletteQ"><span class="ph">Type a command…</span></div>
                    <div class="hits" id="paletteHits"></div>
                </div>
            </div>

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
        box.innerHTML = hits.map((h, i) =>
            `<div class="hit${i === 0 ? ' sel' : ''}">${icon(h.icon || 'sparkles')}<span>${h.name}</span>${h.key ? `<span class="k">${h.key}</span>` : ''}</div>`
        ).join('');
        GemmaDemo.typeHTML(q, query, { speed: 26, onDone: opts.onDone });
    }
    function closePalette() {
        document.getElementById('paletteScrim')?.classList.add('hidden');
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

    /* ---- Light the ingested badge on a tree row. ---- */
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

    return { render, palette, closePalette, modal, closeModal, badge, addRow, openRight };
})();

/* ============================================================
   Reusable pieces of the chat panel. Six of the scenes open it, and hand
   copying the header into each one would eventually copy it wrong.
   ============================================================ */
const GW = {
    header(noteName, opts = {}) {
        return `
        <div class="gw-header">
            <div class="gw-title-row">
                ${icon('file-plus-2', 'gw-logo')}
                <span class="gw-title">Gemma Wiki</span>
                <span class="gw-badge">Local</span>
                <span class="gw-actions">
                    <span class="b">${icon('save')}</span>
                    <span class="b">${icon('trash-2')}</span>
                </span>
            </div>
            <div class="gw-note-chip" id="noteChip">${icon(opts.icon || 'file-text')}<span class="nm">${noteName}</span></div>
        </div>`;
    },

    /* How the panel looks before the first message is sent. */
    empty(opts = {}) {
        return `
        <div class="gw-messages" id="messages">
            <div class="gw-empty" id="emptyState">
                <span class="ic">${icon('file-plus-2')}</span>
                <span class="t">${opts.title || 'Ask about the open note'}</span>
                <span class="d">${opts.body || 'Answers come from a model running entirely inside Obsidian — nothing leaves your machine.'}</span>
            </div>
        </div>`;
    },

    messages(inner = '') {
        return `<div class="gw-messages" id="messages">${inner}</div>`;
    },

    /* Starter chips swap with the mode. Formatting is styled differently
       because it is the one that writes to your note. */
    suggestions(mode = 'note') {
        const items = mode === 'note'
            ? [['Summarize', 0], ['Key points', 0], ['Formatting', 1]]
            : [["What's in my wiki?", 0], ['Added recently', 0], ['Find connections', 0]];
        return `<div class="gw-suggestions" id="suggestions">${
            items.map(([label, write]) => `<span class="gw-chip${write ? ' write' : ''}">${label}</span>`).join('')
        }</div>`;
    },

    /* mode: 'note' | 'wiki' — which pill is filled black. */
    composer(mode = 'note', opts = {}) {
        return `
        <div class="gw-composer">
            <div class="gw-pills" id="pills"></div>
            <div class="gw-input" id="input"><span class="ph">${opts.placeholder || 'Ask about this note… (Enter to send)'}</span></div>
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
            <span class="a" id="btnSaveBack">${icon('file-plus-2')}${opts.saveLabel || 'Save to wiki'}</span>
        </div>`;
    },
};
