'use strict';

// Unit tests for the INBOUND attachment path (user → manager).
//
// The defect these exist for: an .html file Ethan sent produced no saved file,
// no skipped entry and no log line. Two filters dropped it before anything
// could report it. So both directions are tested here — a type that must now be
// accepted, and a type that must still be refused AND must say so.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mediaInbox = require('./mediaInbox');
const { kindOf, isMedia, rejectionReason, saveAttachments } = mediaInbox;

// A fake Discord attachment. `url` is served by the stubbed fetch below.
function att(name, contentType, body = 'x', size = null) {
  return { name, contentType, url: `https://cdn.test/${name}`, size: size == null ? Buffer.byteLength(body) : size, _body: body };
}

// Stub global fetch so nothing leaves the machine; the body comes from the
// fixture itself.
const realFetch = global.fetch;
function stubFetch(map) {
  global.fetch = async (url) => {
    const entry = map.get(url);
    if (!entry) return { ok: false, status: 404 };
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(entry) };
  };
}
function restoreFetch() { global.fetch = realFetch; }

test('html and htm are accepted as text documents', () => {
  assert.equal(kindOf(att('snapchat-links.html', 'text/html; charset=utf-8')), 'text');
  assert.equal(kindOf(att('export.htm', null)), 'text');
  // by extension alone, the way Discord sometimes reports it
  assert.equal(kindOf({ name: 'page.html', contentType: '' }), 'text');
  assert.equal(isMedia(att('snapchat-links.html', 'text/html')), true);
});

test('the types that already worked still work', () => {
  assert.equal(kindOf(att('a.png', 'image/png')), 'image');
  assert.equal(kindOf(att('a.mp4', 'video/mp4')), 'video');
  assert.equal(kindOf(att('a.txt', 'text/plain')), 'text');
  assert.equal(kindOf(att('a.md', null)), 'text');
});

test('audio (live-tree only) is still accepted, and a rejection says audio works', () => {
  assert.equal(kindOf(att('note.m4a', 'audio/mp4')), 'audio');
  assert.equal(kindOf({ name: 'v.ogg', contentType: '' }), 'audio');
  assert.match(rejectionReason(att('a.zip', 'application/zip')), /audio/);
});

test('an unsupported type is rejected, and the reason names it', () => {
  const zip = att('archive.zip', 'application/zip');
  assert.equal(kindOf(zip), null);
  assert.equal(isMedia(zip), false);
  const why = rejectionReason(zip);
  assert.match(why, /unsupported file type \.zip/);
  assert.match(why, /\.html/); // tells the sender what would have worked
});

test('saveAttachments SAVES an html file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediainbox-'));
  const html = '<html><body><a href="https://sc.test/1">clip 1</a></body></html>';
  const a = att('snapchat-links.html', 'text/html; charset=utf-8', html);
  stubFetch(new Map([[a.url, html]]));
  try {
    const r = await saveAttachments([a], dir, 10);
    assert.equal(r.skipped.length, 0, 'nothing skipped');
    assert.equal(r.saved.length, 1, 'one file saved');
    assert.ok(r.saved[0].endsWith('.html'), `kept the .html extension: ${r.saved[0]}`);
    assert.equal(fs.readFileSync(r.saved[0], 'utf8'), html, 'contents round-trip');
  } finally { restoreFetch(); }
});

test('saveAttachments REPORTS an unsupported file instead of discarding it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediainbox-'));
  const zip = att('archive.zip', 'application/zip', 'PK');
  stubFetch(new Map([[zip.url, 'PK']]));
  try {
    const r = await saveAttachments([zip], dir, 10);
    assert.equal(r.saved.length, 0, 'nothing saved');
    assert.equal(r.skipped.length, 1, 'the rejection is reported, not swallowed');
    assert.equal(r.skipped[0].name, 'archive.zip', 'the filename is named');
    assert.match(r.skipped[0].reason, /unsupported file type \.zip/);
  } finally { restoreFetch(); }
});

test('a mixed message saves what it can and still reports what it cannot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediainbox-'));
  const page = att('links.html', 'text/html', '<html>hi</html>');
  const zip = att('bundle.zip', 'application/zip', 'PK');
  stubFetch(new Map([[page.url, '<html>hi</html>'], [zip.url, 'PK']]));
  try {
    const r = await saveAttachments([page, zip], dir, 10);
    assert.equal(r.saved.length, 1);
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].name, 'bundle.zip');
  } finally { restoreFetch(); }
});

test('the notice Ethan sees names the file and the reason', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediainbox-'));
  const zip = att('archive.zip', 'application/zip', 'PK');
  stubFetch(new Map([[zip.url, 'PK']]));
  try {
    const r = await saveAttachments([zip], dir, 10);
    const notice = mediaInbox.skippedNotice(r.skipped);
    console.log(`   channel reply would be: ${notice}`);
    assert.match(notice, /archive\.zip/, 'names the file');
    assert.match(notice, /unsupported file type \.zip/, 'gives the reason');
    assert.equal(mediaInbox.skippedNotice([]), '', 'nothing to say when nothing was skipped');
  } finally { restoreFetch(); }
});

test('the per-message cap still reports its overflow', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediainbox-'));
  const files = [1, 2, 3].map((n) => att(`p${n}.html`, 'text/html', `<html>${n}</html>`));
  stubFetch(new Map(files.map((f) => [f.url, f._body])));
  try {
    const r = await saveAttachments(files, dir, 2);
    assert.equal(r.saved.length, 2, 'cap respected');
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0].reason, /over the 2-file cap/);
  } finally { restoreFetch(); }
});
