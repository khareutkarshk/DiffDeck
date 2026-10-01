// Integration test that runs inside a real VS Code instance (see run.mjs).
// Simulates Claude Code by running the installed hook script and then editing files, and drives the
// extension through its commands.
'use strict';

const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, fn, timeout = 8000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what} (last: ${last && last.message ? last.message : JSON.stringify(last)})`);
}

/** What Claude Code does for an Edit/Write: run the PreToolUse hook, then write the file. */
function claudeWrites(root, rel, content, tool = 'Edit') {
  const file = path.join(root, rel);
  const script = path.join(root, '.claude/hooks/claude-changes-snapshot.js');
  const input = JSON.stringify({ cwd: root, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: file } });
  const res = cp.spawnSync(process.env.NODE_BIN || 'node', [script], { input, encoding: 'utf8' });
  assert.strictEqual(res.status, 0, `hook exited ${res.status}: ${res.stderr}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** What Claude Code does for a Bash command: PreToolUse hook, the command, PostToolUse hook. */
function claudeRunsBash(root, command) {
  const script = path.join(root, '.claude/hooks/claude-changes-snapshot.js');
  const hookRun = (event) => {
    const input = JSON.stringify({ cwd: root, hook_event_name: event, tool_name: 'Bash', tool_input: { command: 'x' } });
    const res = cp.spawnSync(process.env.NODE_BIN || 'node', [script], { input, encoding: 'utf8' });
    assert.strictEqual(res.status, 0, `hook exited ${res.status}: ${res.stderr}`);
  };
  hookRun('PreToolUse');
  command();
  hookRun('PostToolUse');
}

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(`  ✓ ${name}`);
  } catch (err) {
    results.push(`  ✗ ${name}\n      ${(err && err.stack) || err}`);
    throw err;
  }
}

async function run() {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'claude-changes');
  assert.ok(ext, 'extension not found');
  const api = await ext.activate();
  const service = api.service;
  const cfg = vscode.workspace.getConfiguration('claudeChanges');
  await cfg.update('confirmUndo', false, vscode.ConfigurationTarget.Workspace);
  await cfg.update('viewMode', 'decorations', vscode.ConfigurationTarget.Workspace);
  // What the one-time "Use Stacked View" prompt sets (so it doesn't block the test).
  const diffCfg = vscode.workspace.getConfiguration('diffEditor');
  await diffCfg.update('renderSideBySide', false, vscode.ConfigurationTarget.Global);
  await diffCfg.update('codeLens', true, vscode.ConfigurationTarget.Global);
  if (diffCfg.inspect('hideOriginalLineNumbers')?.defaultValue !== undefined) {
    await diffCfg.update('hideOriginalLineNumbers', true, vscode.ConfigurationTarget.Global);
  }

  const fileA = vscode.Uri.file(path.join(root, 'src/a.txt'));
  const fileCrlf = vscode.Uri.file(path.join(root, 'crlf.txt'));
  const fileNew = vscode.Uri.file(path.join(root, 'src/new.ts'));

  try {
    await step('install hook merges settings.json and .gitignore', async () => {
      await vscode.commands.executeCommand('claudeChanges.installHook');
      const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'));
      assert.deepStrictEqual(settings.permissions, { allow: ['Bash(ls)'] }, 'existing settings preserved');
      assert.strictEqual(settings.hooks.PreToolUse.length, 2, 'existing hook preserved + ours');
      assert.ok(fs.existsSync(path.join(root, '.claude/hooks/claude-changes-snapshot.js')));
      assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\.claude\/review\/$/m);
      // Installing twice doesn't duplicate.
      await vscode.commands.executeCommand('claudeChanges.installHook');
      const again = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'));
      assert.strictEqual(again.hooks.PreToolUse.length, 2);
    });

    await step('Claude edits an existing file twice and creates a new one → 3 tracked files', async () => {
      claudeWrites(root, 'src/a.txt', 'one\nTWO\nthree\nfour\nFIVE\nsix\n');
      claudeWrites(root, 'src/a.txt', 'one\nTWO\nthree\nfour\nFIVE\nsix\nseven\n'); // second edit, same original
      claudeWrites(root, 'crlf.txt', 'alpha\r\nBETA\r\ngamma\r\n');
      claudeWrites(root, 'src/new.ts', 'export const x = 1;\n', 'Write');
      const files = await waitFor('3 changed files', async () => {
        const f = await service.changedFiles();
        return f.length === 3 ? f : undefined;
      });
      const a = files.find((f) => f.file.relPath === 'src/a.txt');
      assert.strictEqual(a.hunks.length, 3);
      assert.deepStrictEqual(a.stats, { added: 3, removed: 2 });
      const crlf = files.find((f) => f.file.relPath === 'crlf.txt');
      assert.strictEqual(crlf.hunks.length, 1, 'CRLF file only shows the real change');
      const n = files.find((f) => f.file.relPath === 'src/new.ts');
      assert.strictEqual(n.status, 'new');
    });

    await step('open in decorations mode shows file-bar and per-hunk CodeLenses', async () => {
      await vscode.commands.executeCommand('claudeChanges.openDiff', fileA);
      const editor = vscode.window.activeTextEditor;
      assert.ok(editor && editor.document.uri.fsPath === fileA.fsPath);
      const lenses = await waitFor('code lenses', async () => {
        const l = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', fileA);
        return l && l.length ? l : undefined;
      });
      const titles = lenses.map((l) => l.command && l.command.title);
      assert.ok(titles.includes('$(check) Keep File'));
      assert.ok(titles.includes('$(discard) Undo File'));
      assert.ok(titles.some((t) => /^\d of 3 Files$/.test(t)), `titles: ${titles}`);
      assert.ok(titles.includes('‹') && titles.includes('›'));
      assert.strictEqual(titles.filter((t) => /^\$\(check\) Keep (Ctrl\+Alt|⌥⌘)\+?Y$/.test(t)).length, 3, `titles: ${titles}`);
      assert.deepStrictEqual(titles.filter((t) => / of 3$/.test(t)), ['1 of 3', '2 of 3', '3 of 3']);
      assert.strictEqual(titles.filter((t) => /^▾ 1 removed$/.test(t)).length, 2);
    });

    await step('undo a hunk via WorkspaceEdit, and Ctrl+Z brings it back', async () => {
      const doc = await vscode.workspace.openTextDocument(fileA);
      const st = await service.state(fileA);
      const first = st.hunks[0];
      const fp = `${first.curStart}:${first.curLines.length}:${first.baseStart}:${first.baseLines.length}`;
      await vscode.commands.executeCommand('claudeChanges.undoHunk', fileA.toString(), fp);
      assert.strictEqual(doc.getText(), 'one\ntwo\nthree\nfour\nFIVE\nsix\nseven\n');
      await waitFor('2 hunks after undo', async () => (await service.state(fileA)).hunks.length === 2);

      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('undo');
      assert.strictEqual(doc.getText(), 'one\nTWO\nthree\nfour\nFIVE\nsix\nseven\n');
      await waitFor('3 hunks after Ctrl+Z', async () => (await service.state(fileA)).hunks.length === 3);
    });

    await step('keep a hunk updates the baseline', async () => {
      const st = await service.state(fileA);
      const last = st.hunks[2];
      const fp = `${last.curStart}:${last.curLines.length}:${last.baseStart}:${last.baseLines.length}`;
      await vscode.commands.executeCommand('claudeChanges.keepHunk', fileA.toString(), fp);
      const after = await waitFor('2 hunks after keep', async () => {
        const s = await service.state(fileA);
        return s.hunks.length === 2 ? s : undefined;
      });
      assert.ok(after.baseline.endsWith('seven\n'), 'kept line is now part of the baseline');
    });

    await step('next/previous hunk navigation', async () => {
      const editor = await vscode.window.showTextDocument(fileA);
      editor.selection = new vscode.Selection(0, 0, 0, 0);
      await vscode.commands.executeCommand('claudeChanges.nextHunk');
      assert.strictEqual(editor.selection.active.line, 1);
      await vscode.commands.executeCommand('claudeChanges.nextHunk');
      assert.strictEqual(editor.selection.active.line, 4);
      await vscode.commands.executeCommand('claudeChanges.nextHunk');
      assert.strictEqual(editor.selection.active.line, 1, 'wraps around');
      await vscode.commands.executeCommand('claudeChanges.prevHunk');
      assert.strictEqual(editor.selection.active.line, 4);
    });

    await step('next/previous file navigation', async () => {
      await vscode.window.showTextDocument(fileA);
      await vscode.commands.executeCommand('claudeChanges.nextFile');
      const next = vscode.window.activeTextEditor.document.uri.fsPath;
      assert.strictEqual(path.relative(root, next), path.join('src', 'new.ts'));
      await vscode.commands.executeCommand('claudeChanges.prevFile');
      assert.strictEqual(vscode.window.activeTextEditor.document.uri.fsPath, fileA.fsPath);
    });

    await step('stacked view: opens an inline diff against claude-original: with review CodeLenses', async () => {
      await cfg.update('viewMode', 'inlineDiff', vscode.ConfigurationTarget.Workspace);
      fs.writeFileSync(path.join(root, 'src/stacked.txt'), 'a\nb\nc\nd\ne\nf\n');
      claudeWrites(root, 'src/stacked.txt', 'A\nb\nc\nD\ne\nF\n');
      const fileS = vscode.Uri.file(path.join(root, 'src/stacked.txt'));
      await waitFor('stacked tracked', async () => (await service.state(fileS))?.hunks.length === 3);
      await vscode.commands.executeCommand('claudeChanges.openDiff', fileS);
      const tab = await waitFor('diff tab', async () => {
        const t = vscode.window.tabGroups.activeTabGroup.activeTab;
        return t && t.input instanceof vscode.TabInputTextDiff ? t : undefined;
      });
      assert.strictEqual(tab.input.original.scheme, 'claude-original');
      assert.strictEqual(tab.input.modified.fsPath, fileS.fsPath);
      const orig = await vscode.workspace.openTextDocument(tab.input.original);
      assert.strictEqual(orig.getText(), 'a\nb\nc\nd\ne\nf\n');
      const editor = vscode.window.activeTextEditor;
      assert.strictEqual(editor.document.uri.fsPath, fileS.fsPath, 'modified side is the real, editable file');
      assert.strictEqual(editor.selection.active.line, 0, 'lands on the first change');
      const titles = (await vscode.commands.executeCommand('vscode.executeCodeLensProvider', fileS)).map((l) => l.command.title);
      assert.ok(titles.includes('$(check) Keep File') && titles.some((t) => / of 4 Files$/.test(t)), `titles: ${titles}`);
      assert.ok(!titles.some((t) => /removed$/.test(t)), 'no peek lens in the stacked view (removed lines are visible)');
    });

    await step('stacked view: hover over a block shows "n of N" with Undo / Keep', async () => {
      const fileS = vscode.Uri.file(path.join(root, 'src/stacked.txt'));
      const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', fileS, new vscode.Position(3, 0));
      const text = hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
      assert.match(text, /\*\*2 of 3\*\*/);
      assert.match(text, /claudeChanges\.undoHunk/);
      assert.match(text, /claudeChanges\.keepHunk/);
      const none = await vscode.commands.executeCommand('vscode.executeHoverProvider', fileS, new vscode.Position(1, 0));
      assert.ok(!none.some((h) => h.contents.some((c) => /of 3\*\*/.test(typeof c === 'string' ? c : c.value))), 'no hover on unchanged lines');
    });

    await step('stacked view: keybinding commands act on the change at the cursor', async () => {
      const fileS = vscode.Uri.file(path.join(root, 'src/stacked.txt'));
      const editor = vscode.window.activeTextEditor;
      editor.selection = new vscode.Selection(3, 0, 3, 0); // on "D"
      await vscode.commands.executeCommand('claudeChanges.undoHunk');
      assert.strictEqual(editor.document.getText(), 'A\nb\nc\nd\ne\nF\n');
      editor.selection = new vscode.Selection(0, 0, 0, 0); // on "A"
      await vscode.commands.executeCommand('claudeChanges.keepHunk');
      const st = await waitFor('1 hunk left', async () => {
        const s = await service.state(fileS);
        return s.hunks.length === 1 ? s : undefined;
      });
      assert.deepStrictEqual(st.hunks[0].curLines, ['F']);
      await waitFor('original side updated', async () => {
        const o = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'claude-original' && d.uri.path === fileS.path);
        return o && o.getText().startsWith('A\n');
      });
    });

    await step('stacked view: Keep File turns the review tab back into a normal editor', async () => {
      const fileS = vscode.Uri.file(path.join(root, 'src/stacked.txt'));
      await vscode.commands.executeCommand('claudeChanges.keepFile', fileS);
      await waitFor('plain editor', async () => {
        const t = vscode.window.tabGroups.activeTabGroup.activeTab;
        return t && t.input instanceof vscode.TabInputText && t.input.uri.fsPath === fileS.fsPath;
      });
      assert.ok(
        !vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputTextDiff)),
        'no review diff tab left',
      );
      await vscode.workspace.saveAll();
      await cfg.update('viewMode', 'decorations', vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    await step('stacked view: the old "inlineDiffEditor" setting value still means the stacked view', async () => {
      await cfg.update('viewMode', 'inlineDiffEditor', vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('claudeChanges.openDiff', fileCrlf);
      const tab = await waitFor('diff tab', async () => {
        const t = vscode.window.tabGroups.activeTabGroup.activeTab;
        return t && t.input instanceof vscode.TabInputTextDiff ? t : undefined;
      });
      const orig = await vscode.workspace.openTextDocument(tab.input.original);
      assert.strictEqual(orig.getText().replace(/\r\n/g, '\n'), 'alpha\nbeta\ngamma\n');
      await cfg.update('viewMode', 'decorations', vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    await step('undo a new file deletes it', async () => {
      await vscode.commands.executeCommand('claudeChanges.undoFile', fileNew);
      assert.ok(!fs.existsSync(fileNew.fsPath));
      assert.ok(!service.tracked(fileNew));
    });

    await step('keep file removes it; Claude editing it again takes a fresh snapshot', async () => {
      await vscode.commands.executeCommand('claudeChanges.keepFile', fileCrlf);
      await waitFor('crlf untracked', async () => !service.tracked(fileCrlf));
      claudeWrites(root, 'crlf.txt', 'alpha\r\nBETA\r\ngamma\r\ndelta\r\n');
      const st = await waitFor('crlf tracked again', async () => {
        const s = await service.state(fileCrlf);
        return s && s.hunks.length === 1 ? s : undefined;
      });
      assert.deepStrictEqual(st.hunks[0].curLines, ['delta'], 'baseline is the kept state');
    });

    await step('undo file restores the exact original bytes (open editor reflects it)', async () => {
      const doc = await vscode.workspace.openTextDocument(fileA);
      await vscode.commands.executeCommand('claudeChanges.undoFile', fileA);
      assert.strictEqual(fs.readFileSync(fileA.fsPath, 'utf8'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n');
      await waitFor('editor shows original', async () => doc.getText() === 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n');
    });

    await step('undo all restores everything; keep all clears the manifest', async () => {
      claudeWrites(root, 'src/a.txt', 'changed\n');
      claudeWrites(root, 'src/other.txt', 'brand new\n', 'Write');
      await waitFor('3 changed files', async () => (await service.changedFiles()).length === 3);
      const failed = await service.undoAll();
      assert.deepStrictEqual(failed, []);
      assert.strictEqual(fs.readFileSync(fileA.fsPath, 'utf8'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n');
      assert.strictEqual(fs.readFileSync(fileCrlf.fsPath, 'utf8'), 'alpha\r\nBETA\r\ngamma\r\n', 'CRLF bytes restored');
      assert.ok(!fs.existsSync(path.join(root, 'src/other.txt')));

      claudeWrites(root, 'src/a.txt', 'kept\n');
      await waitFor('1 changed file', async () => (await service.changedFiles()).length === 1);
      await vscode.commands.executeCommand('claudeChanges.keepAll');
      const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude/review/manifest.json'), 'utf8'));
      assert.deepStrictEqual(manifest.files, []);
      assert.deepStrictEqual(fs.readdirSync(path.join(root, '.claude/review/originals')), []);
    });

    await step('binary files are tracked without a diff', async () => {
      fs.writeFileSync(path.join(root, 'img.bin'), Buffer.from([0, 1, 2, 3]));
      claudeWrites(root, 'img.bin', Buffer.from([0, 9, 9, 9]));
      const st = await waitFor('binary tracked', async () => {
        const s = await service.state(vscode.Uri.file(path.join(root, 'img.bin')));
        return s && s.hasChanges ? s : undefined;
      });
      assert.strictEqual(st.kind, 'binary');
      await service.undoFile(vscode.Uri.file(path.join(root, 'img.bin')));
      assert.deepStrictEqual([...fs.readFileSync(path.join(root, 'img.bin'))], [0, 1, 2, 3]);
    });

    await step('changes made through Bash are tracked (modify, create, delete)', async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      claudeRunsBash(root, () => {
        assert.strictEqual(fs.readFileSync(fileA.fsPath, 'utf8'), 'kept\n');
        fs.writeFileSync(fileA.fsPath, 'KEPT (sed)\nappended\n');
        fs.writeFileSync(path.join(root, 'generated.txt'), 'made by a script\n');
        fs.rmSync(fileCrlf.fsPath);
      });
      const files = await waitFor('3 bash changes', async () => {
        const f = await service.changedFiles();
        return f.length === 3 ? f : undefined;
      });
      const byRel = Object.fromEntries(files.map((f) => [f.file.relPath, f]));
      assert.deepStrictEqual(byRel['src/a.txt'].hunks.map((h) => [h.baseLines, h.curLines]), [[['kept'], ['KEPT (sed)', 'appended']]]);
      assert.strictEqual(byRel['generated.txt'].status, 'new');
      assert.strictEqual(byRel['crlf.txt'].status, 'deleted');
      const failed = await service.undoAll();
      assert.deepStrictEqual(failed, []);
      assert.strictEqual(fs.readFileSync(fileCrlf.fsPath, 'utf8'), 'alpha\r\nBETA\r\ngamma\r\n', 'deleted file restored');
      assert.ok(!fs.existsSync(path.join(root, 'generated.txt')));
    });

    await step('uninstall removes only our hook', async () => {
      const done = vscode.commands.executeCommand('claudeChanges.uninstallHook');
      // The "delete review data?" prompt is non-modal; don't wait for it.
      await Promise.race([done, sleep(1500)]);
      const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'));
      assert.strictEqual(settings.hooks.PreToolUse.length, 1);
      assert.strictEqual(settings.hooks.PreToolUse[0].matcher, 'Bash');
      assert.strictEqual(settings.hooks.PostToolUse, undefined);
      assert.strictEqual(settings.hooks.Stop, undefined);
      assert.ok(!fs.existsSync(path.join(root, '.claude/hooks/claude-changes-snapshot.js')));
      assert.doesNotMatch(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /claude\/review/);
    });
  } finally {
    const report = results.join('\n');
    console.log('\nClaude Changes integration test\n' + report + '\n');
    if (process.env.RESULT_FILE) fs.writeFileSync(process.env.RESULT_FILE, report + '\n');
  }
}

module.exports = { run };
