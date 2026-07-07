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
  const env = (typeof process !== 'undefined' && process.env) ? process.env : {};
  const raw = env.CCBOT_BACKEND_URL || env.BACKEND_URL || 'http://localhost:8123';
  return String(raw).replace(/\/$/, '');
}

const BACKEND_URL = resolveBackendUrl();

module.exports = { BACKEND_URL, resolveBackendUrl };
