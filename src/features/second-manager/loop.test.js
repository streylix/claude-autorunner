/**
 * Termination proof for SecondManagerWatch's loop.
 *
 * Run: node src/features/second-manager/loop.test.js
 *
 * The loop must end two ways and only two ways:
 *   1. a sweep comes back with nothing left to raise
 *   2. the round cap is hit
 * Anything else is an infinite reminder loop pointed at the manager.
 */

const assert = require('assert');
const SecondManagerWatch = require('../SecondManagerWatch');

function makeBus() {
    const handlers = {};
    return {
        on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); },
        emit(name, payload) { (handlers[name] || []).forEach((fn) => fn(payload)); },
        handlers,
    };
}

function item(n) {
    return {
        kind: 'commitment',
        ask_id: n,
        commitment: `promise ${n}`,
        source_message_id: 5000 + n,
        source_timestamp: '2026-09-17T15:31:00+00:00',
        source_quote: `I will do promise ${n} for you`,
    };
}

async function run() {
    // --- 1. ends because nothing is left ---------------------------------
    {
        let clock = 1000000;
        const dispatched = [];
        const watch = new SecondManagerWatch({
            eventBus: makeBus(),
            now: () => clock,
            runSweep: async () => ({ raise: [], counts: { commitments_found: 9, suppressed: 9 } }),
            dispatch: async (t) => { dispatched.push(t); return true; },
            log: () => {},
        });
        const r = await watch.onManagerStopped({ terminalId: 999 });
        assert.strictEqual(r.stopped, 'clean', 'a clean sweep must end the loop');
        assert.strictEqual(r.raised, 0);
        assert.strictEqual(watch.round, 0, 'round counter resets when clean');
        assert.strictEqual(dispatched.length, 0, 'nothing is handed back when nothing is outstanding');
        console.log('PASS  loop ends when the sweep finds nothing');
    }

    // --- 2. ends on the cap ----------------------------------------------
    {
        let clock = 1000000;
        const dispatched = [];
        const watch = new SecondManagerWatch({
            eventBus: makeBus(),
            now: () => clock,
            // Never satisfied: the manager keeps stopping without doing the work.
            runSweep: async () => ({ raise: [item(1), item(2)], counts: { commitments_found: 2 } }),
            dispatch: async (t) => { dispatched.push(t); return true; },
            log: () => {},
            maxRounds: 3,
        });

        const results = [];
        for (let i = 0; i < 6; i++) {
            clock += 60 * 1000; // a minute between turns: past debounce, inside the reset window
            results.push(await watch.onManagerStopped({ terminalId: 999 }));
        }
        assert.strictEqual(dispatched.length, 3, 'raises exactly maxRounds times');
        assert.strictEqual(results[3].stopped, 'cap', 'the 4th stop hits the cap');
        assert.strictEqual(results[5].stopped, 'cap', 'and it stays stopped');
        console.log('PASS  loop ends on the round cap after 3 rounds');

        // --- 3. a new quiet stretch re-arms it ---------------------------
        clock += 31 * 60 * 1000; // left alone longer than ROUND_RESET_MS
        const after = await watch.onManagerStopped({ terminalId: 999 });
        assert.strictEqual(after.raised, 2, 'a fresh stretch raises again');
        assert.strictEqual(after.round, 1);
        console.log('PASS  cap re-arms after the manager is left alone');
    }

    // --- 4. guards --------------------------------------------------------
    {
        let clock = 1000000;
        let sweeps = 0;
        const watch = new SecondManagerWatch({
            eventBus: makeBus(),
            now: () => clock,
            runSweep: async () => { sweeps += 1; return { raise: [item(1)], counts: {} }; },
            dispatch: async () => true,
            log: () => {},
        });
        await watch.onManagerStopped({ terminalId: 999 });
        const debounced = await watch.onManagerStopped({ terminalId: 999 }); // same second
        assert.strictEqual(debounced.skipped, 'debounced', 'a burst of stops is one sweep');
        const other = await watch.onManagerStopped({ terminalId: 3 });
        assert.strictEqual(other.skipped, 'not the manager', 'worker terminals are ignored');
        assert.strictEqual(sweeps, 1);
        console.log('PASS  debounce and terminal filter hold');
    }

    // --- 5. every reminder quotes its source ------------------------------
    {
        const watch = new SecondManagerWatch({ eventBus: makeBus(), log: () => {} });
        const text = watch.formatReminder([item(7)], { counts: { commitments_found: 1, suppressed: 4 } });
        assert.ok(text.includes('message 5007'), 'names the source message id');
        assert.ok(text.includes('2026-09-17 15:31'), 'carries the timestamp');
        assert.ok(text.includes('> I will do promise 7 for you'), 'quotes what was said');
        assert.ok(text.includes('ask id 7'), 'gives the id needed to record a reason');
        assert.ok(/status='dropped'/.test(text), 'tells the manager how to suppress it');
        console.log('PASS  reminders quote the message that created the commitment');
    }

    console.log('\nall loop tests passed');
}

run().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
