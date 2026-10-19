#!/usr/bin/env node
'use strict';

/**
 * remote-url - Print the browser access URL for the running app's Remote Mode.
 *
 * Reads the same 0600 session file the app writes at startup
 * (~/.config/ccbot/session.json) and prints the loopback URL with the session
 * token in the URL FRAGMENT (never sent over HTTP), plus the SSH tunnel line
 * to reach it from another machine. Mirrors ssh-view's discovery model.
 */
const { readSessionFile } = require('../src/main/session-file');
const os = require('os');

const session = readSessionFile();
if (!session) {
  console.error('No session file found — is the Auto-Injector app running?');
  process.exit(1);
}
if (!session.remote || !session.remote.port) {
  console.error('The app is running but Remote Mode is OFF.');
  console.error('Enable it with CCBOT_REMOTE=1 (or the remoteServerEnabled setting) and restart the app.');
  process.exit(1);
}

const url = `http://127.0.0.1:${session.remote.port}/#k=${session.token}`;
console.log('Remote Mode is up (loopback only).');
console.log('');
console.log('  Local browser:   ' + url);
console.log('');
console.log('  From another machine, tunnel first:');
console.log(`    ssh -L ${session.remote.port}:127.0.0.1:${session.remote.port} ${os.userInfo().username}@<this-host>`);
console.log('  then open the same URL there.');
