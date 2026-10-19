'use strict';

// Lightweight logger. Always prints to stdout; optionally mirrors to the app's
// unified log stream (POST /api/logs/frontend/) so bridge activity interleaves
// with everything else in `docker compose logs -f backend`, tagged [frontend].

const { config } = require('../config');

function ts() {
  // Date.now() is fine here (plain Node process, not a workflow script).
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

async function forward(message, type) {
  if (!config.forwardLogsToBackend) return;
  try {
    await fetch(`${config.backendUrl}/api/logs/frontend/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `[discord-bridge] ${message}`, type }),
    });
  } catch (_) { /* logging must never throw */ }
}

function make(level, type) {
  return (message, ...rest) => {
    const line = rest.length ? `${message} ${rest.map(String).join(' ')}` : message;
    // eslint-disable-next-line no-console
    console[level === 'error' ? 'error' : 'log'](`${ts()} [${level}] ${line}`);
    forward(line, type);
  };
}

module.exports = {
  info: make('info', 'info'),
  warn: make('warn', 'warning'),
  error: make('error', 'error'),
  success: make('ok', 'success'),
};
