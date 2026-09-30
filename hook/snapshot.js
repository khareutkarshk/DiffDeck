#!/usr/bin/env node
// Claude Changes – PreToolUse snapshot hook.
//
// Installed as <workspace>/.claude/hooks/claude-changes-snapshot.js and run by Claude Code:
//   • PreToolUse  Edit / Write / MultiEdit / NotebookEdit – snapshot that file before its first edit;
//   • PreToolUse / PostToolUse  Bash / PowerShell, and Stop – detect files a shell command changed.
// It records the ORIGINAL content of each file the first time Claude touches it, so the Claude Changes
// VS Code extension can show a diff and undo it.
//
// Zero dependencies, cross-platform. It must never block Claude: it always exits 0, never writes to
// stdout, and logs problems to <workspace>/.claude/review/hook.log.
//
// This file is also required by the extension (bundled) and by the unit tests, so every helper is
// exported and main() only runs when the file is executed directly.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REVIEW_DIR = '.claude/review';
const MANIFEST_VERSION = 1;
const LOCK_STALE_MS = 5000;
const LOCK_TIMEOUT_MS = 1500;
const LOCK_RETRY_MS = 25;
const STDIN_TIMEOUT_MS = 2000;
const MAX_LOG_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

function pathLib(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** Absolute path with forward slashes. Drive letters are upper-cased on Windows. */
function normalizePath(p, platform = process.platform, base) {
  const lib = pathLib(platform);
  let abs = base !== undefined ? lib.resolve(base, p) : lib.resolve(p);
  abs = abs.replace(/\\/g, '/');
  if (platform === 'win32' && /^[a-z]:/.test(abs)) {
    abs = abs[0].toUpperCase() + abs.slice(1);
  }
  if (abs.length > 1 && abs.endsWith('/') && !/^[A-Za-z]:\/$/.test(abs)) {
    abs = abs.slice(0, -1);
  }
  return abs;
}

/** Identity key for comparisons: normalized, and case-insensitive on Windows. */
function pathKey(p, platform = process.platform) {
  const n = normalizePath(p, platform);
  return platform === 'win32' ? n.toLowerCase() : n;
}

function samePath(a, b, platform = process.platform) {
  return pathKey(a, platform) === pathKey(b, platform);
}

/** True if `child` is `parent` itself or somewhere below it. */
function isInside(child, parent, platform = process.platform) {
  const c = pathKey(child, platform);
  let p = pathKey(parent, platform);
  if (c === p) return true;
  if (!p.endsWith('/')) p += '/';
  return c.startsWith(p);
}

function snapshotName(filePath, platform = process.platform) {
  return crypto.createHash('sha1').update(pathKey(filePath, platform)).digest('hex');
}

function reviewPaths(root) {
  const dir = path.join(root, REVIEW_DIR);
  return {
    dir,
    manifest: path.join(dir, 'manifest.json'),
    originals: path.join(dir, 'originals'),
    lock: path.join(dir, 'manifest.lock'),
    log: path.join(dir, 'hook.log'),
  };
}

// ---------------------------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------------------------

function log(root, level, message) {
  try {
    const p = reviewPaths(root);
    fs.mkdirSync(p.dir, { recursive: true });
    try {
      if (fs.statSync(p.log).size > MAX_LOG_BYTES) fs.renameSync(p.log, p.log + '.1');
    } catch {
      /* no log yet */
    }
    fs.appendFileSync(p.log, `${new Date().toISOString()} [${level}] ${message}\n`);
  } catch {
    /* logging must never throw */
  }
}

// ---------------------------------------------------------------------------------------------
// Sleeping / locking
// ---------------------------------------------------------------------------------------------

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(sleepCell, 0, 0, ms);
}

/** One attempt at taking the lock. Breaks stale locks. Returns true when acquired. */
function tryAcquireLock(lockPath, staleMs = LOCK_STALE_MS) {
  try {
    const fd = fs.openSync(lockPath, 'wx');
    try {
      fs.writeSync(fd, `${process.pid} ${Date.now()}`);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (err) {
    if (!err || err.code !== 'EEXIST') throw err;
    try {
      const age = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (age > staleMs) fs.rmSync(lockPath, { force: true });
    } catch {
      /* lock vanished between open and stat: just retry */
    }
    return false;
  }
}

function releaseLock(lockPath) {
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {
    /* ignore */
  }
}

/** Run `fn` while holding the lock file `lockPath` (synchronous). */
function withFileLockSync(lockPath, fn, timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (!tryAcquireLock(lockPath, staleMs)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path.basename(lockPath)}`);
    sleepSync(LOCK_RETRY_MS);
  }
  try {
    return fn();
  } finally {
    releaseLock(lockPath);
  }
}

/** Run `fn` while holding the manifest lock (synchronous; used by the hook). */
function withLockSync(root, fn, timeoutMs = LOCK_TIMEOUT_MS) {
  return withFileLockSync(reviewPaths(root).lock, fn, timeoutMs);
}

/** Run async `fn` while holding the manifest lock (used by the extension; never blocks the thread). */
async function withLock(root, fn, timeoutMs = LOCK_TIMEOUT_MS * 2) {
  const p = reviewPaths(root);
  fs.mkdirSync(p.dir, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (!tryAcquireLock(p.lock)) {
    if (Date.now() > deadline) throw new Error('timed out waiting for manifest lock');
    await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
  }
  try {
    return await fn();
  } finally {
    releaseLock(p.lock);
  }
}

// ---------------------------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------------------------

function emptyManifest() {
  return { version: MANIFEST_VERSION, files: [] };
}

function isValidEntry(e) {
  return (
    e &&
    typeof e === 'object' &&
    typeof e.path === 'string' &&
    (e.snapshot === null || typeof e.snapshot === 'string') &&
    typeof e.isNew === 'boolean'
  );
}

/**
 * Read the manifest. Missing → empty. Corrupt → backed up as manifest.corrupt-<ts>.json, then empty.
 * Returns { manifest, warning } where warning is set when something had to be recovered.
 */
function readManifest(root) {
  const p = reviewPaths(root);
  let raw;
  try {
    raw = fs.readFileSync(p.manifest, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { manifest: emptyManifest(), warning: undefined };
    return { manifest: emptyManifest(), warning: `could not read manifest: ${err && err.message}` };
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !Array.isArray(data.files)) throw new Error('unexpected shape');
    const files = data.files.filter(isValidEntry);
    const dropped = data.files.length - files.length;
    return {
      manifest: { version: MANIFEST_VERSION, files },
      warning: dropped ? `dropped ${dropped} invalid manifest entr${dropped === 1 ? 'y' : 'ies'}` : undefined,
    };
  } catch (err) {
    const backup = path.join(p.dir, `manifest.corrupt-${Date.now()}.json`);
    try {
      fs.copyFileSync(p.manifest, backup);
    } catch {
      /* ignore */
    }
    return {
      manifest: emptyManifest(),
      warning: `manifest was corrupt (${err && err.message}); backed up to ${path.basename(backup)} and treated as empty`,
    };
  }
}

function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const retryable = err && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY');
      if (!retryable || attempt >= 20) throw err;
      sleepSync(15);
    }
  }
}

/** Write a file atomically: temp file in the same directory, then rename over the target. */
function writeFileAtomic(target, data) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, data);
    renameWithRetry(tmp, target);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function writeManifestAtomic(root, manifest) {
  writeFileAtomic(reviewPaths(root).manifest, JSON.stringify(manifest, null, 2) + '\n');
}

function findEntry(manifest, filePath, platform = process.platform) {
  const key = pathKey(filePath, platform);
  return manifest.files.find((e) => pathKey(e.path, platform) === key);
}

// ---------------------------------------------------------------------------------------------
// Snapshotting
// ---------------------------------------------------------------------------------------------

/** realpath of the nearest existing ancestor, with the non-existing tail re-appended. */
function realpathLoose(p) {
  const tail = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** If `abs` is inside `root` once symlinks are resolved, return it expressed under `root`. */
function mapThroughRealpath(abs, root, platform) {
  if (platform !== process.platform) return undefined;
  try {
    const realRoot = realpathLoose(root);
    const realFile = realpathLoose(abs);
    if (!isInside(realFile, realRoot, platform)) return undefined;
    return normalizePath(path.join(root, path.relative(realRoot, realFile)), platform);
  } catch {
    return undefined;
  }
}

/**
 * Decide whether a path is eligible for tracking.
 * Returns the normalized absolute path, or undefined (with a reason) when it must be ignored.
 */
function eligiblePath(root, filePath, platform = process.platform, cwd) {
  if (typeof filePath !== 'string' || filePath.trim() === '') return { reason: 'no file path' };
  let abs = normalizePath(filePath, platform, cwd || root);
  if (!isInside(abs, root, platform)) {
    // The two paths may only differ by symlinks (e.g. /var vs /private/var on macOS).
    const viaReal = mapThroughRealpath(abs, root, platform);
    if (!viaReal) return { reason: 'outside workspace' };
    abs = viaReal;
  }
  if (isInside(abs, normalizePath(path.join(root, REVIEW_DIR), platform), platform)) {
    return { reason: 'inside review dir' };
  }
  return { path: abs };
}

/**
 * Record the original state of `filePath` if it is not tracked yet.
 * Returns 'added' | 'exists' | 'ignored'.
 */
function recordSnapshot(root, filePath, opts = {}) {
  const platform = opts.platform || process.platform;
  const now = opts.now || Date.now;
  const eligible = eligiblePath(root, filePath, platform, opts.cwd);
  if (!eligible.path) return { result: 'ignored', reason: eligible.reason };
  const abs = eligible.path;

  return withLockSync(root, () => {
    const { manifest, warning } = readManifest(root);
    if (warning) log(root, 'warn', warning);
    if (findEntry(manifest, abs, platform)) return { result: 'exists', path: abs };

    const p = reviewPaths(root);
    let entry;
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
    if (stat && stat.isFile()) {
      const name = snapshotName(abs, platform);
      fs.mkdirSync(p.originals, { recursive: true });
      const tmp = path.join(p.originals, `${name}.tmp-${process.pid}`);
      fs.copyFileSync(abs, tmp);
      renameWithRetry(tmp, path.join(p.originals, name));
      entry = { path: abs, snapshot: name, isNew: false, timestamp: now() };
    } else if (!stat) {
      entry = { path: abs, snapshot: null, isNew: true, timestamp: now() };
    } else {
      return { result: 'ignored', reason: 'not a regular file' };
    }
    manifest.files.push(entry);
    writeManifestAtomic(root, manifest);
    return { result: 'added', path: abs, entry };
  });
}

// ---------------------------------------------------------------------------------------------
// Shell commands (Bash / PowerShell)
//
// A shell command can change any file, so its originals can't be captured on demand. Instead we keep
// an incremental, content-addressed cache of the workspace (.claude/review/cache): before each shell
// command the cache is brought up to date (only files whose size/mtime/inode changed are re-read);
// after it, the workspace is compared against the cache and every file that was changed, created or
// deleted – and isn't tracked yet – gets a manifest entry whose original comes from the cache.
// If PostToolUse never arrives (e.g. the command failed), the next shell command or the end of the
// turn (Stop) does the comparison instead.
// ---------------------------------------------------------------------------------------------

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const SCAN_MAX_FILE_BYTES = 5 * 1024 * 1024;
const SCAN_MAX_FILES = 20000;
const SCAN_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const SCAN_DEADLINE_MS = 7000;
const CACHE_LOCK_STALE_MS = 30000;
const CACHE_LOCK_TIMEOUT_MS = 8000;
const WALK_EXCLUDES = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', '__pycache__', '.venv', 'venv', '.tox',
  '.mypy_cache', '.pytest_cache', '.next', '.nuxt', '.turbo', '.parcel-cache', '.gradle', 'target',
  '.idea', '.vscode-test', 'coverage', '.cache',
]);

function cachePaths(root) {
  const dir = path.join(root, REVIEW_DIR, 'cache');
  return {
    dir,
    blobs: path.join(dir, 'blobs'),
    index: path.join(dir, 'index.json'),
    state: path.join(dir, 'state.json'),
    lock: path.join(dir, 'cache.lock'),
  };
}

function readJsonFile(p, fallback) {
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8'));
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

function isReviewPath(rel) {
  return rel === REVIEW_DIR || rel.startsWith(REVIEW_DIR + '/');
}

/**
 * Relative (forward-slash) paths of the files to watch. In a git work tree: tracked + untracked,
 * not ignored (so .gitignore is respected). Otherwise a directory walk with common heavy dirs skipped.
 * Returns { files, complete } – complete is false when a limit was hit.
 */
function listWorkspaceFiles(root) {
  let files;
  try {
    const cp = require('child_process');
    const res = cp.spawnSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (res.status === 0 && typeof res.stdout === 'string') {
      files = [...new Set(res.stdout.split('\0').filter(Boolean))];
    }
  } catch {
    files = undefined;
  }
  let complete = true;
  if (!files) {
    files = [];
    const stack = [''];
    while (stack.length) {
      const relDir = stack.pop();
      let dirents;
      try {
        dirents = fs.readdirSync(path.join(root, relDir), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of dirents) {
        const rel = relDir ? `${relDir}/${d.name}` : d.name;
        if (d.isDirectory()) {
          if (!WALK_EXCLUDES.has(d.name) && !isReviewPath(rel)) stack.push(rel);
        } else if (d.isFile()) {
          files.push(rel);
        }
      }
      if (files.length > SCAN_MAX_FILES) break;
    }
  }
  files = files.filter((f) => !isReviewPath(f));
  if (files.length > SCAN_MAX_FILES) {
    files = files.slice(0, SCAN_MAX_FILES);
    complete = false;
  }
  return { files, complete };
}

function statSignature(st) {
  return `${st.size}:${Math.round(st.mtimeMs * 1000)}:${st.ino}`;
}

function storeBlob(blobsDir, data) {
  const hash = crypto.createHash('sha1').update(data).digest('hex');
  const p = path.join(blobsDir, hash);
  if (!fs.existsSync(p)) writeFileAtomic(p, data);
  return hash;
}

/**
 * Bring the cache index up to date with the workspace. When `record` is set, files that differ from
 * the cache are returned as changes: { rel, kind: 'modified' | 'created' | 'deleted', originalHash }.
 */
function syncCache(root, record) {
  const cp = cachePaths(root);
  const started = Date.now();
  const prev = readJsonFile(cp.index, undefined);
  const hadIndex = !!(prev && prev.files && typeof prev.files === 'object');
  const oldFiles = hadIndex ? prev.files : {};
  // New-file detection is only trustworthy when the previous index covered the whole workspace.
  const detectCreated = record && hadIndex && prev.complete === true;
  const { files, complete: listed } = listWorkspaceFiles(root);
  const next = {};
  const changes = [];
  let complete = listed;
  let totalBytes = 0;

  fs.mkdirSync(cp.blobs, { recursive: true });
  for (const rel of files) {
    const old = oldFiles[rel];
    if (Date.now() - started > SCAN_DEADLINE_MS) {
      complete = false;
      if (old) next[rel] = old;
      continue;
    }
    let st;
    try {
      st = fs.statSync(path.join(root, rel));
    } catch {
      continue; // listed but gone (e.g. deleted tracked file) – handled as "missing" below
    }
    if (!st.isFile()) continue;
    const sig = statSignature(st);
    if (old && old.sig === sig) {
      next[rel] = old;
      continue;
    }
    if (st.size > SCAN_MAX_FILE_BYTES || totalBytes + st.size > SCAN_MAX_TOTAL_BYTES) {
      next[rel] = { sig, hash: null };
      if (st.size <= SCAN_MAX_FILE_BYTES) complete = false;
      if (record && old && old.hash) changes.push({ rel, kind: 'modified', originalHash: old.hash });
      continue;
    }
    let data;
    try {
      data = fs.readFileSync(path.join(root, rel));
    } catch {
      continue;
    }
    totalBytes += data.length;
    const hash = storeBlob(cp.blobs, data);
    next[rel] = { sig, hash };
    if (!record) continue;
    if (old) {
      if (old.hash && old.hash !== hash) changes.push({ rel, kind: 'modified', originalHash: old.hash });
    } else if (detectCreated) {
      changes.push({ rel, kind: 'created', originalHash: null });
    }
  }
  if (record) {
    for (const rel of Object.keys(oldFiles)) {
      if (next[rel] || !oldFiles[rel].hash) continue;
      if (fs.existsSync(path.join(root, rel))) {
        next[rel] = oldFiles[rel]; // exists but wasn't listed (e.g. became git-ignored): keep as is
        continue;
      }
      changes.push({ rel, kind: 'deleted', originalHash: oldFiles[rel].hash });
    }
  }

  writeFileAtomic(cp.index, JSON.stringify({ version: 1, complete, files: next }));
  // Garbage-collect blobs nothing refers to any more (originals/ holds its own copies).
  const live = new Set(Object.values(next).map((e) => e.hash).filter(Boolean));
  for (const c of changes) if (c.originalHash) live.add(c.originalHash);
  try {
    for (const b of fs.readdirSync(cp.blobs)) {
      if (!live.has(b) && !b.includes('.tmp-')) fs.rmSync(path.join(cp.blobs, b), { force: true });
    }
  } catch {
    /* ignore */
  }
  if (!complete) log(root, 'warn', `workspace cache is partial (${files.length} files listed); shell changes to some files may be missed`);
  return changes;
}

/** Add manifest entries for shell-command changes (files already tracked keep their first original). */
function recordShellChanges(root, changes, opts = {}) {
  if (!changes.length) return [];
  const platform = opts.platform || process.platform;
  const now = opts.now || Date.now;
  const cp = cachePaths(root);
  const p = reviewPaths(root);
  return withLockSync(root, () => {
    const { manifest, warning } = readManifest(root);
    if (warning) log(root, 'warn', warning);
    const added = [];
    for (const c of changes) {
      const abs = normalizePath(path.join(root, c.rel), platform);
      if (findEntry(manifest, abs, platform)) continue;
      let entry;
      if (c.originalHash) {
        const name = snapshotName(abs, platform);
        fs.mkdirSync(p.originals, { recursive: true });
        const tmp = path.join(p.originals, `${name}.tmp-${process.pid}`);
        fs.copyFileSync(path.join(cp.blobs, c.originalHash), tmp);
        renameWithRetry(tmp, path.join(p.originals, name));
        entry = { path: abs, snapshot: name, isNew: false, timestamp: now() };
      } else {
        entry = { path: abs, snapshot: null, isNew: true, timestamp: now() };
      }
      manifest.files.push(entry);
      added.push(entry);
    }
    if (added.length) writeManifestAtomic(root, manifest);
    return added;
  });
}

function withCacheLock(root, fn) {
  return withFileLockSync(cachePaths(root).lock, fn, CACHE_LOCK_TIMEOUT_MS, CACHE_LOCK_STALE_MS);
}

function setInFlight(root, value) {
  const cp = cachePaths(root);
  const state = readJsonFile(cp.state, {});
  state.inFlight = value;
  writeFileAtomic(cp.state, JSON.stringify(state));
}

function isInFlight(root) {
  return !!readJsonFile(cachePaths(root).state, {}).inFlight;
}

/** PreToolUse(Bash): settle an unfinished command if any, refresh the cache, mark a command in flight. */
function beforeShellCommand(root, opts = {}) {
  return withCacheLock(root, () => {
    const pending = isInFlight(root);
    const changes = syncCache(root, pending);
    const added = recordShellChanges(root, changes, opts);
    setInFlight(root, Date.now());
    return added;
  });
}

/** PostToolUse(Bash) / Stop: record what the command(s) changed. */
function afterShellCommand(root, opts = {}) {
  return withCacheLock(root, () => {
    if (!opts.force && !isInFlight(root)) return [];
    const added = recordShellChanges(root, syncCache(root, true), opts);
    setInFlight(root, null);
    return added;
  });
}

/** Extract the file path from a PreToolUse payload (Edit/Write/MultiEdit use file_path, NotebookEdit notebook_path). */
function filePathFromInput(input) {
  const ti = input && input.tool_input;
  if (!ti || typeof ti !== 'object') return undefined;
  if (typeof ti.file_path === 'string') return ti.file_path;
  if (typeof ti.notebook_path === 'string') return ti.notebook_path;
  if (typeof ti.path === 'string') return ti.path;
  return undefined;
}

/**
 * Workspace root: the script lives at <root>/.claude/hooks/<name>.js, so derive the root from that;
 * fall back to CLAUDE_PROJECT_DIR, then to the payload's cwd.
 */
function resolveRoot(scriptPath, env, input) {
  const hooksDir = path.dirname(scriptPath);
  const claudeDir = path.dirname(hooksDir);
  if (path.basename(hooksDir) === 'hooks' && path.basename(claudeDir) === '.claude') {
    return path.dirname(claudeDir);
  }
  if (env && env.CLAUDE_PROJECT_DIR) return env.CLAUDE_PROJECT_DIR;
  if (input && typeof input.cwd === 'string') return input.cwd;
  return undefined;
}

function handleHookInput(input, root, opts = {}) {
  const event = input && input.hook_event_name;
  const tool = input && input.tool_name;
  const isShell = SHELL_TOOLS.has(tool);
  if (event === 'Stop' || event === 'SubagentStop') {
    return { result: 'shell', entries: afterShellCommand(root, opts) };
  }
  if (isShell && (event === 'PostToolUse' || event === 'PostToolUseFailure')) {
    return { result: 'shell', entries: afterShellCommand(root, opts) };
  }
  if (isShell) {
    return { result: 'shell', entries: beforeShellCommand(root, opts) };
  }
  if (event && event !== 'PreToolUse') return { result: 'ignored', reason: `event ${event}` };
  const filePath = filePathFromInput(input);
  return recordSnapshot(root, filePath, { ...opts, cwd: input && input.cwd });
}

function readStdin(timeoutMs = STDIN_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

async function main() {
  let root;
  try {
    const raw = await readStdin();
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      input = undefined;
    }
    root = resolveRoot(__filename, process.env, input);
    if (!root) return;
    if (!input) {
      log(root, 'error', `could not parse hook input (${raw.length} bytes)`);
      return;
    }
    const res = handleHookInput(input, root);
    if (process.env.CLAUDE_CHANGES_DEBUG) {
      log(root, 'debug', `${input.tool_name || '?'} ${filePathFromInput(input) || '?'} -> ${res.result}${res.reason ? ` (${res.reason})` : ''}${res.entries ? ` (+${res.entries.length})` : ''}`);
    }
  } catch (err) {
    if (root) log(root, 'error', (err && err.stack) || String(err));
  }
}

module.exports = {
  REVIEW_DIR,
  MANIFEST_VERSION,
  normalizePath,
  pathKey,
  samePath,
  isInside,
  snapshotName,
  reviewPaths,
  log,
  withLock,
  withLockSync,
  withFileLockSync,
  readManifest,
  writeFileAtomic,
  writeManifestAtomic,
  findEntry,
  eligiblePath,
  recordSnapshot,
  filePathFromInput,
  resolveRoot,
  handleHookInput,
  emptyManifest,
  SHELL_TOOLS,
  cachePaths,
  listWorkspaceFiles,
  syncCache,
  beforeShellCommand,
  afterShellCommand,
};

if (require.main === module) {
  main().finally(() => process.exit(0));
}
