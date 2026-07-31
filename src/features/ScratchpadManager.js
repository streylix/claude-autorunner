/**
 * ScratchpadManager - the left sidebar's Scratchpad tab: a single persistent
 * markdown document with an Obsidian-style live-preview editor.
 *
 * ONE document per app instance. Not a note list, no title, no save button —
 * the raw markdown source lives in the unified store under the `scratchpad`
 * setting and is written back debounced as you type.
 *
 * ---------------------------------------------------------------------------
 * The live-preview technique (ported from the Peridot note editor)
 * ---------------------------------------------------------------------------
 * The document is ALWAYS plain markdown text. Nothing is ever rewritten,
 * normalized, or swapped for HTML — which is what keeps undo/redo, selection,
 * arrow keys and clipboard behaving like a normal textarea, and is why copying
 * a formatted region yields the raw source (CodeMirror's clipboard handler
 * slices the document, not the DOM).
 *
 * Formatting is applied as a decoration layer on top of that text:
 *   - `Decoration.mark`  -> inline styling (bold, italic, code, strike, link)
 *   - `Decoration.line`  -> block styling (headings, quote, fenced code)
 *   - `Decoration.replace` -> HIDES the syntax characters, or swaps them for a
 *                             widget (bullet, checkbox, horizontal rule)
 *
 * Caret proximity is what makes it "live". The plugin rebuilds on every
 * selection change and applies one of two visibility rules per element:
 *
 *   INLINE marks (`**`, `_`, `~~`, `` ` ``, `[`/`]`) reveal when the selection
 *   overlaps the PARENT styled span. The test is `sel.from <= to && sel.to >= from`,
 *   which is inclusive at both ends — so a caret sitting directly adjacent to
 *   the span counts as inside it, exactly as the spec asks.
 *
 *   BLOCK marks (`#`, `>`, `-`, `1.`, ```` ``` ````, `---`) reveal when the caret
 *   is anywhere on the SAME LINE (or, for fenced code, anywhere inside the
 *   block). Line-level syntax with a caret-span rule would flicker mid-word.
 *
 * Because only decorations change, the document never changes when syntax
 * shows/hides — so the caret cannot jump, and fast typing can't drop or
 * reorder characters. That is the whole point of doing it this way rather
 * than re-rendering HTML into a contenteditable.
 */

// Provided by vendor/codemirror-md.js (see scripts/codemirror-entry.js).
const CM = (typeof window !== 'undefined' && window.CM6) || null;

const STORE_KEY = 'scratchpad';
const CARET_KEY = 'scratchpadCaret';
const SAVE_DEBOUNCE_MS = 400;

// Inline markers: hidden unless the selection touches the parent styled span.
// LinkMark is handled separately (the `](url)` tail has no node of its own).
const INLINE_MARK_NAMES = new Set([
    'EmphasisMark',
    'StrikethroughMark',
    'CodeMark',
]);

// Block markers: hidden unless the caret is on the same line.
const BLOCK_MARK_NAMES = new Set(['HeaderMark', 'QuoteMark', 'ListMark']);

// Nodes that get a visual style regardless of caret position.
const STYLE_NODE_NAMES = {
    StrongEmphasis: 'cm-md-bold',
    Emphasis: 'cm-md-italic',
    InlineCode: 'cm-md-code',
    Strikethrough: 'cm-md-strike',
    ATXHeading1: 'cm-md-h1',
    ATXHeading2: 'cm-md-h2',
    ATXHeading3: 'cm-md-h3',
    ATXHeading4: 'cm-md-h4',
    ATXHeading5: 'cm-md-h5',
    ATXHeading6: 'cm-md-h6',
    Blockquote: 'cm-md-quote',
    FencedCode: 'cm-md-fenced',
};

const LIST_LINE_RE = /^(\s*)([-*+]|\d+[.)])\s+/;

class ScratchpadManager {
    constructor(eventBus, appStateStore, ipcHandler) {
        this.eventBus = eventBus;
        this.appStateStore = appStateStore;
        this.ipc = ipcHandler;
        this.view = null;
        this.saveTimer = null;
        this.caretTimer = null;
        this.loaded = false;
    }

    async initialize() {
        this.host = document.getElementById('scratchpad-editor');
        if (!this.host) return;

        if (!CM) {
            this.host.innerHTML =
                '<div class="scratchpad-error">Editor unavailable — run <code>npm run build:editor</code>.</div>';
            return;
        }

        this.buildEditor();
        await this.load();
        this.setupDOMHandlers();
    }

    // ---------------------------------------------------------------------
    // Editor construction
    // ---------------------------------------------------------------------

    buildEditor() {
        const {
            EditorState, EditorView, keymap, placeholder,
            markdown, GFM, defaultKeymap, history, historyKeymap,
        } = CM;

        defineWidgets();
        this.syncLoad = CM.Annotation.define();

        const livePreview = this.createLivePreviewPlugin();
        this.livePreview = livePreview;

        this.view = new EditorView({
            state: EditorState.create({
                doc: '',
                extensions: [
                    history(),
                    keymap.of([
                        { key: 'Mod-b', run: wrapSelection('**', '**', 'bold text') },
                        { key: 'Mod-i', run: wrapSelection('*', '*', 'italic text') },
                        { key: 'Enter', run: continueList },
                        indentListKey(),
                        outdentListKey(),
                        ...defaultKeymap,
                        ...historyKeymap,
                    ]),
                    EditorView.contentAttributes.of({ spellcheck: 'true' }),
                    markdown({ extensions: [GFM] }),
                    placeholder('Jot something down…  **bold**, # heading, - [ ] task'),
                    EditorView.lineWrapping,
                    livePreview,
                    // Widget-backed replacements (bullet, checkbox, rule) are
                    // atomic so arrow keys step over them instead of landing
                    // inside a range with no visible text.
                    EditorView.atomicRanges.of(
                        (view) => view.plugin(livePreview)?.atomic || CM.Decoration.none
                    ),
                    EditorView.updateListener.of((update) => {
                        if (update.transactions.some((tr) => tr.annotation(this.syncLoad))) return;
                        if (update.docChanged) this.scheduleSave(update.state.doc.toString());
                        if (update.selectionSet) this.scheduleCaretSave(update.state.selection.main.head);
                    }),
                ],
            }),
            parent: this.host,
        });
    }

    /**
     * The decoration engine. Rebuilds on doc change, viewport change, and —
     * critically — every selection change, which is what drives the reveal.
     */
    createLivePreviewPlugin() {
        const { ViewPlugin, Decoration, syntaxTree } = CM;

        return ViewPlugin.fromClass(
            class {
                constructor(view) {
                    this.build(view);
                }

                update(update) {
                    if (update.docChanged || update.viewportChanged || update.selectionSet) {
                        this.build(update.view);
                    }
                }

                build(view) {
                    const { from: vFrom, to: vTo } = view.viewport;
                    const doc = view.state.doc;
                    const sel = view.state.selection.main;

                    // Inclusive at both ends: a caret directly adjacent to a
                    // span counts as touching it.
                    const cursorIn = (from, to) => sel.from <= to && sel.to >= from;

                    // Lines the selection covers — the block-level reveal rule.
                    const activeLines = new Set();
                    for (let n = doc.lineAt(sel.from).number; n <= doc.lineAt(sel.to).number; n++) {
                        activeLines.add(n);
                    }

                    const items = [];
                    const atomicItems = [];

                    syntaxTree(view.state).iterate({
                        from: vFrom,
                        to: vTo,
                        enter: (node) => {
                            const name = node.name;

                            // ---- visual styling (always on) ----
                            if (STYLE_NODE_NAMES[name]) {
                                const klass = STYLE_NODE_NAMES[name];
                                const isBlock =
                                    name.startsWith('ATXHeading') ||
                                    name === 'Blockquote' ||
                                    name === 'FencedCode';
                                if (isBlock) {
                                    const first = doc.lineAt(node.from).number;
                                    const last = doc.lineAt(node.to).number;
                                    for (let n = first; n <= last; n++) {
                                        items.push(Decoration.line({ class: klass }).range(doc.line(n).from));
                                    }
                                } else if (node.from < node.to) {
                                    items.push(Decoration.mark({ class: klass }).range(node.from, node.to));
                                }
                            }

                            // ---- fenced code: hide the ``` lines ----
                            // The fence marks live on their own lines, so a
                            // plain replace would leave two blank rows. Collapse
                            // the whole line instead, and only while the caret
                            // is outside the block.
                            if (name === 'FencedCode') {
                                if (!cursorIn(node.from, node.to)) {
                                    const first = doc.lineAt(node.from);
                                    const last = doc.lineAt(node.to);
                                    items.push(
                                        Decoration.line({ class: 'cm-md-fence-line' }).range(first.from)
                                    );
                                    if (last.number !== first.number && /^\s*(`{3,}|~{3,})\s*$/.test(last.text)) {
                                        items.push(
                                            Decoration.line({ class: 'cm-md-fence-line' }).range(last.from)
                                        );
                                    }
                                }
                                return undefined; // keep descending for CodeText
                            }

                            // ---- horizontal rule ----
                            // No mark child in the grammar; the whole node IS
                            // the syntax, so swap the line for a rule widget.
                            if (name === 'HorizontalRule') {
                                if (!activeLines.has(doc.lineAt(node.from).number) && node.from < node.to) {
                                    const deco = Decoration.replace({ widget: new RuleWidget() });
                                    items.push(deco.range(node.from, node.to));
                                    atomicItems.push(deco.range(node.from, node.to));
                                }
                                return false;
                            }

                            // ---- inline markers ----
                            if (INLINE_MARK_NAMES.has(name) && node.from < node.to) {
                                const parent = node.node.parent;
                                const span = parent
                                    ? { from: parent.from, to: parent.to }
                                    : { from: node.from, to: node.to };
                                if (!cursorIn(span.from, span.to)) {
                                    items.push(Decoration.replace({}).range(node.from, node.to));
                                }
                            }

                            // ---- links: keep the text, hide [ ]( url ) ----
                            if (name === 'Link') {
                                const linkNode = node.node;
                                const firstMark = linkNode.firstChild;
                                let secondMark = firstMark?.nextSibling || null;
                                while (secondMark && secondMark.name !== 'LinkMark') {
                                    secondMark = secondMark.nextSibling;
                                }
                                const raw = doc.sliceString(node.from, node.to);
                                const m = raw.match(/\]\(([^)]+)\)/);
                                const url = m ? m[1] : '';
                                if (firstMark && secondMark) {
                                    const textFrom = firstMark.to;
                                    const textTo = secondMark.from;
                                    if (textFrom < textTo && url) {
                                        items.push(
                                            Decoration.mark({
                                                class: 'cm-md-linktext',
                                                attributes: { 'data-href': url },
                                            }).range(textFrom, textTo)
                                        );
                                    }
                                    if (!cursorIn(node.from, node.to)) {
                                        if (firstMark.from < firstMark.to) {
                                            items.push(Decoration.replace({}).range(firstMark.from, firstMark.to));
                                        }
                                        if (secondMark.from < node.to) {
                                            items.push(Decoration.replace({}).range(secondMark.from, node.to));
                                        }
                                    }
                                }
                            }

                            // ---- block markers ----
                            if (BLOCK_MARK_NAMES.has(name) && node.from < node.to) {
                                // Task items: the TaskMarker branch below eats
                                // the whole `- [ ]` prefix, so skip the ListMark
                                // here or the two ranges would overlap.
                                if (name === 'ListMark') {
                                    const lineText = doc.lineAt(node.from).text;
                                    if (/^\s*(?:[-*+]|\d+[.)])\s+\[(?: |x|X)\]/.test(lineText)) return undefined;
                                }

                                if (!activeLines.has(doc.lineAt(node.from).number)) {
                                    // Swallow the space after the marker so the
                                    // gap left by `# ` / `> ` / `- ` closes up.
                                    let to = node.to;
                                    const ws = doc.sliceString(to, to + 4).match(/^[ \t]+/);
                                    if (ws) to += ws[0].length;

                                    if (name === 'ListMark') {
                                        // Ordered lists keep their number —
                                        // hiding `1.` would lose information.
                                        const marker = doc.sliceString(node.from, node.to);
                                        const isOrdered = /^\d/.test(marker);
                                        const deco = Decoration.replace({
                                            widget: new BulletWidget(isOrdered ? `${marker} ` : '• '),
                                        });
                                        items.push(deco.range(node.from, to));
                                        atomicItems.push(deco.range(node.from, to));
                                    } else {
                                        items.push(Decoration.replace({}).range(node.from, to));
                                    }
                                }
                            }

                            // ---- task checkboxes ----
                            // The widget replaces the WHOLE `- [ ]` prefix, so
                            // the list marker can't bleed through beside the
                            // box. Like every other element it yields to the
                            // caret: on the task's own line the raw `- [x]` is
                            // shown and directly editable.
                            if (name === 'TaskMarker') {
                                const line = doc.lineAt(node.from);
                                if (!activeLines.has(line.number)) {
                                    const before = doc.sliceString(line.from, node.from);
                                    const prefix = before.match(/^(\s*)(?:[-*+]|\d+[.)])\s+$/);
                                    const replaceFrom = prefix ? line.from + prefix[1].length : node.from;
                                    const checked = /x/i.test(doc.sliceString(node.from, node.to));
                                    const deco = Decoration.replace({
                                        widget: new CheckboxWidget(checked, node.from, node.to),
                                    });
                                    items.push(deco.range(replaceFrom, node.to));
                                    atomicItems.push(deco.range(replaceFrom, node.to));
                                }
                            }

                            return undefined;
                        },
                    });

                    // `true` = sort; decorations are pushed out of order above.
                    this.decorations = Decoration.set(items, true);
                    this.atomic = Decoration.set(atomicItems, true);
                }
            },
            { decorations: (v) => v.decorations }
        );
    }

    // ---------------------------------------------------------------------
    // Persistence — the app's existing unified store, via db-*-setting IPC
    // ---------------------------------------------------------------------

    async load() {
        let content = '';
        let caret = null;
        try {
            const raw = await this.ipc.invoke('db-get-setting', STORE_KEY);
            if (typeof raw === 'string') content = raw;
            const savedCaret = await this.ipc.invoke('db-get-setting', CARET_KEY);
            if (typeof savedCaret === 'number') caret = savedCaret;
        } catch (e) {
            console.warn('[Scratchpad] load failed:', e);
        }

        if (!this.view) return;
        const anchor = Math.min(caret ?? content.length, content.length);
        this.view.dispatch({
            changes: { from: 0, to: this.view.state.doc.length, insert: content },
            selection: { anchor },
            annotations: this.syncLoad.of(true),
        });
        this.loaded = true;
    }

    scheduleSave(content) {
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.ipc.invoke('db-set-setting', STORE_KEY, content).catch((e) => {
                console.warn('[Scratchpad] save failed:', e);
            });
        }, SAVE_DEBOUNCE_MS);
    }

    scheduleCaretSave(pos) {
        clearTimeout(this.caretTimer);
        this.caretTimer = setTimeout(() => {
            this.ipc.invoke('db-set-setting', CARET_KEY, pos).catch(() => { /* non-critical */ });
        }, SAVE_DEBOUNCE_MS + 200);
    }

    /** Flush any pending write immediately (called on app teardown). */
    flush() {
        if (!this.view || !this.loaded) return;
        clearTimeout(this.saveTimer);
        return this.ipc.invoke('db-set-setting', STORE_KEY, this.view.state.doc.toString());
    }

    // ---------------------------------------------------------------------
    // DOM wiring
    // ---------------------------------------------------------------------

    setupDOMHandlers() {
        // Clicking the padding below the text focuses the editor and drops the
        // caret at the end, the way a real notes app behaves.
        this.host.addEventListener('mousedown', (e) => {
            if (e.target.closest('.cm-content')) return;
            e.preventDefault();
            this.view.dispatch({ selection: { anchor: this.view.state.doc.length } });
            this.view.focus();
        });

        // Focus the editor when its sidebar tab is opened.
        this.eventBus.on('ui:sidebar-view-changed', ({ viewId }) => {
            if (viewId !== 'scratchpad-view') return;
            // requestAnimationFrame: the view is display:none until the switch
            // completes, and CodeMirror can't measure or focus a hidden editor.
            requestAnimationFrame(() => {
                this.view.requestMeasure();
                this.view.focus();
            });
        });
    }
}

// -------------------------------------------------------------------------
// Widgets
//
// Defined lazily: `class X extends CM.WidgetType` at module scope would throw
// at require() time if the vendor bundle hadn't loaded yet, taking the whole
// renderer down with it. defineWidgets() runs once, from buildEditor(), after
// CM is known to exist.
// -------------------------------------------------------------------------

let BulletWidget = null;
let CheckboxWidget = null;
let RuleWidget = null;

function defineWidgets() {
    if (BulletWidget) return;

    BulletWidget = class extends CM.WidgetType {
        constructor(marker) {
            super();
            this.marker = marker;
        }
        eq(other) { return other.marker === this.marker; }
        toDOM() {
            const span = document.createElement('span');
            span.className = 'cm-md-bullet';
            span.textContent = this.marker;
            return span;
        }
        ignoreEvent() { return true; }
    };

    CheckboxWidget = class extends CM.WidgetType {
        constructor(checked, from, to) {
            super();
            this.checked = checked;
            this.from = from;
            this.to = to;
        }
        eq(other) {
            return other.checked === this.checked && other.from === this.from && other.to === this.to;
        }
        toDOM(view) {
            const wrap = document.createElement('span');
            wrap.className = 'cm-md-task';
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = this.checked;
            box.className = 'cm-md-task-box';
            box.addEventListener('mousedown', (e) => {
                e.preventDefault();
                // Edit the SOURCE, not the widget — the document stays the truth.
                view.dispatch({
                    changes: { from: this.from, to: this.to, insert: this.checked ? '[ ]' : '[x]' },
                });
            });
            wrap.appendChild(box);
            return wrap;
        }
        ignoreEvent() { return false; }
    };

    RuleWidget = class extends CM.WidgetType {
        eq() { return true; }
        toDOM() {
            const span = document.createElement('span');
            span.className = 'cm-md-rule';
            return span;
        }
        ignoreEvent() { return true; }
    };
}

// -------------------------------------------------------------------------
// Commands
// -------------------------------------------------------------------------

const wrapSelection = (before, after = before, fallback = 'text') => (view) => {
    const sel = view.state.selection.main;
    const selected = view.state.doc.sliceString(sel.from, sel.to);
    const body = selected || fallback;
    view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: `${before}${body}${after}` },
        selection: {
            anchor: sel.from + before.length,
            head: sel.from + before.length + body.length,
        },
    });
    return true;
};

/** Enter inside a list continues it; Enter on an empty item ends the list. */
const continueList = (view) => {
    const sel = view.state.selection.main;
    if (!sel.empty) return false;
    const line = view.state.doc.lineAt(sel.head);
    const beforeCursor = line.text.slice(0, sel.head - line.from);
    const match = beforeCursor.match(/^(\s*)([-*+]|\d+[.)])\s+(\[(?: |x|X)\]\s+)?(.*)$/);
    if (!match) return false;

    const [, indent, marker, taskMarker = '', textAfterMarker] = match;
    if (!textAfterMarker.trim()) {
        view.dispatch({ changes: { from: line.from, to: sel.head, insert: indent } });
        return true;
    }
    const nextMarker = /^\d/.test(marker)
        ? marker.replace(/\d+/, (n) => String(Number(n) + 1))
        : marker;
    view.dispatch({
        changes: { from: sel.head, insert: `\n${indent}${nextMarker} ${taskMarker}` },
    });
    return true;
};

/** Tab indents list lines; elsewhere it inserts a literal tab. */
const indentListKey = () => ({
    key: 'Tab',
    run: (view) => {
        const { state } = view;
        const changes = [];
        let allLists = true;
        const seen = new Set();
        for (const range of state.selection.ranges) {
            const start = state.doc.lineAt(range.from).number;
            const end = state.doc.lineAt(range.to).number;
            for (let n = start; n <= end; n++) {
                if (seen.has(n)) continue;
                seen.add(n);
                const line = state.doc.line(n);
                if (LIST_LINE_RE.test(line.text)) changes.push({ from: line.from, insert: '\t' });
                else allLists = false;
            }
        }
        if (allLists && changes.length) {
            view.dispatch({ changes });
            return true;
        }
        view.dispatch(state.replaceSelection('\t'));
        return true;
    },
});

const outdentListKey = () => ({
    key: 'Shift-Tab',
    run: (view) => {
        const { state } = view;
        const changes = [];
        const seen = new Set();
        for (const range of state.selection.ranges) {
            const start = state.doc.lineAt(range.from).number;
            const end = state.doc.lineAt(range.to).number;
            for (let n = start; n <= end; n++) {
                if (seen.has(n)) continue;
                seen.add(n);
                const line = state.doc.line(n);
                if (!LIST_LINE_RE.test(line.text)) continue;
                if (line.text.startsWith('\t')) {
                    changes.push({ from: line.from, to: line.from + 1, insert: '' });
                } else {
                    const spaces = line.text.match(/^ {1,4}/);
                    if (spaces) changes.push({ from: line.from, to: line.from + spaces[0].length, insert: '' });
                }
            }
        }
        if (!changes.length) return false;
        view.dispatch({ changes });
        return true;
    },
});

module.exports = ScratchpadManager;
