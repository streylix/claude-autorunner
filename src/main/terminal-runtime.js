'use strict';

// Reliable per-terminal runtime detection for the /state control API.
//
// Distinguishes a PTY that is actually running Claude Code ('claude') from a
// bare shell ('shell') from a dead/unknown PTY ('unknown') by inspecting the
// process tree under the PTY's shell pid via /proc. The `claude` CLI sets its
// process comm to literally "claude", so a descendant with comm === 'claude' is
// an unambiguous signal — no cmdline parsing needed.
//
// Pure and dependency-free (only fs/path). `procRoot` is injectable so this is
// unit-testable in plain node without Electron or node-pty.

const fs = require('fs');
const path = require('path');

const DEFAULT_PROC = '/proc';
const MAX_DEPTH = 6;   // process-tree depth cap (runaway guard)
const MAX_NODES = 200; // total nodes visited cap (runaway guard)
const CLAUDE_COMM = 'claude';

function readComm(procRoot, pid) {
  try {
    return fs.readFileSync(path.join(procRoot, String(pid), 'comm'), 'utf8').trim();
  } catch (_) {
    return null;
  }
}

function readChildren(procRoot, pid) {
  try {
    const p = path.join(procRoot, String(pid), 'task', String(pid), 'children');
    return fs.readFileSync(p, 'utf8').trim().split(/\s+/).filter(Boolean);
  } catch (_) {
    return [];
  }
}

// 'claude' | 'shell' | 'unknown'
function detectRuntime(pid, opts = {}) {
  const procRoot = opts.procRoot || DEFAULT_PROC;
  if (pid === null || pid === undefined) return 'unknown';
  // If the root process is unreadable, the PTY's process is gone/unknown.
  if (readComm(procRoot, pid) === null) return 'unknown';

  const queue = [{ pid: String(pid), depth: 0 }];
  const seen = new Set();
  let visited = 0;

  while (queue.length && visited < MAX_NODES) {
    const { pid: cur, depth } = queue.shift();
    if (seen.has(cur)) continue;
    seen.add(cur);
    visited += 1;

    if (readComm(procRoot, cur) === CLAUDE_COMM) return 'claude';

    if (depth < MAX_DEPTH) {
      for (const child of readChildren(procRoot, cur)) {
        if (!seen.has(child)) queue.push({ pid: child, depth: depth + 1 });
      }
    }
  }
  return 'shell';
}

// Absolute cwd of the process via /proc/<pid>/cwd, or null if unavailable.
function liveCwd(pid, opts = {}) {
  const procRoot = opts.procRoot || DEFAULT_PROC;
  if (pid === null || pid === undefined) return null;
  try {
    return fs.readlinkSync(path.join(procRoot, String(pid), 'cwd'));
  } catch (_) {
    return null;
  }
}

// Return a clone of `snapshot` with each terminal enriched with `runtime` and,
// when a live cwd is readable, an overridden `directory`. Pure: never mutates
// its input. `pidFor(terminalId)` resolves the PTY shell pid (or undefined).
function enrichSnapshot(snapshot, pidFor, opts = {}) {
  if (!snapshot || !Array.isArray(snapshot.terminals)) return snapshot;
  const terminals = snapshot.terminals.map((t) => {
    const pid = pidFor(t.id);
    const enriched = { ...t, runtime: detectRuntime(pid, opts) };
    const cwd = liveCwd(pid, opts);
    if (cwd) enriched.directory = cwd; // ground-truth cwd beats hook-derived/null
    return enriched;
  });
  return { ...snapshot, terminals };
}

module.exports = { detectRuntime, liveCwd, enrichSnapshot };
