'use strict';

// CODEX STAND-IN for the manager (T636). When the Claude manager (terminal 999)
// is out of usage or context, /manager codex opens a NEW terminal in the
// manager's directory, starts Codex there primed with the manager's own
// instructions, and records it as the stand-in. While a stand-in is active,
// LinkManager routes every inbound Discord message (typed, /prompt, voice) to
// that terminal instead of 999 — see linkManager.effectiveTarget(). /manager
// claude hands back: the Codex terminal is closed and routing returns to 999.
//
// PRIMING — a generated first prompt, not an AGENTS.md. The prompt is passed as
// Codex's [PROMPT] argument and points Codex at the SAME files the manager
// runs on (its CLAUDE.md and its memory index), so nothing is duplicated and
// nothing is written outside this bridge directory. The terminal is spawned by
// the app, so it already carries CCBOT_PORT / CCBOT_TOKEN (and its own
// CCBOT_TERMINAL_ID) in its environment — the same access the manager has.
//
// CODEX PERMISSIONS — no approval prompts (nobody is at the TUI; the user is
// on Discord), the workspace-write sandbox rooted at the manager's directory
// (it may edit its own notes/state, nothing else) PLUS the bridge outbox dir as
// a writable root (bin/tell writes there — see bridgeOutboxDir), and sandbox
// network access ON so it can reach the loopback control API and Discord.
//
// STARTING CODEX — the fresh terminal is a bare shell. The command is typed
// straight in via POST /terminal/keys (immediate; not subject to the app's
// injection gate), then confirmed by reading the screen (POST /terminal/screen
// with scrollback). If Codex never shows up, the command is re-sent once through
// POST /queue/add as "urgent" — the path the manager itself uses to start
// agents — and the screen is read again. An unconfirmed start is reported as
// such, never as success.
//
// STATE — $XDG_RUNTIME_DIR/ccbot-bridge/standin.json (next to resume.json and
// the vault): survives a bridge restart, wiped on reboot — matching the
// terminal it names, which dies with the app session. restore() re-validates
// the record against the live /state on startup/link and drops it if the
// terminal (or the whole app session, i.e. the control port) is gone.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { config } = require('../config');
const controlApi = require('./controlApi');
const log = require('./log');

// Where the manager lives. Both are env-overridable so a checkout elsewhere is
// not tied to this machine's layout; the defaults are what this deployment has
// always used. Claude Code keeps per-project memory under
// ~/.claude/projects/<project dir with every '/' turned into '-'>/memory/.
const MANAGER_DIR = process.env.CCBOT_MANAGER_DIR || '/mnt/smalls/claude-manager';
const MANAGER_CLAUDE_MD = `${MANAGER_DIR}/CLAUDE.md`;
const MANAGER_MEMORY_MD = process.env.CCBOT_MANAGER_MEMORY_MD
  || path.join(os.homedir(), '.claude', 'projects', MANAGER_DIR.replace(/\//g, '-'), 'memory', 'MEMORY.md');
const TERMINAL_TITLE = 'Codex manager stand-in';
const TERMINAL_COLOR = '#10a37f';
// What Codex's TUI shows once it is actually running (banner / composer). The
// typed command itself never matches this, so a shell that merely echoed the
// command back is not mistaken for a started Codex.
const CODEX_READY_RE = /OpenAI Codex|codex-cli|gpt-\d/i;
// Codex's first-run dialog for a folder it has not seen ("Trust this folder?
// ... Trust and continue / Open restricted / Open"). Two defenses, because a
// stall here would hit exactly when the manager is dark and nobody is at the
// TUI: (1) the launch passes project trust on the command line (-c override,
// nothing written to ~/.codex/config.toml by the bridge); (2) if the dialog
// still appears on screen, _waitForCodex answers it — Enter accepts the
// highlighted first option, "Trust and continue" (Codex then saves that
// decision itself). Verbatim wording from the codex-cli 0.162.0 binary.
const TRUST_PROMPT_RE = /Trust this folder\?/;
const TRUST_ANSWER_MAX = 2;

function defaultStorePath() {
  const base = process.env.XDG_RUNTIME_DIR
    || `/run/user/${typeof process.getuid === 'function' ? process.getuid() : 1000}`;
  return path.join(base, 'ccbot-bridge', 'standin.json');
}
function storePath() {
  return process.env.CCBOT_STANDIN_STORE || defaultStorePath();
}

// POSIX single-quote for one argv word: ' → '\'' .
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// ONE line (it is typed into a shell; a newline would submit early). $CCBOT_*
// stay literal inside the single quotes on purpose — Codex reads them from its
// own environment, the bridge never learns or forwards the token text.
function buildPrimingPrompt() {
  return [
    'You are standing in for the Claude manager (terminal 999), which is out of usage or context.',
    `Before anything else read ${MANAGER_CLAUDE_MD} (your role, rules and the control API table) and ${MANAGER_MEMORY_MD} (your memory index; open the linked notes you need).`,
    'Your control API is http://127.0.0.1:$CCBOT_PORT with header X-CCBOT-Token: $CCBOT_TOKEN; both are already set in your environment, and GET /state lists every terminal.',
    `Your tools are ${MANAGER_DIR}/bin/tell (post to Ethan on Discord: write the message to a file, then run bin/tell - <file>), bin/task, bin/steer and bin/sweep.`,
    'Messages from Ethan arrive in this terminal from Discord, each prefixed with a typed-message or voice-memo marker; answer every one with bin/tell, one sentence, plain tone.',
    'Never send anything to terminal 999 and never restart the app. Start now: run GET /state once, then confirm in one sentence via bin/tell that the Codex stand-in is ready.',
  ].join(' ');
}

// See "CODEX PERMISSIONS" above. -C pins the working root to the manager's dir
// (the terminal is created there too; -C makes it explicit to Codex).
// The bridge's outbox dir (what bin/tell → post-text.js writes its descriptor
// into). Under workspace-write everything outside the workspace and /tmp is a
// READ-ONLY mount — reproduced 2026-10-11 with `codex sandbox`: touch in
// $XDG_RUNTIME_DIR/ccbot-bridge → "Read-only file system" — so without this
// extra writable root the stand-in's very first bin/tell fails ("REFUSING to
// flag - notified: the post was not accepted"). Only the outbox is opened; the
// vault / resume / stand-in records next to it stay read-only to Codex.
function bridgeOutboxDir() {
  return config.imageOutboxDir;
}

function buildCodexCommand() {
  const trust = shellQuote(`projects."${MANAGER_DIR}".trust_level="trusted"`);
  const writable = shellQuote(`sandbox_workspace_write.writable_roots=${JSON.stringify([bridgeOutboxDir()])}`);
  return 'codex -a never -s workspace-write -c sandbox_workspace_write.network_access=true '
    + `-c ${writable} -c ${trust} -C ${MANAGER_DIR} ${shellQuote(buildPrimingPrompt())}`;
}

class StandIn {
  constructor(opts = {}) {
    this.sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.settleMs = opts.settleMs != null ? opts.settleMs : 1500;   // fresh shell before the first keystroke
    this.confirmPolls = opts.confirmPolls != null ? opts.confirmPolls : 15;
    this.pollMs = opts.pollMs != null ? opts.pollMs : 1000;
    this.state = this._read();
  }

  _read() {
    try {
      this._mtime = fs.statSync(storePath()).mtimeMs;
      const s = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
      return s && s.active ? s : null;
    } catch (_) {
      this._mtime = 0;
      return null; // missing/corrupt → no stand-in
    }
  }

  // The store file is the single source of truth, shared with the CLI
  // (tools/manager-standin.js, run by hand or by the manager itself): a change
  // written by another process is picked up on the next read, no restart.
  _refresh() {
    let m = 0;
    try { m = fs.statSync(storePath()).mtimeMs; } catch (_) { m = 0; }
    if (m !== this._mtime) this.state = this._read();
  }

  _write(record) {
    try {
      const p = storePath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = `${p}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
      fs.renameSync(tmp, p);
      try { this._mtime = fs.statSync(p).mtimeMs; } catch (_) {}
    } catch (err) {
      log.warn('stand-in store write failed:', err.message);
    }
  }

  _clear() {
    this.state = null;
    this._write({ active: false, endedAt: Date.now() });
  }

  activeTerminalId() {
    this._refresh();
    return this.state && this.state.active ? Number(this.state.terminalId) : null;
  }

  status() {
    this._refresh();
    if (!this.state) return { active: false };
    return {
      active: true,
      engine: this.state.engine,
      terminalId: Number(this.state.terminalId),
      port: this.state.port,
      startedAt: this.state.startedAt,
      confirmed: !!this.state.confirmed,
    };
  }

  async _waitForCodex(target, terminalId, polls) {
    let screen = '';
    let trustPrompt = false;
    let answers = 0;
    for (let i = 0; i < polls; i++) {
      await this.sleep(this.pollMs);
      try {
        screen = (await controlApi.getScreen(target, terminalId, { scrollback: true })).screen || '';
      } catch (_) { continue; }
      if (TRUST_PROMPT_RE.test(screen) && answers < TRUST_ANSWER_MAX) {
        // Accept "Trust and continue" (first, highlighted). A second sighting
        // means the Enter was swallowed by a redraw: select 1 explicitly too.
        trustPrompt = true;
        answers++;
        log.warn(`stand-in: Codex trust prompt on terminal ${terminalId} — answering "Trust and continue" (attempt ${answers}).`);
        try {
          await controlApi.sendKeysTo(target, terminalId, answers === 1 ? ['enter'] : ['1', 'enter']);
        } catch (err) {
          log.warn(`stand-in: answering the trust prompt failed: ${err.message}`);
        }
        continue;
      }
      if (CODEX_READY_RE.test(screen)) return { confirmed: true, screen, trustPrompt };
    }
    return { confirmed: false, screen, trustPrompt };
  }

  // Open the terminal, start Codex, confirm, record. Idempotent: an active
  // stand-in is returned as-is.
  async start(target) {
    if (!target || !target.port || !target.token) return { ok: false, error: 'not linked to a session' };
    const existing = this.activeTerminalId();
    if (existing) return { ok: true, alreadyActive: true, terminalId: existing, confirmed: !!this.state.confirmed };

    let terminalId;
    try {
      const r = await controlApi.createTerminal(target, { directory: MANAGER_DIR, title: TERMINAL_TITLE, color: TERMINAL_COLOR });
      terminalId = Number(r.terminalId);
    } catch (err) {
      return { ok: false, error: `terminal create failed: ${err.message}` };
    }
    if (!Number.isInteger(terminalId)) return { ok: false, error: 'terminal create returned no id' };

    // Record BEFORE starting Codex, so a crash mid-start never leaves an
    // untracked terminal behind (stop() will still find and close it).
    this.state = { active: true, engine: 'codex', terminalId, port: target.port, startedAt: Date.now(), confirmed: false };
    this._write(this.state);
    log.info(`stand-in: created terminal ${terminalId} in ${MANAGER_DIR}; starting Codex.`);

    const cmd = buildCodexCommand();
    await this.sleep(this.settleMs);
    try {
      await controlApi.sendKeysTo(target, terminalId, [cmd]);
      await this.sleep(config.submitDelayMs);
      await controlApi.sendKeysTo(target, terminalId, ['enter']);
    } catch (err) {
      log.warn(`stand-in: typing the codex command failed (${err.message}); will retry via the queue.`);
    }

    let c = await this._waitForCodex(target, terminalId, this.confirmPolls);
    if (!c.confirmed) {
      log.warn(`stand-in: Codex not visible on terminal ${terminalId} yet — re-sending via urgent /queue/add.`);
      try {
        await controlApi.queueAdd(target, { terminalId, content: cmd, type: 'urgent' });
      } catch (err) {
        log.warn(`stand-in: /queue/add retry failed: ${err.message}`);
      }
      c = await this._waitForCodex(target, terminalId, this.confirmPolls);
    }
    this.state.confirmed = c.confirmed;
    this.state.trustPrompt = !!c.trustPrompt;
    this._write(this.state);
    if (c.confirmed) log.success(`stand-in: Codex is running in terminal ${terminalId} — Discord messages now route there.`);
    else log.warn(`stand-in: could not confirm Codex on terminal ${terminalId}; routing there anyway (check /dump ${terminalId}).`);
    return { ok: true, terminalId, confirmed: c.confirmed, trustPrompt: !!c.trustPrompt, screen: c.screen };
  }

  // Hand back: close the Codex terminal and forget it. Routing returns to 999
  // the moment the state is cleared, even if the delete itself failed.
  async stop(target) {
    const terminalId = this.activeTerminalId();
    if (!terminalId) return { ok: true, wasActive: false };
    let deleted = false;
    let error = null;
    if (target && target.port && target.token) {
      try {
        deleted = (await controlApi.deleteTerminal(target, terminalId)).deleted;
      } catch (err) {
        error = err.message;
        log.warn(`stand-in: could not close terminal ${terminalId}: ${err.message}`);
      }
    } else {
      error = 'not linked — terminal left open';
    }
    this._clear();
    log.info(`stand-in: handed back to the manager — terminal ${terminalId} ${deleted ? 'closed' : 'not closed'}.`);
    return { ok: true, wasActive: true, terminalId, deleted, error };
  }

  // Re-validate a stored stand-in against the live app (startup / re-link).
  async restore(target) {
    this._refresh();
    if (!this.state) return { kept: false, reason: 'none' };
    const terminalId = this.activeTerminalId();
    if (!target || !target.port || !target.token) return { kept: true, reason: 'unverified — not linked' };
    if (Number(this.state.port) !== Number(target.port)) {
      const reason = `app control port changed (${this.state.port} → ${target.port}); the stand-in terminal died with the old app session`;
      this._clear();
      return { kept: false, reason };
    }
    let terminals;
    try {
      terminals = await controlApi.getFullState(target);
    } catch (err) {
      return { kept: true, reason: `unverified — ${err.message}` };
    }
    if (!terminals.some((t) => Number(t.id) === terminalId)) {
      this._clear();
      return { kept: false, reason: `terminal ${terminalId} no longer exists in /state` };
    }
    return { kept: true, reason: `terminal ${terminalId} present` };
  }
}

StandIn.buildCodexCommand = buildCodexCommand;
StandIn.buildPrimingPrompt = buildPrimingPrompt;
StandIn.bridgeOutboxDir = bridgeOutboxDir;
StandIn.storePath = storePath;
StandIn.MANAGER_DIR = MANAGER_DIR;
StandIn.CODEX_READY_RE = CODEX_READY_RE;
StandIn.TRUST_PROMPT_RE = TRUST_PROMPT_RE;

module.exports = StandIn;
