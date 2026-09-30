import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as hook from '../hook/snapshot';

const HOOK_SRC = path.resolve(__dirname, '../hook/snapshot.js');

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-changes-test-')));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function manifest() {
  return JSON.parse(fs.readFileSync(path.join(root, '.claude/review/manifest.json'), 'utf8'));
}

/** Install the hook script where the installer puts it, so it derives the root from its own path. */
function installScript(): string {
  const dest = path.join(root, '.claude/hooks/claude-changes-snapshot.js');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(HOOK_SRC, dest);
  return dest;
}

function payload(filePath: string, tool = 'Edit') {
  const toolInput = tool === 'NotebookEdit' ? { notebook_path: filePath } : { file_path: filePath };
  return JSON.stringify({
    session_id: 's',
    cwd: root,
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: toolInput,
    tool_use_id: 't',
  });
}

function runHookAsync(script: string, stdin: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(stdin);
  });
}

describe('recordSnapshot: first-snapshot rule', () => {
  it('snapshots an existing file once and keeps the first original', () => {
    const file = path.join(root, 'src/a.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'original\n');

    const first = hook.recordSnapshot(root, file, { now: () => 1 });
    expect(first.result).toBe('added');
    expect(first.entry).toMatchObject({ isNew: false, timestamp: 1 });

    // Claude edits the file, then edits again: the snapshot must stay the true original.
    fs.writeFileSync(file, 'edited once\n');
    const second = hook.recordSnapshot(root, file, { now: () => 2 });
    expect(second.result).toBe('exists');

    const m = manifest();
    expect(m.files).toHaveLength(1);
    const snap = path.join(root, '.claude/review/originals', m.files[0].snapshot);
    expect(fs.readFileSync(snap, 'utf8')).toBe('original\n');
    expect(m.files[0].snapshot).toBe(hook.snapshotName(file));
  });

  it('takes a fresh snapshot after the entry was removed (Keep)', () => {
    const file = path.join(root, 'a.txt');
    fs.writeFileSync(file, 'v1');
    hook.recordSnapshot(root, file);
    // Simulate Keep: entry removed from the manifest.
    hook.writeManifestAtomic(root, hook.emptyManifest());
    fs.writeFileSync(file, 'v2 (kept)');
    expect(hook.recordSnapshot(root, file).result).toBe('added');
    const m = manifest();
    expect(fs.readFileSync(path.join(root, '.claude/review/originals', m.files[0].snapshot), 'utf8')).toBe('v2 (kept)');
  });

  it('copies binary content byte for byte', () => {
    const file = path.join(root, 'img.bin');
    const bytes = Buffer.from([0, 1, 2, 255, 0, 10, 13]);
    fs.writeFileSync(file, bytes);
    hook.recordSnapshot(root, file);
    const m = manifest();
    expect(fs.readFileSync(path.join(root, '.claude/review/originals', m.files[0].snapshot)).equals(bytes)).toBe(true);
  });
});

describe('recordSnapshot: new files', () => {
  it('records a missing file as new with no snapshot', () => {
    const file = path.join(root, 'new/dir/file.ts');
    const res = hook.recordSnapshot(root, file, { now: () => 42 });
    expect(res.result).toBe('added');
    expect(manifest().files).toEqual([{ path: hook.normalizePath(file), snapshot: null, isNew: true, timestamp: 42 }]);
    expect(fs.existsSync(path.join(root, '.claude/review/originals'))).toBe(false);
  });

  it('keeps isNew after Claude writes the file and edits it again', () => {
    const file = path.join(root, 'n.ts');
    hook.recordSnapshot(root, file);
    fs.writeFileSync(file, 'created');
    expect(hook.recordSnapshot(root, file).result).toBe('exists');
    expect(manifest().files[0].isNew).toBe(true);
  });
});

describe('recordSnapshot: ignored paths', () => {
  it('ignores files outside the workspace', () => {
    const outside = path.join(os.tmpdir(), 'somewhere-else.txt');
    expect(hook.recordSnapshot(root, outside)).toMatchObject({ result: 'ignored', reason: 'outside workspace' });
    expect(hook.recordSnapshot(root, path.join(root, '..', 'sibling.txt')).result).toBe('ignored');
  });

  it('ignores the review directory itself', () => {
    const inside = path.join(root, '.claude/review/manifest.json');
    expect(hook.recordSnapshot(root, inside)).toMatchObject({ result: 'ignored', reason: 'inside review dir' });
  });

  it('ignores a missing or empty path', () => {
    expect(hook.recordSnapshot(root, undefined).result).toBe('ignored');
    expect(hook.recordSnapshot(root, '').result).toBe('ignored');
  });

  it('resolves relative paths against cwd', () => {
    fs.writeFileSync(path.join(root, 'rel.txt'), 'x');
    const res = hook.handleHookInput(JSON.parse(payload('rel.txt')), root);
    expect(res.result).toBe('added');
    expect(res.path).toBe(hook.normalizePath(path.join(root, 'rel.txt')));
  });
});

describe('path normalization', () => {
  it('normalizes separators and trailing slashes', () => {
    expect(hook.normalizePath('/a/b/../c/', 'linux')).toBe('/a/c');
    expect(hook.normalizePath('C:\\Users\\me\\proj\\file.ts', 'win32')).toBe('C:/Users/me/proj/file.ts');
    expect(hook.normalizePath('c:\\x', 'win32')).toBe('C:/x');
  });

  it('compares case-insensitively on Windows only', () => {
    expect(hook.samePath('C:\\Proj\\File.TS', 'c:/proj/file.ts', 'win32')).toBe(true);
    expect(hook.samePath('/proj/File.ts', '/proj/file.ts', 'linux')).toBe(false);
    expect(hook.snapshotName('C:\\Proj\\A.ts', 'win32')).toBe(hook.snapshotName('c:/proj/a.ts', 'win32'));
  });

  it('checks containment on path boundaries', () => {
    expect(hook.isInside('/ws/src/a.ts', '/ws', 'linux')).toBe(true);
    expect(hook.isInside('/ws', '/ws', 'linux')).toBe(true);
    expect(hook.isInside('/wsx/a.ts', '/ws', 'linux')).toBe(false);
    expect(hook.isInside('D:\\WS\\a.ts', 'd:/ws', 'win32')).toBe(true);
    expect(hook.isInside('D:\\WS\\a.ts', 'd:/ws', 'linux')).toBe(false);
  });

  it('finds manifest entries case-insensitively on Windows', () => {
    const m = { version: 1, files: [{ path: 'C:/Proj/A.ts', snapshot: null, isNew: true, timestamp: 0 }] };
    expect(hook.findEntry(m, 'c:\\proj\\a.ts', 'win32')).toBeDefined();
    expect(hook.findEntry(m, 'c:\\proj\\a.ts', 'linux')).toBeUndefined();
  });

  it('extracts file_path, and notebook_path for NotebookEdit', () => {
    expect(hook.filePathFromInput({ tool_input: { file_path: '/a' } })).toBe('/a');
    expect(hook.filePathFromInput({ tool_input: { notebook_path: '/n.ipynb' } })).toBe('/n.ipynb');
    expect(hook.filePathFromInput({})).toBeUndefined();
  });

  it('derives the root from the installed script location', () => {
    expect(hook.resolveRoot('/ws/.claude/hooks/claude-changes-snapshot.js', {}, {})).toBe('/ws');
    expect(hook.resolveRoot('/elsewhere/snapshot.js', { CLAUDE_PROJECT_DIR: '/p' }, {})).toBe('/p');
    expect(hook.resolveRoot('/elsewhere/snapshot.js', {}, { cwd: '/c' })).toBe('/c');
  });
});

describe('manifest persistence', () => {
  it('writes atomically and leaves no temp files', () => {
    for (let i = 0; i < 5; i++) hook.recordSnapshot(root, path.join(root, `f${i}.txt`));
    const files = fs.readdirSync(path.join(root, '.claude/review'));
    expect(files.filter((f) => f.includes('.tmp-'))).toEqual([]);
    expect(files).not.toContain('manifest.lock');
    expect(manifest().files).toHaveLength(5);
  });

  it('recovers from a corrupt manifest and backs it up', () => {
    fs.mkdirSync(path.join(root, '.claude/review'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude/review/manifest.json'), '{ not json');
    const { manifest: m, warning } = hook.readManifest(root);
    expect(m.files).toEqual([]);
    expect(warning).toMatch(/corrupt/);
    const backups = fs.readdirSync(path.join(root, '.claude/review')).filter((f) => f.startsWith('manifest.corrupt-'));
    expect(backups).toHaveLength(1);
    // And recording still works afterwards.
    expect(hook.recordSnapshot(root, path.join(root, 'x.txt')).result).toBe('added');
  });

  it('drops invalid entries but keeps valid ones', () => {
    fs.mkdirSync(path.join(root, '.claude/review'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude/review/manifest.json'),
      JSON.stringify({ version: 1, files: [{ path: '/a', snapshot: null, isNew: true, timestamp: 1 }, { nope: true }] }),
    );
    const { manifest: m, warning } = hook.readManifest(root);
    expect(m.files).toHaveLength(1);
    expect(warning).toMatch(/invalid/);
  });

  it('breaks a stale lock', () => {
    fs.mkdirSync(path.join(root, '.claude/review'), { recursive: true });
    const lock = path.join(root, '.claude/review/manifest.lock');
    fs.writeFileSync(lock, '999999 0');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    expect(hook.recordSnapshot(root, path.join(root, 'y.txt')).result).toBe('added');
  });
});

describe('hook process', () => {
  it('always exits 0 with no stdout, even for garbage input', () => {
    const script = installScript();
    for (const input of ['', 'not json', '{"tool_input": 5}', payload('/definitely/outside.txt')]) {
      const res = spawnSync(process.execPath, [script], { input, encoding: 'utf8' });
      expect(res.status).toBe(0);
      expect(res.stdout).toBe('');
    }
    expect(fs.readFileSync(path.join(root, '.claude/review/hook.log'), 'utf8')).toMatch(/could not parse/);
  });

  it('exits 0 when the review dir cannot be written', () => {
    const script = installScript();
    // Make ".claude/review" a file so mkdir fails.
    fs.writeFileSync(path.join(root, '.claude/review'), 'blocker');
    const res = spawnSync(process.execPath, [script], { input: payload(path.join(root, 'a.txt')), encoding: 'utf8' });
    expect(res.status).toBe(0);
  });

  it('handles Edit, Write and NotebookEdit payloads', () => {
    const script = installScript();
    fs.writeFileSync(path.join(root, 'nb.ipynb'), '{}');
    spawnSync(process.execPath, [script], { input: payload(path.join(root, 'e.txt'), 'Edit') });
    spawnSync(process.execPath, [script], { input: payload(path.join(root, 'w.txt'), 'Write') });
    spawnSync(process.execPath, [script], { input: payload(path.join(root, 'nb.ipynb'), 'NotebookEdit') });
    const paths = manifest().files.map((f: { path: string }) => path.basename(f.path)).sort();
    expect(paths).toEqual(['e.txt', 'nb.ipynb', 'w.txt']);
  });

  it('loses no updates when many hooks run concurrently', async () => {
    const script = installScript();
    const n = 20;
    for (let i = 0; i < n; i++) fs.writeFileSync(path.join(root, `c${i}.txt`), `content ${i}`);
    const runs = [];
    for (let i = 0; i < n; i++) runs.push(runHookAsync(script, payload(path.join(root, `c${i}.txt`))));
    // Plus several concurrent calls for the same file: still exactly one entry.
    for (let i = 0; i < 5; i++) runs.push(runHookAsync(script, payload(path.join(root, 'same.txt'))));
    const results = await Promise.all(runs);
    expect(results.every((r) => r.code === 0 && r.stdout === '')).toBe(true);

    const m = manifest();
    expect(m.files).toHaveLength(n + 1);
    expect(new Set(m.files.map((f: { path: string }) => f.path)).size).toBe(n + 1);
    for (let i = 0; i < n; i++) {
      const e = m.files.find((f: { path: string }) => f.path.endsWith(`/c${i}.txt`));
      expect(fs.readFileSync(path.join(root, '.claude/review/originals', e.snapshot), 'utf8')).toBe(`content ${i}`);
    }
    const leftovers = fs.readdirSync(path.join(root, '.claude/review')).filter((f) => f.includes('.tmp-') || f.endsWith('.lock'));
    expect(leftovers).toEqual([]);
    expect(fs.existsSync(path.join(root, '.claude/review/hook.log'))).toBe(false);
  });
});
