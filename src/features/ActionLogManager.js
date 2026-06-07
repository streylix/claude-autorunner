/**
 * ActionLogManager - Owns the left sidebar: action log feed, search,
 * and navigation between the Action Log / Completions / Pricing views.
 *
 * Subscribes to the canonical `log:action` event ({ message, type }) that
 * modules across the app already emit, and renders entries into #action-log.
 */
const MAX_LOG_ENTRIES = 500;

// Backend log shipping: every log:action entry is also POSTed to the backend,
// which prints it to stdout with a [frontend] tag — so `docker logs` carries
// the full app activity stream alongside Django's own logs.
const SHIP_ENDPOINT = 'http://localhost:8123/api/logs/frontend/';
const SHIP_FLUSH_MS = 3000;
const SHIP_MAX_BATCH = 50;
const SHIP_CIRCUIT_MS = 60000; // back off this long after a failed ship

const VIEWS = {
    'action-log-nav-btn': { viewId: 'action-log-view', title: 'Action Log' },
    'todo-nav-btn': { viewId: 'todo-view', title: 'Completions' },
    'pricing-nav-btn': { viewId: 'pricing-view', title: 'Token Usage & Costs' }
};

class ActionLogManager {
    constructor(eventBus, appStateStore) {
        this.eventBus = eventBus;
        this.appStateStore = appStateStore;
        this.entries = [];
        this.searchTerm = '';
        this.activeView = 'action-log-view';

        // Log shipping state (fire-and-forget; a dead backend never blocks UI)
        this.shipQueue = [];
        this.shipCircuitOpenUntil = 0;
        this.shipTimer = null;
    }

    initialize() {
        this.logContainer = document.getElementById('action-log');
        this.searchInput = document.getElementById('log-search');
        this.searchClearBtn = document.getElementById('search-clear-btn');
        this.clearLogBtn = document.getElementById('clear-log-btn');
        this.sidebarTitle = document.getElementById('sidebar-title');

        this.setupEventListeners();
        this.setupDOMHandlers();

        this.addEntry({ message: 'Auto-Injector initialized', type: 'info' });
    }

    setupEventListeners() {
        this.eventBus.on('log:action', (data) => {
            if (data && data.message) {
                this.addEntry({ message: data.message, type: data.type || 'info' });
            }
        });
    }

    setupDOMHandlers() {
        // View switching between Action Log / Completions / Pricing
        Object.keys(VIEWS).forEach((btnId) => {
            const btn = document.getElementById(btnId);
            if (btn) {
                btn.addEventListener('click', () => this.switchView(btnId));
            }
        });

        // Search filter
        if (this.searchInput) {
            this.searchInput.addEventListener('input', () => {
                this.searchTerm = this.searchInput.value.toLowerCase();
                this.render();
            });
        }

        if (this.searchClearBtn) {
            this.searchClearBtn.addEventListener('click', () => {
                if (this.searchInput) this.searchInput.value = '';
                this.searchTerm = '';
                this.render();
            });
        }

        // Clear all logs
        if (this.clearLogBtn) {
            this.clearLogBtn.addEventListener('click', () => this.clearAll());
        }
    }

    switchView(btnId) {
        const target = VIEWS[btnId];
        if (!target) return;

        Object.values(VIEWS).forEach(({ viewId }) => {
            const view = document.getElementById(viewId);
            if (view) view.style.display = viewId === target.viewId ? '' : 'none';
        });

        Object.keys(VIEWS).forEach((id) => {
            const btn = document.getElementById(id);
            if (btn) btn.classList.toggle('active', id === btnId);
        });

        if (this.sidebarTitle) this.sidebarTitle.textContent = target.title;
        this.activeView = target.viewId;
        this.eventBus.emit('ui:sidebar-view-changed', { viewId: target.viewId });
    }

    addEntry({ message, type }) {
        const entry = {
            message: String(message),
            type: ['info', 'success', 'warning', 'error'].includes(type) ? type : 'info',
            timestamp: new Date()
        };

        this.entries.push(entry);
        if (this.entries.length > MAX_LOG_ENTRIES) {
            this.entries.shift();
        }

        this.queueForShipping(entry);

        // Append just the new node when it passes the active filter
        if (this.logContainer && this.matchesSearch(entry)) {
            this.logContainer.appendChild(this.buildEntryNode(entry));
            this.logContainer.scrollTop = this.logContainer.scrollHeight;
        }
    }

    matchesSearch(entry) {
        return !this.searchTerm || entry.message.toLowerCase().includes(this.searchTerm);
    }

    buildEntryNode(entry) {
        const item = document.createElement('div');
        item.className = `log-item log-${entry.type}`;

        const time = document.createElement('span');
        time.className = 'log-time';
        time.textContent = `[${entry.timestamp.toLocaleTimeString('en-US', { hour12: false })}]`;

        const msg = document.createElement('span');
        msg.className = 'log-message';
        msg.textContent = entry.message; // textContent: log lines may carry user/terminal text

        item.appendChild(time);
        item.appendChild(msg);
        return item;
    }

    render() {
        if (!this.logContainer) return;
        this.logContainer.innerHTML = '';
        this.entries
            .filter((entry) => this.matchesSearch(entry))
            .forEach((entry) => this.logContainer.appendChild(this.buildEntryNode(entry)));
        this.logContainer.scrollTop = this.logContainer.scrollHeight;
    }

    clearAll() {
        this.entries = [];
        this.render();
        this.eventBus.emit('log:cleared');
    }

    getEntries() {
        return this.entries.slice();
    }

    // ======= BACKEND LOG SHIPPING =======
    queueForShipping(entry) {
        this.shipQueue.push({
            ts: entry.timestamp.toISOString(),
            type: entry.type,
            message: entry.message
        });

        if (this.shipQueue.length >= SHIP_MAX_BATCH) {
            this.flushShipQueue();
        } else if (!this.shipTimer) {
            this.shipTimer = setTimeout(() => this.flushShipQueue(), SHIP_FLUSH_MS);
        }
    }

    async flushShipQueue() {
        if (this.shipTimer) {
            clearTimeout(this.shipTimer);
            this.shipTimer = null;
        }
        if (this.shipQueue.length === 0) return;
        if (Date.now() < this.shipCircuitOpenUntil) {
            // Backend recently unreachable - drop quietly rather than pile up
            this.shipQueue = [];
            return;
        }

        const batch = this.shipQueue.splice(0, SHIP_MAX_BATCH);
        try {
            await fetch(SHIP_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entries: batch }),
                signal: AbortSignal.timeout(2000)
            });
        } catch (error) {
            // Open the circuit: stop shipping for a while, never surface errors
            this.shipCircuitOpenUntil = Date.now() + SHIP_CIRCUIT_MS;
        }
    }
}

module.exports = ActionLogManager;
