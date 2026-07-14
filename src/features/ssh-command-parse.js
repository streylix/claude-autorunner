'use strict';

/**
 * ssh-command-parse - Turn the text a user types into the top-middle remote
 * command bar (e.g. "ssh ethan@pop-os", "ssh host -p 2222", "user@host") into
 * the structured { host, username, sshPort, extraArgs } the Remote Mode
 * client needs.
 *
 * Accepted forms:
 *   ssh user@host              ssh host
 *   ssh user@host -p 2222      ssh -p 2222 user@host
 *   ssh -l user host           ssh -i ~/.ssh/key user@host
 *   user@host                  host
 *   ssh://user@host:2222
 *
 * Any other ssh flags are passed through as extraArgs (they are re-validated
 * against a strict charset in remote-client's normalizeConnectOptions, so
 * nothing here can smuggle shell metacharacters into the ssh argv).
 *
 * Pure string logic, zero dependencies — safe to bundle for the browser
 * renderer and unit-testable with `node --test`.
 */

// ssh flags that consume a following argument (from `man ssh`). -p and -l are
// folded into sshPort/username; the rest ride along as extraArgs.
const FLAGS_WITH_ARG = new Set([
    '-B', '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l',
    '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w'
]);

function parsePort(value, flag) {
    const port = Number(value);
    if (!/^\d+$/.test(String(value)) || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Invalid port after ' + flag + ': "' + value + '" (expected 1-65535).');
    }
    return port;
}

function splitDest(dest) {
    // user@host — usernames cannot contain '@'; use the FIRST '@' so a stray
    // extra '@' shows up as an invalid host and gets rejected downstream.
    const at = dest.indexOf('@');
    if (at > 0) return { username: dest.slice(0, at), host: dest.slice(at + 1) };
    if (at === 0) throw new Error('Missing username before "@" in "' + dest + '".');
    return { username: '', host: dest };
}

/**
 * @param {string} input - what the user typed in the command bar
 * @returns {{host:string, username:string, sshPort:number|null, extraArgs:string[]}}
 *   sshPort is null when the command didn't specify one (ssh config decides).
 * @throws {Error} with a user-facing message on anything unparseable
 */
function parseSshCommand(input) {
    const text = String(input || '').trim();
    if (!text) throw new Error('Type an ssh command, e.g.  ssh ethan@pop-os');

    // ssh://user@host:port URI form
    const uri = text.match(/^ssh:\/\/(?:([^@\/\s]+)@)?([^:\/\s]+|\[[^\]]+\])(?::(\d+))?\/?$/);
    if (uri) {
        return {
            username: uri[1] || '',
            host: uri[2].replace(/^\[|\]$/g, ''),
            sshPort: uri[3] ? parsePort(uri[3], 'ssh://') : null,
            extraArgs: []
        };
    }

    const tokens = text.split(/\s+/);
    if (tokens[0] === 'ssh') tokens.shift();
    if (tokens.length === 0) throw new Error('Add a destination, e.g.  ssh ethan@pop-os');

    let dest = null;
    let username = '';
    let sshPort = null;
    const extraArgs = [];

    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok.startsWith('-') && tok.length > 1) {
            // combined short form: -p2222 / -lethan
            if (/^-p.+/.test(tok)) { sshPort = parsePort(tok.slice(2), '-p'); continue; }
            if (/^-l.+/.test(tok)) { username = tok.slice(2); continue; }
            if (FLAGS_WITH_ARG.has(tok)) {
                const arg = tokens[++i];
                if (arg === undefined) throw new Error('Flag ' + tok + ' needs a value.');
                if (tok === '-p') { sshPort = parsePort(arg, '-p'); continue; }
                if (tok === '-l') { username = arg; continue; }
                extraArgs.push(tok, arg);
                continue;
            }
            // argument-less flag (-A, -v, -4, …): pass through
            extraArgs.push(tok);
            continue;
        }
        if (dest === null) { dest = tok; continue; }
        throw new Error('Unexpected extra word "' + tok + '" — remote commands are not supported here; just the destination (ssh user@host).');
    }

    if (!dest) throw new Error('Missing destination — e.g.  ssh ethan@pop-os');
    const parts = splitDest(dest);
    if (parts.username) username = parts.username; // user@host wins over -l
    return { host: parts.host, username, sshPort, extraArgs };
}

module.exports = { parseSshCommand };
