/* ============================================================
   Gemma Wiki — demo recording driver.
   Advance the scene one keystroke at a time, so every take comes out identical.

   Keys:
     Space / → / Enter   next step
     R / ←               start over (reloads the page)
     H                   show/hide the recording chrome (hint bar, nav, narration)
     T                   show/hide the scene title card
     P                   show/hide the PROTOTYPE badge (leave it on for anything public)

   Before recording: press H to clear the chrome, then decide on P.
   ============================================================ */

const GemmaDemo = (() => {
    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

    /* ---- A small deterministic generator, so the keystroke wobble is a wobble
       and not a source of variation between takes. Reset on load, which is what
       R does — press it and the retake is frame-for-frame the one before. ---- */
    let seed = 0x2f6e2b1;
    function rnd() {
        // xorshift32: cheap, no state to manage, same sequence every load.
        seed ^= seed << 13; seed >>>= 0;
        seed ^= seed >> 17;
        seed ^= seed << 5;  seed >>>= 0;
        return seed / 0x100000000;
    }

    /* ---- Typewriter. Emits HTML one character at a time; tags are written
       instantly so markup costs no time on screen. ---- */
    function typeHTML(el, html, opts = {}) {
        if (typeof el === 'string') el = $(el);
        if (!el) return;
        const speed = opts.speed ?? 22;      // base milliseconds per character
        const jitter = opts.jitter ?? 16;    // wobble, so it does not read as machine output
        const cursor = opts.cursor ?? '<span class="blink-cursor"></span>';
        const onDone = opts.onDone;

        // Split the HTML into two kinds of atom: a whole tag, or one character.
        const atoms = [];
        const re = /(<[^>]+>)|([\s\S])/g;
        let m;
        while ((m = re.exec(html)) !== null) {
            atoms.push(m[1] ? { tag: m[1] } : { ch: m[2] });
        }

        let out = '';
        let i = 0;
        // Type into a span of our own rather than into el itself. A step that
        // appends to el mid-stream — the Sources row, the action buttons — used
        // to be wiped by the next keystroke, because every tick rewrote the
        // whole element. Now a tick only rewrites this span, and anything
        // appended after it survives.
        el.innerHTML = '';
        const host = el.ownerDocument.createElement('span');
        el.appendChild(host);
        host.innerHTML = cursor;
        el.dataset.typing = '1';

        function finish() {
            host.innerHTML = out;
            delete el.dataset.typing;
            el.dispatchEvent(new CustomEvent('typed'));
            onDone && onDone();
        }

        function step() {
            // Tags cost no time; flush every consecutive one at once.
            while (i < atoms.length && atoms[i].tag) {
                out += atoms[i].tag;
                i++;
            }
            if (i >= atoms.length) {
                finish();
                return;
            }
            const ch = atoms[i].ch;
            out += ch;
            i++;
            host.innerHTML = out + cursor;

            // Pause longer after punctuation, so it reads as thinking.
            let delay = speed + rnd() * jitter;
            if ('，。、？！,.?!'.includes(ch)) delay += 200;
            else if (ch === ' ') delay += 8;
            setTimeout(step, delay);
        }
        setTimeout(step, opts.startDelay ?? 110);
    }

    /* ---- Run fn once an element has finished typing — immediately if it is
       not typing. A Sources row landing halfway through a sentence reads as a
       glitch, so the steps that add one wait for the stream to end. ---- */
    function afterTyped(el, fn) {
        if (typeof el === 'string') el = $(el);
        if (!el) return;
        if (!el.dataset.typing) { fn(); return; }
        el.addEventListener('typed', () => fn(), { once: true });
    }

    /* ---- Flash a keyboard shortcut on screen. ---- */
    function flashKeys(keys) {
        const wrap = $('#keycapOverlay');
        if (!wrap) return;
        wrap.innerHTML = keys.map(k => `<div class="keycap">${k}</div>`).join('');
        wrap.classList.remove('flash');
        void wrap.offsetWidth; // force reflow so the animation can replay
        wrap.classList.add('flash');
    }

    /* ---- Narration: what this step is demonstrating. Hidden with H along
       with the rest of the chrome; call with no argument to clear it. ---- */
    function beat(html) {
        const el = $('#beat');
        if (!el) return;
        if (!html) { el.classList.remove('on'); return; }
        // The start cue occupies the same spot, so get it out of the way.
        $('#startCue')?.classList.add('gone');
        el.innerHTML = html;
        el.classList.add('on');
    }

    /* ---- Obsidian's black toast, top right. ---- */
    function notice(html, ms = 0) {
        const host = $('#notices');
        if (!host) return null;
        const n = document.createElement('div');
        n.className = 'ob-notice';
        n.innerHTML = html;
        host.appendChild(n);
        if (ms > 0) {
            setTimeout(() => {
                n.classList.add('leaving');
                setTimeout(() => n.remove(), 320);
            }, ms);
        }
        return n;
    }
    function clearNotices() {
        const host = $('#notices');
        if (host) host.innerHTML = '';
    }

    /* ---- Reveal a group of elements one after another. ---- */
    function reveal(sel, gap = 160, root = document) {
        $$(sel, root).forEach((el, i) => setTimeout(() => el.classList.add('on'), i * gap));
    }

    /* ---- The status bar: one slot, three claimants — a run in progress, a
       result you walked away from, or a background "to review" count. The
       running one ticks, because the plugin's does: a 40-second generation with
       no clock on it is indistinguishable from a hang. ---- */
    let clockId = null;
    let clockT0 = 0;
    function elapsed() {
        const s = Math.floor((Date.now() - clockT0) / 1000);
        return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }
    function stopClock() {
        if (clockId) { clearInterval(clockId); clockId = null; }
    }
    function slot() { return $('#runStatus'); }

    /* Running. Pass { keep: true } to change the label without resetting the
       clock — a scan moves through notes inside one run. */
    function status(text, opts = {}) {
        const el = slot();
        if (!el) return;
        if (!text) { stopClock(); el.classList.add('hidden'); el.textContent = ''; return; }
        if (!opts.keep || !clockId) {
            clockT0 = Date.now();
            stopClock();
            clockId = setInterval(() => {
                const e = slot();
                if (e && e.dataset.run) e.textContent = `⏳ ${e.dataset.run}  ·  ${elapsed()}`;
            }, 1000);
        }
        el.className = 'ob-status-run';
        el.dataset.run = text;
        el.textContent = `⏳ ${text}  ·  ${elapsed()}`;
    }

    /* Parked: the run finished while you were somewhere else, so the result
       waits here instead of ambushing you. */
    function statusDone(label) {
        const el = slot();
        if (!el) return;
        stopClock();
        delete el.dataset.run;
        el.className = 'ob-status-run parked';
        el.textContent = `\u2705 ${label}`;
    }

    /* The background count. Model-free — counting is a file sweep. */
    function statusReview(n) {
        const el = slot();
        if (!el) return;
        stopClock();
        delete el.dataset.run;
        el.className = 'ob-status-run review';
        el.textContent = `\uD83D\uDCE5 ${n} to review`;
    }

    /* ---- Progress bar, used by both the download and the multi-pass rewrite.
       Steps linearly from → to, firing a callback each tick so the caller can
       keep its label in sync. ---- */
    function progress(barSel, from, to, ms, onTick, onDone) {
        const bar = $(barSel);
        if (!bar) return;
        const steps = Math.max(1, Math.round(ms / 60));
        let i = 0;
        bar.style.width = from + '%';
        const t = setInterval(() => {
            i++;
            const p = from + (to - from) * (i / steps);
            bar.style.width = p + '%';
            onTick && onTick(p);
            if (i >= steps) {
                clearInterval(t);
                onDone && onDone();
            }
        }, 60);
    }

    /* ---- Scene-to-scene nav and the start cue, both injected automatically. ---- */

    const SCENES = [
        ['01-first-run.html',      'First run'],
        ['02-ask-immediately.html','Ask immediately'],
        ['03-settings.html',       'Settings'],
        ['04-ingest-one.html',     'File one note'],
        ['05-scan-batch.html',     'Scan a folder'],
        ['06-stop-scan.html',      'Stopping'],
        ['07-tags-links.html',     'Tags & links'],
        ['08-wiki-query.html',     'Ask the wiki'],
        ['09-attach.html',         'Attach notes'],
        ['10-skills.html',         'Skills'],
        ['11-not-in-wiki.html',    'Not in the wiki'],
        ['12-save-back.html',      'Save the answer'],
        ['13-trust-layers.html',   'Trust layers'],
        ['14-drift.html',          'You edit the note'],
        ['15-provenance.html',     'Provenance'],
        ['16-contradictions.html', 'Contradictions'],
        ['17-review-board.html',   'Review board'],
        ['18-lint.html',           'Lint & reconcile'],
        ['19-concept-page.html',   'Concept page'],
        ['20-tag-vocab.html',      'Tag vocabulary'],
        ['21-retag.html',          'Retag'],
        ['22-offline.html',        'Pull the cable'],
    ];

    function buildNav() {
        const here = location.pathname.split('/').pop() || '';
        const i = SCENES.findIndex(([f]) => f === here);
        if (i < 0) return;

        const nav = document.createElement('div');
        nav.className = 'scene-nav';
        nav.id = 'sceneNav';

        const deck = document.createElement('a');
        deck.href = 'index.html';
        deck.textContent = '← All scenes';

        const prev = document.createElement('a');
        prev.textContent = '←';
        if (i > 0) prev.href = SCENES[i - 1][0]; else prev.className = 'disabled';

        const count = document.createElement('span');
        count.className = 'count';
        count.textContent = `${String(i + 1).padStart(2, '0')} / ${String(SCENES.length).padStart(2, '0')}`;

        const next = document.createElement('a');
        next.textContent = `${SCENES[(i + 1) % SCENES.length][1]} →`;
        next.href = SCENES[(i + 1) % SCENES.length][0];

        nav.append(deck, prev, count, next);

        // A scene can call GemmaDemo.setRelated({ href, label }) before init()
        // to hang its matching documentation section off the nav.
        if (related) {
            const link = document.createElement('a');
            link.href = related.href;
            link.textContent = related.label;
            link.style.marginLeft = '10px';
            link.style.color = 'var(--energy-dark)';
            link.style.background = 'var(--energy-soft)';
            link.style.borderColor = 'rgba(60,218,107,.3)';
            nav.appendChild(link);
        }

        document.body.appendChild(nav);
    }

    function buildCue() {
        const cue = document.createElement('div');
        cue.className = 'start-cue';
        cue.id = 'startCue';
        cue.innerHTML = 'Press <kbd>Space</kbd> to step through this scene';
        document.body.appendChild(cue);
    }

    // The narration container is injected too, so no scene has to repeat it.
    function buildBeat() {
        if ($('#beat')) return;
        const b = document.createElement('div');
        b.className = 'beat';
        b.id = 'beat';
        document.body.appendChild(b);
    }

    /* ---- Step driver. ---- */
    let steps = [];
    let related = null;
    let cursorIdx = 0;
    let locked = false;

    function next() {
        if (locked || cursorIdx >= steps.length) return;
        const s = steps[cursorIdx++];
        $('#startCue')?.classList.add('gone');
        // A step can declare a lock in ms, so a double tap cannot cut its animation short.
        if (s.lock) {
            locked = true;
            setTimeout(() => { locked = false; }, s.lock);
        }
        s.do();
    }

    function init(sceneSteps) {
        steps = sceneSteps;
        buildNav();
        buildCue();
        buildBeat();
        document.addEventListener('keydown', (e) => {
            if (e.key === ' ' || e.key === 'ArrowRight' || e.key === 'Enter') {
                e.preventDefault();
                next();
            } else if (e.key === 'r' || e.key === 'R' || e.key === 'ArrowLeft') {
                e.preventDefault();
                location.reload();
            } else if (e.key === 'h' || e.key === 'H') {
                $('#hintBar')?.classList.toggle('hidden');
                $('#sceneNav')?.classList.toggle('hidden');
                $('#beat')?.classList.toggle('hidden');
            } else if (e.key === 't' || e.key === 'T') {
                $('#sceneTitle')?.classList.toggle('hidden');
            } else if (e.key === 'p' || e.key === 'P') {
                $('#protoBadge')?.classList.toggle('hidden');
            }
        });
        // Clicking anywhere advances too, which is easier on a trackpad.
        document.addEventListener('click', () => next());
    }

    function setRelated(r) { related = r; }

    return { $, $$, typeHTML, afterTyped, flashKeys, beat, notice, clearNotices, reveal, status, statusDone, statusReview, progress, init, setRelated, SCENES };
})();

/* ============================================================
   Icons: the lucide names the plugin actually uses, as inline SVG.
   A scene writes icon('file-text') instead of pasting a path every time.
   ============================================================ */
const ICON_PATHS = {
    'file-text': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
    'file-plus-2': '<path d="M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M3 15h6"/><path d="M6 12v6"/>',
    'folder': '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    'library': '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
    'zap': '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    'plus': '<path d="M5 12h14"/><path d="M12 5v14"/>',
    'save': '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
    'trash-2': '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    'arrow-up': '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    'copy': '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    'refresh-cw': '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    'check': '<path d="M20 6 9 17l-5-5"/>',
    'book-check': '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/><path d="m9 9.5 2 2 4-4"/>',
    'graduation-cap': '<path d="M22 10v6"/><path d="M6 12.5V16c0 1 2.7 3 6 3s6-2 6-3v-3.5"/><path d="m2 10 10-5 10 5-10 5z"/>',
    'layers': '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 12.18-9.17 4.16a2 2 0 0 1-1.66 0L2 12.18"/><path d="m22 17.18-9.17 4.16a2 2 0 0 1-1.66 0L2 17.18"/>',
    'search': '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    'history': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    'message-circle': '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/>',
    'x': '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    'square': '<rect width="18" height="18" x="3" y="3" rx="2"/>',
    'search-x': '<path d="m13.5 8.5-5 5"/><path d="m8.5 8.5 5 5"/><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    'scale': '<path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>',
    'settings': '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    'download': '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
    'cpu': '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
    'tags': '<path d="m15 5 6.3 6.3a2.4 2.4 0 0 1 0 3.4L17 19"/><path d="M9.6 4.6A2 2 0 0 0 8.2 4H4a2 2 0 0 0-2 2v4.2c0 .5.2 1 .6 1.4l8.1 8.1a2 2 0 0 0 2.8 0l4.2-4.2a2 2 0 0 0 0-2.8z"/><circle cx="6.5" cy="8.5" r=".5" fill="currentColor"/>',
    'git-compare': '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/>',
    'shield-check': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
    'network': '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>',
    'maximize-2': '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>',
    'folder-search': '<path d="M11 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v1.5"/><circle cx="17" cy="17" r="3"/><path d="m21 21-1.9-1.9"/>',
    'wand-2': '<path d="m21.6 15.9-5.5-5.5a1 1 0 0 0-1.4 0L3.4 21.7a1 1 0 0 0 0 1.4"/><path d="M15 4V2"/><path d="M15 10V8"/><path d="M12.5 5.5H10"/><path d="M20 5.5h-2.5"/><path d="m17 3-1.5 1.5"/><path d="M17 8l-1.5-1.5"/>',
    'gemma-wiki-logo': '<path d="M20.8 12.5 H79.2 a4 4 0 0 1 4 4 V83.3 a4 4 0 0 1 -4 4 H20.8 a8.3 8.3 0 0 1 -8.3 -8.3 V20.8 a8.3 8.3 0 0 1 8.3 -8.3 Z" stroke="currentColor" stroke-width="8.3" stroke-linejoin="round" stroke-linecap="round" fill="none"/><path d="M29.2 12.5 V87.5" stroke="currentColor" stroke-width="8.3" stroke-linecap="round"/><path d="M58 33 l5.27 11.73 11.73 5.27 -11.73 5.27 -5.27 11.73 -5.27 -11.73 -11.73 -5.27 11.73 -5.27 Z" fill="currentColor" stroke="none"/>',
    'circle-stop': '<circle cx="12" cy="12" r="10"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
    'wifi-off': '<path d="M12 20h.01"/><path d="M8.5 16.4a5 5 0 0 1 7 0"/><path d="M5 12.9a10 10 0 0 1 4.2-2.5"/><path d="M14.8 10.4A10 10 0 0 1 19 12.9"/><path d="M2 8.8a16 16 0 0 1 4.7-2.8"/><path d="M12.2 6a16 16 0 0 1 9.8 2.8"/><path d="m2 2 20 20"/>',
    'link': '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.8 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.8-1.7"/>',
    'list-checks': '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
    'circle-help': '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    'triangle-alert': '<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    'lightbulb': '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
    'file-clock': '<path d="M16 22h2a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><circle cx="8" cy="16" r="6"/><path d="M9.5 17.5 8 16.25V14"/>',
    'sparkles': '<path d="M9.94 14.06 12 20l2.06-5.94L20 12l-5.94-2.06L12 4 9.94 9.94 4 12z"/>',
};
/* A couple of glyphs come from the plugin itself and are drawn on their own
   grid, so the viewBox cannot be hard-coded. */
const ICON_VIEWBOX = { 'gemma-wiki-logo': '0 0 100 100' };
function icon(name, cls = '') {
    const p = ICON_PATHS[name];
    if (!p) return '';
    const vb = ICON_VIEWBOX[name] || '0 0 24 24';
    return `<svg class="${cls}" viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
}
