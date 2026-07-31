/**
 * MoonlightService - everything the games panel's Moonlight card can ask for.
 *
 * Sits between the renderer's IPC calls and the three pieces below it:
 * identity (who we are), hosts (who we know), nvhttp (how we talk). Nothing
 * here does any streaming — this is the control plane: find a host, pair with
 * it, list its apps, keep its stream settings, start and stop a session.
 *
 * One shape worth explaining. Pairing cannot be a single request/response,
 * because the PIN has to be on screen *while* the host is still waiting for it.
 * So `beginPair()` returns the PIN immediately and the handshake continues in
 * the background, reporting through `moonlight:event` broadcasts. The renderer
 * shows the PIN the moment it has it and updates as stages land.
 */
const path = require('path');
const MoonlightIdentity = require('./identity');
const MoonlightHosts = require('./hosts');
const NvHttp = require('./nvhttp');
const pairing = require('./pairing');
const { scan } = require('./hosts');
const StreamSession = require('./stream');

class MoonlightService {
    /**
     * @param {string} userDataDir  Electron's userData path
     * @param {(channel: string, payload: any) => void} broadcast
     */
    constructor(userDataDir, broadcast) {
        this.dir = path.join(userDataDir, 'moonlight');
        this.identity = new MoonlightIdentity(this.dir);
        this.hosts = new MoonlightHosts(this.dir);
        this.broadcast = broadcast || (() => {});
        this.pendingPair = null;
        this.stream = null;
    }

    client(address) {
        const known = this.hosts.get(address);
        return new NvHttp(address, this.identity, { serverCert: known ? known.serverCert : null });
    }

    emit(event, payload = {}) {
        try {
            this.broadcast('moonlight:event', Object.assign({ event }, payload));
        } catch (_) { /* window closed mid-flight */ }
    }

    // ---------- hosts ----------

    listHosts() {
        return this.hosts.list().map((host) => ({
            address: host.address,
            hostname: host.hostname || host.address,
            paired: !!host.serverCert,
            lastSeen: host.lastSeen || null,
            hasOverrides: !!host.settings,
        }));
    }

    /**
     * Contact a host and cache what it says. Used both when adding by hand and
     * when refreshing a card, so an unreachable host updates rather than throws.
     */
    async refreshHost(address) {
        const info = await this.client(address).serverInfo();
        this.hosts.upsert(address, {
            hostname: info.hostname,
            lastSeen: Date.now(),
        });
        // The host already knows us but we had no certificate on file — record
        // it now rather than asking for a PIN we do not need.
        if (info.adoptedCert) {
            this.hosts.upsert(address, { serverCert: info.adoptedCert });
            this.emit('pair-done', { address, ok: true, adopted: true });
        }
        // A host that reports itself unpaired has forgotten us — usually a
        // Sunshine reinstall. Drop the stale certificate so the UI offers to
        // pair again instead of failing every mTLS call.
        if (this.hosts.get(address).serverCert && info.verified && !info.paired) {
            this.hosts.upsert(address, { serverCert: null });
            info.paired = false;
        }
        return Object.assign(info, { known: true, settings: this.hosts.settingsFor(address) });
    }

    async addHost(address) {
        const cleaned = String(address || '').trim();
        if (!cleaned) throw new Error('Enter an address.');
        if (this.hosts.get(cleaned)) {
            return this.refreshHost(cleaned);
        }
        // Probe before persisting, so a typo does not become a permanent card.
        const info = await new NvHttp(cleaned, this.identity).serverInfo();
        this.hosts.upsert(cleaned, { hostname: info.hostname, lastSeen: Date.now() });
        return Object.assign(info, { known: true, settings: this.hosts.settingsFor(cleaned) });
    }

    removeHost(address) {
        return this.hosts.remove(address);
    }

    /** Sweep the LAN, then ask each hit to identify itself. */
    async discover() {
        this.emit('scan-started');
        const addresses = await scan();
        const results = [];

        for (const address of addresses) {
            try {
                const info = await new NvHttp(address, this.identity).serverInfo();
                results.push({
                    address,
                    hostname: info.hostname,
                    known: !!this.hosts.get(address),
                });
            } catch (_) {
                // Port 47989 open but not a GameStream host — ignore it.
            }
        }

        this.emit('scan-finished', { found: results.length });
        return results;
    }

    // ---------- pairing ----------

    beginPair(address) {
        if (this.pendingPair && this.pendingPair.address === address) {
            return { pin: this.pendingPair.pin, resumed: true };
        }

        const pin = pairing.randomPin();
        const client = this.client(address);
        const record = { address, pin, cancelled: false };
        this.pendingPair = record;

        client.pair(pin, (stage) => {
            if (!record.cancelled) this.emit('pair-progress', { address, stage });
        }).then((result) => {
            if (record.cancelled) return;
            this.hosts.upsert(address, { serverCert: result.serverCert, lastSeen: Date.now() });
            this.emit('pair-done', { address, ok: true });
        }).catch((error) => {
            if (record.cancelled) return;
            this.emit('pair-done', { address, ok: false, error: error.message });
        }).finally(() => {
            if (this.pendingPair === record) this.pendingPair = null;
        });

        return { pin };
    }

    /**
     * Stop showing the PIN. The in-flight request is left to finish on its own
     * — it is a long-poll the host will time out, and tearing the socket down
     * mid-handshake is what leaves Sunshine stuck refusing later attempts.
     */
    cancelPair(address) {
        if (this.pendingPair && this.pendingPair.address === address) {
            this.pendingPair.cancelled = true;
            this.pendingPair = null;
            return true;
        }
        return false;
    }

    async unpair(address) {
        try {
            await this.client(address).unpair();
        } catch (_) { /* host unreachable; forget it locally regardless */ }
        this.hosts.upsert(address, { serverCert: null });
        return true;
    }

    // ---------- apps ----------

    async apps(address) {
        const host = this.hosts.get(address);
        if (!host || !host.serverCert) throw new Error('Pair with this host first.');
        return this.client(address).appList();
    }

    appAsset(address, appId) {
        return this.client(address).appAsset(appId);
    }

    // ---------- settings ----------

    settings(address) {
        return {
            defaults: MoonlightHosts.defaults(),
            global: this.hosts.globalSettings(),
            effective: address ? this.hosts.settingsFor(address) : this.hosts.globalSettings(),
            hasOverrides: address ? !!(this.hosts.get(address) || {}).settings : false,
        };
    }

    saveSettings(address, patch, scope = 'global') {
        if (scope === 'host' && address) {
            this.hosts.setHostSettings(address, patch);
        } else {
            this.hosts.setGlobalSettings(patch);
        }
        return this.settings(address);
    }

    resetSettings(address, scope = 'global') {
        if (scope === 'host' && address) {
            this.hosts.clearHostSettings(address);
        } else {
            this.hosts.setGlobalSettings(MoonlightHosts.defaults());
        }
        return this.settings(address);
    }

    // ---------- sessions ----------

    /**
     * Start a stream and return where the card can read frames from.
     *
     * Only one runs at a time — the host can only serve one session, and the
     * client ports are fixed, so a second would collide on both.
     */
    async launch(address, appId, { resume = false } = {}) {
        const host = this.hosts.get(address);
        if (!host || !host.serverCert) throw new Error('Pair with this host first.');

        // A resume reattaches to the session already running on the host, so the
        // old local stream goes away without cancelling anything over there.
        if (this.stream) await this.stopStream({ cancelHost: !resume });

        // The host may still be running a session we are no longer attached to —
        // a client that crashed or was killed leaves one behind, and Sunshine
        // then refuses a fresh /launch. Reattach to it when it is the same app,
        // and clear it out when it is a different one, rather than failing with
        // an error the user can do nothing about.
        if (!resume) {
            try {
                const info = await this.client(address).serverInfo();
                if (info.currentGame) {
                    if (String(info.currentGame) === String(appId)) {
                        resume = true;
                    } else {
                        await this.client(address).cancel().catch(() => {});
                    }
                }
            } catch (_) { /* unreachable; the launch below will report it */ }
        }

        const settings = this.hosts.settingsFor(address);
        const stream = new StreamSession(address, settings, this.client(address));
        this.stream = stream;

        stream.on('stage', (stage) => this.emit('stream-stage', { address, stage }));
        stream.on('ended', (reason) => {
            if (this.stream === stream) this.stream = null;
            this.emit('stream-ended', { address, reason });
        });

        try {
            const info = await stream.start(appId, { resume });
            this.emit('session-started', { address, appId });
            return Object.assign({ address, appId, settings }, info);
        } catch (error) {
            this.stream = null;
            await stream.stop({ cancelHost: false }).catch(() => {});
            throw error;
        }
    }

    streamStats() {
        return this.stream ? this.stream.stats() : { running: false };
    }

    async stopStream({ cancelHost = true } = {}) {
        if (!this.stream) return false;
        const stream = this.stream;
        this.stream = null;
        await stream.stop({ cancelHost }).catch(() => {});
        return true;
    }

    async quit(address) {
        if (this.stream) return this.stopStream();
        const cancelled = await this.client(address).cancel();
        this.emit('session-stopped', { address });
        return cancelled;
    }
}

/**
 * Register the IPC surface. Every handler answers `{ ok, ... }` rather than
 * throwing across the boundary, because the caller is a sandboxed game frame
 * relaying through the renderer and an Error there arrives as an unhelpful
 * generic string.
 */
function registerMoonlightIpc(ipcMain, service) {
    const wrap = (fn) => async (_event, args = {}) => {
        try {
            return { ok: true, result: await fn(args || {}) };
        } catch (error) {
            return { ok: false, error: error.message || String(error) };
        }
    };

    ipcMain.handle('moonlight:hosts', wrap(async () => service.listHosts()));
    ipcMain.handle('moonlight:add-host', wrap(({ address }) => service.addHost(address)));
    ipcMain.handle('moonlight:remove-host', wrap(({ address }) => service.removeHost(address)));
    ipcMain.handle('moonlight:refresh-host', wrap(({ address }) => service.refreshHost(address)));
    ipcMain.handle('moonlight:discover', wrap(() => service.discover()));

    ipcMain.handle('moonlight:pair', wrap(({ address }) => service.beginPair(address)));
    ipcMain.handle('moonlight:pair-cancel', wrap(({ address }) => service.cancelPair(address)));
    ipcMain.handle('moonlight:unpair', wrap(({ address }) => service.unpair(address)));

    ipcMain.handle('moonlight:apps', wrap(({ address }) => service.apps(address)));
    ipcMain.handle('moonlight:app-asset', wrap(({ address, appId }) => service.appAsset(address, appId)));

    ipcMain.handle('moonlight:settings', wrap(({ address }) => service.settings(address)));
    ipcMain.handle('moonlight:save-settings', wrap(({ address, patch, scope }) => service.saveSettings(address, patch, scope)));
    ipcMain.handle('moonlight:reset-settings', wrap(({ address, scope }) => service.resetSettings(address, scope)));

    ipcMain.handle('moonlight:launch', wrap(({ address, appId, resume }) => service.launch(address, appId, { resume })));
    ipcMain.handle('moonlight:quit', wrap(({ address }) => service.quit(address)));
    ipcMain.handle('moonlight:stream-stats', wrap(() => service.streamStats()));
}

module.exports = MoonlightService;
module.exports.registerMoonlightIpc = registerMoonlightIpc;
