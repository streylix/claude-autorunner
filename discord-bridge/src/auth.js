'use strict';

// Authorization allow-list for the Discord bridge.
//
// The manager (terminal 999) is a privileged local agent: whoever can send it
// text can steer the whole interface. Guild membership is NOT a sufficient gate
// (anyone invited to — or already in — the server could otherwise drive it), so
// we require an explicit allow-list of Discord user IDs.
//
// DENY BY DEFAULT: when DISCORD_ALLOWED_USER_IDS is unset, every command is
// denied and the user is told their own ID so they can allow themselves in one
// step (then restart the bridge). This closes the "any guild member" hole
// without silently trusting the guild.
const { config } = require('../config');

function allowList() {
  return (config.allowedUserIds || []).map(String);
}

function isConfigured() {
  return allowList().length > 0;
}

function isAuthorized(userId) {
  const allow = allowList();
  if (!allow.length) return false; // unset → deny by default
  return allow.includes(String(userId));
}

function denyMessage(userId) {
  if (!isConfigured()) {
    return (
      '🔒 This bridge has no authorized users configured, so commands are denied ' +
      'for safety.\n' +
      `Your Discord user ID is \`${userId}\`. Add it to the bridge\'s **.env**:\n` +
      `\`DISCORD_ALLOWED_USER_IDS=${userId}\`  (comma-separate to allow more), ` +
      'then restart the bridge.'
    );
  }
  return `🔒 You\'re not authorized to control this manager. (Your ID: \`${userId}\`)`;
}

module.exports = { isAuthorized, isConfigured, denyMessage, allowList };
