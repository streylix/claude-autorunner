'use strict';

// Unit tests for the Discord authorization allow-list. Run:
//   node --test src/auth.test.js
// Requiring ../config only parses env/settings (no network), so this is safe.
const { test } = require('node:test');
const assert = require('node:assert');

// Ensure config validation prerequisites exist (not that we call validate()).
process.env.DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || 'test-token';
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || 'test-guild';

const { config } = require('../config');
const auth = require('./auth');

test('unset allow-list denies everyone (deny-by-default)', () => {
  config.allowedUserIds = [];
  assert.equal(auth.isConfigured(), false);
  assert.equal(auth.isAuthorized('123'), false);
  assert.equal(auth.isAuthorized(''), false);
  assert.equal(auth.isAuthorized(undefined), false);
});

test('deny message when unset tells the user their id + how to allow it', () => {
  config.allowedUserIds = [];
  const m = auth.denyMessage('42');
  assert.match(m, /42/);
  assert.match(m, /DISCORD_ALLOWED_USER_IDS/);
});

test('configured allow-list permits only listed ids', () => {
  config.allowedUserIds = ['111', '222'];
  assert.equal(auth.isConfigured(), true);
  assert.equal(auth.isAuthorized('111'), true);
  assert.equal(auth.isAuthorized('222'), true);
  assert.equal(auth.isAuthorized('333'), false);
});

test('numeric-vs-string ids compare correctly', () => {
  config.allowedUserIds = ['111'];
  assert.equal(auth.isAuthorized(111), true); // Discord ids arrive as strings, but be robust
});
