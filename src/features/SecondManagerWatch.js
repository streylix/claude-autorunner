/**
 * SecondManagerWatch — the stop-triggered second manager.
 *
 * WHAT IT IS
 * A checker that runs when the manager (999) finishes a turn, reads the
 * CONVERSATION database, and hands back anything the manager promised and did
 * not deliver. It loops: raise -> manager works -> manager stops -> re-check,
 * until nothing is left or the round cap is hit.
 *
 * WHY IT READS THE CONVERSATION AND NOT THE LEDGER
 * On 2026-09-17 every task the manager dropped was agreed in a message and
 * never became a ledger row, and the ledger-reading auditor caught one of
 * three. A checker that reads rows inherits 999's exact blind spot. The sweep
 * this drives (src/features/second-manager/sweep.py) reads what was SAID.
 *
 * NO NEW TIMER
 * The trigger is the Claude Code Stop hook that already fires for every
 * app-spawned terminal (main.js HookServer -> 'claude-hook-event' ->
 * renderer). renderer.js re-emits it on the EventBus as 'manager:turn-stopped'
 * for terminal 999. This class only subscribes; it starts no interval and
 * polls nothing.
 *
 * EVERY REMINDER QUOTES ITS SOURCE
 * Each item carries the message id, its timestamp and the text of the message
 * where the commitment was made, so the manager (and Ethan) can check the
 * reminder rather than trust it.
 *
 * SUPPRESSION
 * A reason lives in conversation_log.OpenAsk (status done/dropped + notes), in
 * the database, so it survives a session roll. Anything already answered there
 * is never raised again.
 */

const path = require('path');

const MANAGER_TERMINAL_ID = 999;

// Rounds per quiet stretch. Round 1 raises, rounds 2-3 re-check what was
// raised. Beyond that the manager is either stuck or disagrees, and hammering
// it costs more than it saves — it stops and says so instead.
const DEFAULT_MAX_ROUNDS = 3;

// A fresh stretch starts when the manager has been left alone this long. Stops
// a cap reached at 14:00 from silencing the checker for the rest of the day.
const ROUND_RESET_MS = 30 * 60 * 1000;

// The manager writes several messages per turn; one sweep per burst is enough.
const DEBOUNCE_MS = 20 * 1000;

const SWEEP_SCRIPT = path.join(__dirname, 'second-manager', 'sweep.py');
const BACKEND_CONTAINER = 'claude-autorunner-backend-1';

class SecondManagerWatch {
    /**
     * @param {object} deps
     *   eventBus    - renderer EventBus (required)
     *   gui         - terminalGUI, for managerInstance.dispatch (required in app)
     *   runSweep    - async () => sweep JSON; injectable for tests
     *   dispatch    - async (text) => void; injectable for tests
     *   log         - (message, type) => void
     *   now         - () => epoch ms
     */
    constructor({ eventBus, gui, runSweep, dispatch, log, now, maxRounds } = {}) {
        this.eventBus = eventBus;
        this.gui = gui;
        this.maxRounds = maxRounds || DEFAULT_MAX_ROUNDS;
        this._now = now || (() => Date.now());
        this._runSweep = runSweep || (() => runSweepViaDocker());
        this._dispatch = dispatch || ((text) => {
            const mgr = this.gui && this.gui.managerInstance;
            if (!mgr || !mgr.running) return false;
            return mgr.dispatch(text);
        });
        this._log = log || ((message, type = 'info') => {
            if (this.eventBus) this.eventBus.emit('log:action', { message, type });
        });

        this.round = 0;
        this.lastTriggerAt = 0;
        this.busy = false;
        this.enabled = true;
        this.lastResult = null;
    }

    start() {
        if (!this.eventBus) return;
        // Both are existing signals. Neither adds a clock.
        this.eventBus.on('manager:turn-stopped', (e) => this.onManagerStopped(e || {}));
        this.eventBus.on('manager:stopped', () => this.reset('manager instance stopped'));
        this._log('Second manager armed — checks the conversation when 999 stops', 'info');
    }

    reset(why) {
        this.round = 0;
        if (why) this._log(`Second manager: round counter reset (${why})`, 'info');
    }

    /** Entry point: the manager finished a turn. */
    async onManagerStopped(e) {
        if (!this.enabled) return { skipped: 'disabled' };
        if (e && e.terminalId != null && Number(e.terminalId) !== MANAGER_TERMINAL_ID) {
            return { skipped: 'not the manager' };
        }
        if (this.busy) return { skipped: 'sweep already running' };

        const now = this._now();
        if (now - this.lastTriggerAt < DEBOUNCE_MS) return { skipped: 'debounced' };
        if (now - this.lastTriggerAt > ROUND_RESET_MS) this.round = 0;
        this.lastTriggerAt = now;

        if (this.round >= this.maxRounds) {
            // TERMINATION, case 2: the cap. Nothing is dispatched; the state is
            // reported so a human can see the checker gave up rather than
            // silently looping.
            this._log(`Second manager: round cap (${this.maxRounds}) reached — not raising again until the manager is left alone for 30 minutes`, 'warning');
            return { stopped: 'cap', round: this.round };
        }

        this.busy = true;
        try {
            const result = await this._runSweep();
            this.lastResult = result;
            const items = (result && result.raise) || [];

            if (items.length === 0) {
                // TERMINATION, case 1: nothing is left. The loop ends here and
                // the counter resets, so the next stop starts clean.
                this.reset();
                this._log('Second manager: nothing outstanding in the conversation', 'success');
                return { stopped: 'clean', round: this.round, raised: 0 };
            }

            this.round += 1;
            const text = this.formatReminder(items, result);
            const dispatched = await this._dispatch(text);
            this._log(`Second manager: handed back ${items.length} unfinished item(s), round ${this.round}/${this.maxRounds}`, 'warning');
            return { stopped: null, round: this.round, raised: items.length, dispatched, text };
        } catch (error) {
            this._log(`Second manager: sweep failed — ${error.message}`, 'error');
            return { error: error.message };
        } finally {
            this.busy = false;
        }
    }

    /**
     * Build the message handed to the manager. Every item quotes the message
     * that created the commitment, with its timestamp, so the manager can
     * verify the claim instead of taking it on faith.
     */
    formatReminder(items, result) {
        const lines = [
            `SECOND MANAGER — ${items.length} thing(s) you said you would do and have not closed.`,
            '',
            'Each one quotes the message it came from. If an item is wrong, parked, or already',
            'done, do not just ignore it: record the reason so it stops being raised, with',
            '',
            `  docker exec claude-autorunner-backend-1 python manage.py shell -c "from conversation_log.models import OpenAsk; a=OpenAsk.objects.get(id=<ID>); a.status='dropped'; a.notes=a.notes+'\\n<your reason>'; a.save()"`,
            '',
            "(status 'done' if it is finished, 'dropped' if it is parked or declined.)",
            '',
        ];
        items.forEach((it, i) => {
            const when = (it.source_timestamp || '').replace('T', ' ').slice(0, 16);
            lines.push(`${i + 1}. [${it.kind}] ask id ${it.ask_id != null ? it.ask_id : '-'} — ${it.commitment}`);
            lines.push(`   said in message ${it.source_message_id} at ${when} UTC:`);
            lines.push(`   > ${truncate(it.source_quote || it.commitment, 300)}`);
            if (it.evidence_message_id) {
                lines.push(`   (latest related message ${it.evidence_message_id}: ${truncate(it.evidence_quote, 120)})`);
            }
            lines.push('');
        });
        const counts = (result && result.counts) || {};
        lines.push(`Sweep read the conversation database directly (${counts.commitments_found || 0} commitments and asks in the window, ${counts.suppressed || 0} already settled).`);
        return lines.join('\n');
    }
}

function truncate(s, n) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * Run the sweep inside the backend container. The conversation database lives
 * there, and the container has no bind-mounted code, so the script is piped in
 * on stdin rather than installed — no image rebuild, nothing to restart.
 */
function runSweepViaDocker({ hours = 24, write = true, until = null } = {}) {
    const { spawn } = require('child_process');
    const fs = require('fs');
    // `until` replays the sweep as it would have run at that moment - the way a
    // past day can be re-checked without touching the clock.
    const args = [`--hours=${hours}`, write ? '--write' : '', until ? `--until=${until}` : '']
        .filter(Boolean).join(' ');
    return new Promise((resolve, reject) => {
        const proc = spawn('docker', [
            'exec', '-i', '-e', `SM_ARGS=${args}`,
            BACKEND_CONTAINER, 'python', 'manage.py', 'shell',
        ]);
        let out = '';
        let err = '';
        proc.stdout.on('data', (d) => { out += d.toString(); });
        proc.stderr.on('data', (d) => { err += d.toString(); });
        proc.on('error', reject);
        proc.on('close', () => {
            const start = out.indexOf('<<<SECOND_MANAGER_JSON');
            const end = out.indexOf('SECOND_MANAGER_JSON>>>');
            if (start === -1 || end === -1) {
                reject(new Error(`sweep produced no result (${(err || out).trim().slice(-200)})`));
                return;
            }
            try {
                resolve(JSON.parse(out.slice(start + '<<<SECOND_MANAGER_JSON'.length, end)));
            } catch (error) {
                reject(new Error(`sweep output was not JSON: ${error.message}`));
            }
        });
        fs.createReadStream(SWEEP_SCRIPT).pipe(proc.stdin);
    });
}

module.exports = SecondManagerWatch;
module.exports.runSweepViaDocker = runSweepViaDocker;
module.exports.MANAGER_TERMINAL_ID = MANAGER_TERMINAL_ID;
module.exports.DEFAULT_MAX_ROUNDS = DEFAULT_MAX_ROUNDS;
