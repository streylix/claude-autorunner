'use strict';

// Single source of truth for the Django backend base URL.
//
// Defaults to the live loopback backend (http://localhost:8123), so existing
// behaviour is unchanged. Set CCBOT_BACKEND_URL to point a process at a
// different backend — e.g. the isolated test interface on :8124 — without
// touching any call site. Works in both the main process and the renderer
// (nodeIntegration exposes `process` there too); the env var propagates from
// the Electron process to the renderer.
function resolveBackendUrl() {
  // Remote Mode browser client: `localhost` is the VIEWER's machine, which has
  // no backend (and CORS would block a cross-origin one anyway). Resolve to ''
  // so every `${BACKEND_URL}/api/...` fetch is same-origin relative — the
  // RemoteServer that served the page reverse-proxies /api/* to the desktop's
  // loopback backend. remote-bootstrap.js sets the flag before the bundle runs.
  if (typeof window !== 'undefined' && window.__CCBOT_REMOTE__) return '';
  const env = (typeof process !== 'undefined' && process.env) ? process.env : {};
  // 127.0.0.1, NOT localhost: Electron's bundled Node resolves localhost to
  // ::1 first and does not fall back, while the Docker backend publishes on
  // 127.0.0.1 (IPv4) only — so main-process http calls to "localhost:8123"
  // ECONNREFUSED forever (this silently killed the TTS remote forwarder).
  // Chromium-side fetches never noticed because the browser tries both families.
  const raw = env.CCBOT_BACKEND_URL || env.BACKEND_URL || 'http://127.0.0.1:8123';
  return String(raw).replace(/\/$/, '');
}

const BACKEND_URL = resolveBackendUrl();

module.exports = { BACKEND_URL, resolveBackendUrl };
