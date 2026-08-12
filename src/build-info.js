'use strict';

// Build identity — "WHICH copy of this app is actually running?"
//
// Why this exists: a restart on 2026-08-11 appeared not to pick up renderer
// changes. The cause was not a stale cache — the app was being launched from a
// SECOND checkout (a detached-HEAD git worktree at /media/ethan/smalls/aci-serve)
// because `electron .` resolves `.` against the shell's cwd, not the repo you
// edited. Both checkouts share the same Electron userData dir, so nothing about
// the running app looked wrong from the outside. There was no way to ask the
// live app where its code came from, so the wrong theory (cache) survived.
//
// This module is that missing answer. It reports the directory the loaded code
// lives in, the git HEAD of that directory, and the mtime of renderer.js —
// surfaced three ways so it is visible no matter what you have access to:
//   * main-process stdout at startup           ([Build] ... line)
//   * renderer console at load                 (RENDERER_BUILD_... line)
//   * GET /state on the control API            (`build` / `rendererBuild`)
//
// BUILD_TAG is the cheap, unambiguous signal: bump it whenever you need to
// prove a restart picked up new code. If /state still reports the previous tag
// after a restart, the running app is NOT the code you just edited — check
// `appDir` first, before suspecting caches.
const fs = require('fs');
const path = require('path');

// Bump this on changes whose activation you need to verify after a restart.
const BUILD_TAG = '20260811-longexec-mgrgate-1';

const APP_DIR = path.resolve(__dirname, '..');

// Resolve the git HEAD of APP_DIR without shelling out. Handles the worktree
// case (.git is a FILE containing "gitdir: <path>") — which is precisely the
// situation that caused the original confusion.
function readGitHead(appDir) {
    try {
        const dotGit = path.join(appDir, '.git');
        const st = fs.statSync(dotGit);
        let gitDir = dotGit;
        if (st.isFile()) {
            const m = fs.readFileSync(dotGit, 'utf8').match(/gitdir:\s*(.+)/);
            if (!m) return null;
            gitDir = path.resolve(appDir, m[1].trim());
        }
        const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
        const ref = head.match(/^ref:\s*(.+)$/);
        if (!ref) return { branch: '(detached)', sha: head.slice(0, 12) };
        const branch = ref[1].replace('refs/heads/', '');
        // A worktree's own refs live in the shared commondir, not its gitdir.
        let sha = null;
        for (const base of [gitDir, path.join(gitDir, '..', '..')]) {
            try {
                sha = fs.readFileSync(path.join(base, ref[1]), 'utf8').trim().slice(0, 12);
                break;
            } catch (_) { /* try the next base */ }
        }
        return { branch, sha };
    } catch (_) {
        return null;
    }
}

function fileStamp(relPath) {
    try {
        return new Date(fs.statSync(path.join(APP_DIR, relPath)).mtime).toISOString();
    } catch (_) {
        return null;
    }
}

/**
 * @returns {{tag:string, appDir:string, git:{branch:string,sha:string}|null,
 *            rendererMtime:string|null, mainMtime:string|null}}
 */
function getBuildInfo() {
    return {
        tag: BUILD_TAG,
        appDir: APP_DIR,
        git: readGitHead(APP_DIR),
        rendererMtime: fileStamp('renderer.js'),
        mainMtime: fileStamp('main.js'),
    };
}

/** One-line human form for stdout / the renderer console. */
function describeBuild(prefix = 'BUILD') {
    const b = getBuildInfo();
    const git = b.git ? `${b.git.branch}@${b.git.sha}` : 'no-git';
    return `${prefix}_${b.tag} dir=${b.appDir} git=${git} renderer.js=${b.rendererMtime}`;
}

module.exports = { getBuildInfo, describeBuild, BUILD_TAG, APP_DIR };
