#!/usr/bin/env node
/**
 * Build a standalone preview of the terminal header's MUTE button.
 *
 * Same approach as build-settings-preview.js: everything is extracted from the
 * real sources — the terminal-1 header markup out of index.html, the full
 * stylesheet, and muteButtonHtml()/applyMuteChrome() out of renderer.js — so
 * the preview shows the shipped chrome rather than a copy that can drift.
 * Nothing here is loaded by the app; it exists so the button can be rendered
 * and screenshotted in a plain browser WITHOUT restarting Electron (a restart
 * kills the manager session).
 *
 *   node scripts/build-terminal-header-preview.js [outFile]
 *   node scripts/build-terminal-header-preview.js --shot   # + PNGs, both themes
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const shot = args.includes('--shot');
const out = args.find((a) => !a.startsWith('--')) || path.join(root, 'docs', 'terminal-mute-preview.html');

const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

/** Slice the balanced <div class="terminal-header">…</div> out of index.html. */
function extractHeader(html) {
    const lines = html.split('\n');
    const start = lines.findIndex((l) => l.includes('class="terminal-header"'));
    if (start === -1) throw new Error('terminal-header not found in index.html');
    let depth = 0;
    for (let i = start; i < lines.length; i++) {
        depth += (lines[i].match(/<div\b/g) || []).length;
        depth -= (lines[i].match(/<\/div>/g) || []).length;
        if (depth === 0 && i > start) return lines.slice(start, i + 1).join('\n');
    }
    throw new Error('unbalanced terminal-header markup');
}

/** Slice a balanced method body out of the renderer class, as a function. */
function extractMethod(js, signature, name) {
    const at = js.indexOf(`\n    ${signature} {`);
    if (at === -1) throw new Error(`${signature} not found in renderer.js`);
    const open = js.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < js.length; i++) {
        if (js[i] === '{') depth++;
        else if (js[i] === '}' && --depth === 0) {
            const args = signature.slice(signature.indexOf('(') + 1, signature.lastIndexOf(')'));
            return `function ${name}(${args}) ${js.slice(open, i + 1)}`;
        }
    }
    throw new Error(`unbalanced ${signature}`);
}

const renderer = read('renderer.js');
const header = extractHeader(read('index.html'));
const muteButtonHtml = extractMethod(renderer, 'muteButtonHtml(terminalId)', 'muteButtonHtml');
const applyMuteChrome = extractMethod(renderer, 'applyMuteChrome(terminalId)', 'applyMuteChrome');

// lucide draws these at runtime; inline the same two glyphs so the preview's
// buttons aren't blank. (Paths lifted from lucide's bell / bell-off.)
const BELL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/></svg>';
const BELL_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742"/><path d="m2 2 20 20"/><path d="M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05"/></svg>';

const page = `<!DOCTYPE html>
<meta charset="utf-8">
<title>Terminal mute preview</title>
<style>
${read('style.css')}
/* Preview harness only — the app supplies these via its own shell. */
html, body { height: 100%; margin: 0; background: var(--bg-secondary); color: var(--text-primary);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.preview-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px;
  background: var(--border-primary); height: 100%; }
.preview-cell { display: flex; flex-direction: column; background: var(--bg-secondary); }
.preview-body { flex: 1; padding: 14px 16px; font-family: Menlo, Monaco, monospace;
  font-size: 12.5px; color: var(--text-tertiary); white-space: pre-wrap; }
.preview-note { padding: 8px 16px; font-size: 11px; color: var(--text-quaternary);
  border-top: 1px dashed var(--border-primary); }
</style>
<div class="preview-grid">
  <div class="preview-cell terminal-wrapper" data-terminal-id="1">${header}
    <div class="preview-body">$ claude
&gt; refactoring the injector...</div>
    <div class="preview-note">UNMUTED (default) — completions and stuck alerts reach the manager.</div>
  </div>
  <div class="preview-cell terminal-wrapper" data-terminal-id="2">${header}
    <div class="preview-body">$ claude
&gt; ethan is driving this one by hand</div>
    <div class="preview-note">MUTED — no completion pushes, no "appears stuck" alerts.</div>
  </div>
  <div class="preview-cell terminal-wrapper" data-terminal-id="3">${header}
    <div class="preview-body">$ npm test
PASS  248 tests</div>
    <div class="preview-note">UNMUTED, hover state on the bell.</div>
  </div>
  <div class="preview-cell terminal-wrapper" data-terminal-id="999">${header}
    <div class="preview-body">manager instance (999)</div>
    <div class="preview-note">MANAGER (999) — no mute button at all: it is the recipient.</div>
  </div>
</div>
<script>
${muteButtonHtml}
${applyMuteChrome}

// Stand-ins for the renderer instance the extracted methods run against.
const MUTED = new Set([2]);
const wrappers = new Map([...document.querySelectorAll('.terminal-wrapper')]
    .map((el) => [Number(el.dataset.terminalId), { container: el }]));
const self = {
    terminals: wrappers,
    isTerminalMuted: (id) => MUTED.has(id),
    muteButtonHtml,
};
// The app renders lucide icons; here the two glyphs are inlined by name.
const BELL = ${JSON.stringify(BELL)};
const BELL_OFF = ${JSON.stringify(BELL_OFF)};
const GLYPHS = {
    'bell': BELL,
    'bell-off': BELL_OFF,
    'x': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    'plus': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
};
window.lucide = { createIcons: ({ root }) => {
    (root || document).querySelectorAll('i[data-lucide]').forEach((i) => {
        i.outerHTML = GLYPHS[i.getAttribute('data-lucide')] || '';
    });
} };
window.lucide.createIcons({ root: document });

wrappers.forEach((data, id) => {
    const el = data.container;
    const titleEl = el.querySelector('.terminal-title');
    const btn = el.querySelector('.terminal-mute-btn');
    const status = el.querySelector('.terminal-status');
    const labels = { 1: 'aci-serve', 2: 'ethan', 3: 'tests', 999: 'Manager' };
    if (titleEl) titleEl.textContent = labels[id];
    if (status) { status.textContent = id === 2 ? 'prompted' : '...'; status.className =
        'terminal-status' + (id === 2 ? ' prompted' : ''); }
    if (btn) btn.dataset.terminalId = String(id);
    // The manager gets neither a mute nor a close button (renderer.js skips
    // both for lockTitle).
    if (id === 999) {
        if (btn) btn.remove();
        const close = el.querySelector('.close-terminal-btn');
        if (close) close.remove();
    }
    // Only the static wrapper ships the add-terminal (+) button.
    if (id !== 1) { const add = el.querySelector('.add-terminal-btn'); if (add) add.remove(); }
    applyMuteChrome.call(self, id);
});
// Third cell shows the hover affordance.
const hoverBtn = wrappers.get(3).container.querySelector('.terminal-mute-btn');
if (hoverBtn) { hoverBtn.style.color = 'var(--accent-warning)';
    hoverBtn.style.backgroundColor = 'color-mix(in srgb, var(--accent-warning) 14%, transparent)'; }
// Click to toggle, so the preview is explorable, not just a still.
document.addEventListener('click', (e) => {
    const btn = e.target.closest('.terminal-mute-btn');
    if (!btn) return;
    const id = Number(btn.dataset.terminalId);
    MUTED.has(id) ? MUTED.delete(id) : MUTED.add(id);
    applyMuteChrome.call(self, id);
});
</script>
`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, page, 'utf8');
console.log(`wrote ${out}`);

// --shot: render the page in headless chromium (playwright is already a dep)
// and drop a PNG per theme. The app themes off data-theme on <html>, so the
// attribute is set explicitly rather than relying on prefers-color-scheme.
if (shot) {
    (async () => {
        const { chromium } = require('playwright');
        const shotDir = path.join(root, 'docs', 'screenshots');
        fs.mkdirSync(shotDir, { recursive: true });
        const browser = await chromium.launch();
        for (const theme of ['dark', 'light']) {
            const page_ = await browser.newPage({ viewport: { width: 1100, height: 460 } });
            await page_.goto('file://' + out);
            await page_.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
            await page_.waitForTimeout(300);
            const file = path.join(shotDir, `terminal-mute-${theme}.png`);
            await page_.screenshot({ path: file });
            console.log(`wrote ${file}`);
            await page_.close();
        }
        await browser.close();
    })().catch((e) => { console.error(e.message); process.exit(1); });
}
