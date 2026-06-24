#!/usr/bin/env node
/**
 * download-models.js — fetches the large speech models that are gitignored
 * (see assets/models/ in .gitignore) so they don't bloat the repo.
 *
 * Runs from `npm run download-models` and from the `postinstall` hook, and is
 * re-checked by start.sh on every launch. It MUST be tracked in git (the rest
 * of scripts/ is ignored) — without it a fresh checkout has no way to fetch the
 * model and the wake-word feature is silently dead.
 *
 * Design notes:
 *  - Idempotent: skips the download if the target already exists.
 *  - Never fatal: the speech model is optional (only the voice/wake-word
 *    feature needs it). On any failure we warn and exit 0 so `npm install`
 *    always completes. start.sh will retry the fetch on the next launch.
 *  - The archive is the vosk-browser-compatible .tar.gz expected by
 *    src/features/WakeWordManager.js (MODEL_PATH).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const MODELS = [
  {
    name: 'vosk-model-small-en-us (wake word / offline STT)',
    // Canonical vosk-browser model archive (tar.gz, ~39 MB). vosk-browser's
    // createModel() expects this packaging, not the alphacephei .zip.
    url: 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz',
    // Filename WakeWordManager + start.sh look for — keep all three in sync.
    dest: path.join(__dirname, '..', 'assets', 'models', 'vosk-model-small-en-us.tar.gz'),
  },
];

function download(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.part';
    const file = fs.createWriteStream(tmp);

    const req = https.get(url, (res) => {
      // Follow redirects (the GitHub Pages asset can 301/302).
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.rmSync(tmp, { force: true });
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
        const next = new URL(res.headers.location, url).toString();
        return resolve(download(next, dest, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.rmSync(tmp, { force: true });
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }

      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      let lastPct = -1;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (total) {
          const pct = Math.floor((received / total) * 100);
          if (pct !== lastPct && pct % 10 === 0) {
            process.stdout.write(`   …${pct}%\r`);
            lastPct = pct;
          }
        }
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => {
        fs.renameSync(tmp, dest);
        resolve();
      }));
    });

    req.on('error', (err) => {
      file.close();
      fs.rmSync(tmp, { force: true });
      reject(err);
    });
  });
}

(async () => {
  for (const model of MODELS) {
    if (fs.existsSync(model.dest)) {
      console.log(`✓ ${model.name} already present — skipping.`);
      continue;
    }
    fs.mkdirSync(path.dirname(model.dest), { recursive: true });
    console.log(`⬇ Downloading ${model.name}…`);
    try {
      await download(model.url, model.dest);
      console.log(`✓ Saved ${path.relative(process.cwd(), model.dest)}`);
    } catch (err) {
      // Non-fatal: warn and continue so npm install never breaks on this.
      console.warn(`⚠ Could not download ${model.name}: ${err.message}`);
      console.warn(`  The wake-word/voice feature stays disabled until this succeeds.`);
      console.warn(`  Retry any time with: npm run download-models`);
    }
  }
})();
