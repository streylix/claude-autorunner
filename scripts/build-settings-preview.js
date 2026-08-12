#!/usr/bin/env node
/**
 * Build a standalone preview of the settings modal.
 *
 * Everything is extracted from the real sources — the modal markup out of
 * index.html, the full stylesheet, and the setupSettingsNav() body out of
 * renderer.js — so the preview exercises the shipped nav/search logic instead
 * of a copy that can drift. Nothing here is loaded by the app; it exists so the
 * layout can be rendered and screenshotted in a plain browser.
 *
 *   node scripts/build-settings-preview.js [outFile]
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = process.argv[2] || path.join(root, 'docs', 'settings-preview.html');

const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

/** Slice a balanced <div>…</div> starting at the line that declares `id`. */
function extractModal(html) {
    const lines = html.split('\n');
    const start = lines.findIndex(l => l.includes('id="settings-modal"'));
    if (start === -1) throw new Error('settings-modal not found in index.html');
    let depth = 0;
    for (let i = start; i < lines.length; i++) {
        depth += (lines[i].match(/<div\b/g) || []).length;
        depth -= (lines[i].match(/<\/div>/g) || []).length;
        if (depth === 0 && i > start) return lines.slice(start, i + 1).join('\n');
    }
    throw new Error('unbalanced settings-modal markup');
}

/** Slice a balanced method body out of the renderer class. */
function extractMethod(js, name) {
    const at = js.indexOf(`\n    ${name}() {`);
    if (at === -1) throw new Error(`${name}() not found in renderer.js`);
    const open = js.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < js.length; i++) {
        if (js[i] === '{') depth++;
        else if (js[i] === '}' && --depth === 0) {
            return `function ${name}() ${js.slice(open, i + 1)}`;
        }
    }
    throw new Error(`unbalanced ${name}()`);
}

let modal = extractModal(read('index.html'));

// The app renders these through lucide at runtime; swap in the equivalent glyph
// so the preview's Test buttons aren't blank.
const speaker = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
modal = modal.replace(/<i data-lucide="volume-2"><\/i>/g, speaker);

const page = `<!DOCTYPE html>
<meta charset="utf-8">
<title>Settings preview</title>
<style>
${read('style.css')}
/* Preview harness only — the app supplies these via its own shell. */
html, body { height: 100%; margin: 0; background: var(--bg-secondary); }
</style>
${modal.replace('class="modal settings-modal"', 'class="modal settings-modal show"')}
<script>
${extractMethod(read('renderer.js'), 'setupSettingsNav')}

// Selects the app fills from disk at runtime; stubbed so they aren't empty.
const stubs = {
  'completion-sound-select': ['beep.wav', 'chime.wav', 'hud4.wav'],
  'injection-sound-select': ['click.wav', 'pop.wav'],
  'prompted-sound-select': ['screenshot.wav', 'ding.wav'],
};
for (const [id, opts] of Object.entries(stubs)) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = opts.map(o => '<option>' + o + '</option>').join('');
}
document.getElementById('microphone-select').innerHTML =
  '<option>System default</option><option>Blue Yeti (USB)</option>';

window.settingsNav = setupSettingsNav();
</script>
`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, page);
console.log(`wrote ${path.relative(root, out)} (${(page.length / 1024).toFixed(0)} KB)`);
