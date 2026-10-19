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
const { execFileSync } = require('child_process');

const DEFAULT_PROC = '/proc';
const MAX_DEPTH = 6;   // process-tree depth cap (runaway guard)
const MAX_NODES = 200; // total nodes visited cap (runaway guard)
const CLAUDE_COMM = 'claude';

// ---- darwin fallback: /proc does not exist on macOS ----
// Before this fallback existed, every terminal was runtime 'unknown' on
// macOS forever, which made pty-control refuse POST /terminal/claude
// unconditionally. On darwin we take ONE `ps -axo pid,ppid,command` snapshot
// (cached ~1.5s — the runtime watcher polls every 2.5s per terminal, and
// /state enriches every terminal per request) and walk the child tree from
// it. The claude CLI rewrites its process title, so its argv[0] reads
// literally "claude"; a freshly exec'd one shows the binary path, whose
// basename is also "claude". Either counts.
const PS_TTL_MS = 1500;
let _psCache = { at: 0, table: null };

function parsePsOutput(out) {
  // line: "  PID  PPID command with args..."
  const table = new Map(); // pid -> { ppid, command }
  for (const line of String(out).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) table.set(m[1], { ppid: m[2], command: m[3] });
  }
  return table;
}

function psSnapshot(opts) {
  if (opts.psOutput !== undefined) return parsePsOutput(opts.psOutput); // tests
  const now = Date.now();
  if (_psCache.table && now - _psCache.at < PS_TTL_MS) return _psCache.table;
  try {
    const out = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 3000,
    });
    _psCache = { at: now, table: parsePsOutput(out) };
    return _psCache.table;
  } catch (_) {
    return null;
  }
}

function isClaudeCommand(command) {
  const first = String(command).split(/\s+/)[0] || '';
  return first === CLAUDE_COMM || path.basename(first) === CLAUDE_COMM;
}

// 'claude' | 'shell' | 'unknown' from a ps table (darwin path).
function detectRuntimeFromPs(pid, opts) {
  const table = psSnapshot(opts);
  if (!table) return 'unknown';
  if (!table.has(String(pid))) return 'unknown'; // PTY process is gone

  const children = new Map(); // ppid -> [pid]
  for (const [p, info] of table) {
    if (!children.has(info.ppid)) children.set(info.ppid, []);
    children.get(info.ppid).push(p);
  }

  const queue = [{ pid: String(pid), depth: 0 }];
  const seen = new Set();
  let visited = 0;
  while (queue.length && visited < MAX_NODES) {
    const { pid: cur, depth } = queue.shift();
    if (seen.has(cur)) continue;
    seen.add(cur);
    visited += 1;

    if (isClaudeCommand(table.get(cur).command)) return 'claude';

    if (depth < MAX_DEPTH) {
      for (const child of children.get(cur) || []) {
        if (!seen.has(child)) queue.push({ pid: child, depth: depth + 1 });
      }
    }
  }
  return 'shell';
}

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
  if (pid === null || pid === undefined) return 'unknown';
  // An explicitly injected procRoot (tests, exotic setups) always takes the
  // /proc path; an injected psOutput always takes the ps path; otherwise the
  // real platform decides.
  const usePs = opts.psOutput !== undefined
    || (!opts.procRoot && process.platform === 'darwin');
  if (usePs) {
    return detectRuntimeFromPs(pid, opts);
  }
  const procRoot = opts.procRoot || DEFAULT_PROC;
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
