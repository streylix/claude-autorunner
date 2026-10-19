#!/usr/bin/env node
'use strict';

// CLI twin of the /manager Discord command (T636): start the Codex stand-in,
// hand back to Claude, or show the state — from the same machine, using the
// local link vault (no Discord needed). The running bridge shares the state
// file, so a stand-in started here routes Discord messages at once.
//
//   node tools/manager-standin.js codex    # open a Codex terminal + route Discord there
//   node tools/manager-standin.js claude   # close it, route back to 999
//   node tools/manager-standin.js status
//
// The manager itself can run `codex` before it runs out of context — a clean
// handover instead of a dark session.

const path = require('path');
process.chdir(path.join(__dirname, '..'));
const { resolveLatest } = require('../src/linkVault');
const StandIn = require('../src/standIn');

async function main() {
  const sub = (process.argv[2] || 'status').toLowerCase();
  const standIn = new StandIn();
  if (sub === 'status') {
    const s = standIn.status();
    console.log(JSON.stringify({ ...s, store: StandIn.storePath() }));
    return;
  }
  let target;
  try {
    target = resolveLatest();
  } catch (err) {
    console.error(`not linked: ${err.message}`);
    process.exit(2);
  }
  if (sub === 'codex') {
    const r = await standIn.start(target);
    console.log(JSON.stringify({ ...r, screen: undefined }));
    if (r.screen) console.log('--- screen (tail) ---\n' + String(r.screen).trimEnd().split('\n').slice(-25).join('\n'));
    process.exit(r.ok ? 0 : 1);
  }
  if (sub === 'claude') {
    const r = await standIn.stop(target);
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  }
  console.error('usage: manager-standin.js codex|claude|status');
  process.exit(2);
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
