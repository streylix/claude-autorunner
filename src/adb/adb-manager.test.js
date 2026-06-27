'use strict';

// Regression test: device screenshots (and any binary ADB output) must survive
// executeCommand without UTF-8 corruption. The bug: stdout was accumulated as
// `output += data.toString()` (lossy UTF-8) and takeScreenshot then did
// `Buffer.from(output, 'binary')` — the bytes were already destroyed.
// Run: node --test src/adb/adb-manager.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const ADBManager = require('./adb-manager');

// Construct without the constructor's async ADB-path detection / spawning.
function makeManager(spawnImpl) {
  const mgr = Object.create(ADBManager.prototype);
  mgr.isInitialized = true;
  mgr.adbPath = 'adb';
  mgr.activeCommands = new Map();
  mgr.commandIdCounter = 1;
  mgr.spawn = spawnImpl;
  return mgr;
}

// Fake child process: streams the given binary chunks on stdout, then closes.
function fakeSpawn(chunks, exitCode = 0) {
  return function () {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    setImmediate(() => {
      for (const c of chunks) proc.stdout.emit('data', c);
      proc.emit('close', exitCode);
    });
    return proc;
  };
}

// Bytes that a UTF-8 round-trip mangles: PNG signature + lone continuation
// bytes, 0xFF, a truncated 2-byte sequence (0xC3 0x28) — none are valid UTF-8.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x80, 0xc3, 0x28, 0x7f, 0xfe]);

test('executeCommand preserves raw binary stdout (outputBuffer) without UTF-8 corruption', async () => {
  const chunks = [PNG.subarray(0, 6), PNG.subarray(6)]; // arrives in two chunks
  const mgr = makeManager(fakeSpawn(chunks));
  const result = await mgr.executeCommand('dev', ['shell', 'screencap', '-p'], [], {});
  assert.ok(Buffer.isBuffer(result.outputBuffer), 'outputBuffer must be a Buffer');
  assert.ok(result.outputBuffer.equals(PNG), 'raw bytes must survive intact');
  // The lossy string view does NOT round-trip — this is exactly why the old
  // `Buffer.from(output, 'binary')` corrupted screenshots.
  assert.ok(!Buffer.from(result.output, 'binary').equals(PNG), 'string path is lossy (as expected)');
});

test('takeScreenshot returns the uncorrupted PNG bytes', async () => {
  const mgr = makeManager(fakeSpawn([PNG]));
  const shot = await mgr.takeScreenshot('dev');
  assert.ok(shot.data.equals(PNG), 'screenshot bytes must match the device output exactly');
  assert.strictEqual(shot.size, PNG.length);
  assert.strictEqual(shot.format, 'png');
});
