# Claude Changes

A Cursor-style review panel for **Claude Code**. When Claude edits or creates files (including in
auto-accept mode), every touched file shows up in a sidebar. It opens with an **inline, single-pane
red/green diff** against the original, and you can **Keep** or **Undo** changes per hunk, per file,
or all at once.

## Install

```bash
npm install
npm run package                                   # → claude-changes-0.1.0.vsix
code --install-extension claude-changes-0.1.0.vsix
```

Then, in each project where you use Claude Code:

1. Open the folder in VS Code.
2. Run **Claude Changes: Install Hook in Workspace** from the Command Palette. On first activation
   the extension also offers this once.
3. Restart any Claude Code session that is already running in that folder (or open `/hooks`) so it
   loads the new hook.

**Requirement:** the hook runs with `node`, so Node.js must be on the `PATH` that Claude Code uses.

## How it works

```
Claude Code ── PreToolUse  Edit|Write|MultiEdit|NotebookEdit ──┐
            ── PreToolUse / PostToolUse  Bash|PowerShell ──────┼─▶ .claude/hooks/claude-changes-snapshot.js
            ── Stop ───────────────────────────────────────────┘        │  first time a file changes:
                                                                        ▼
                                               .claude/review/manifest.json   (tracked files)
                                               .claude/review/originals/<sha1> (original contents)
                                                                        │  FileSystemWatcher
                                                                        ▼
                                            VS Code extension: panel · inline diff · Keep / Undo
```

**The hook** (`hook/snapshot.js`) is plain Node.js with no dependencies. It records the original of
each file the first time Claude changes it. Later changes to the same file are ignored, so the
snapshot stays the true original until you Keep or Undo.

- **Edit / Write / MultiEdit / NotebookEdit.** Before the edit, the hook copies the file into
  `originals/`. A file that doesn't exist yet is recorded as *new*.
- **Bash / PowerShell** (`sed -i`, `python` scripts, code generators, `rm`, …). A shell command can
  touch any file, so the hook keeps an incremental cache of the workspace in
  `.claude/review/cache/`:
  - **Before each command,** it refreshes the cache. Only files whose size, mtime or inode changed
    are re-read, and identical contents are stored once.
  - **After the command,** it compares the workspace against the cache. Every file that was
    modified, created or deleted gets an entry, with its pre-command content as the original.
  - **If `PostToolUse` never arrives** (for example, the command failed), the next command or the
    end of the turn (`Stop`) does the comparison instead.
  - **Edits you make between Claude's commands** are not attributed to Claude.
  - **Which files are scanned:** in a git work tree, the tracked and untracked files that aren't
    git-ignored. Otherwise a directory walk that skips `node_modules`, `.git`, `.venv`, `target` and
    similar folders.
  - **Cost:** about 100 ms per command on a 10,000-file workspace once the cache is warm. The first
    command pays about 1 s to fill the cache.
- **Concurrency.** The manifest is written atomically (temp file + rename) while holding a lock
  file, because Claude Code runs matching hooks in parallel and a rename alone would lose
  concurrent updates.
- **Never blocks Claude.** The hook always exits 0 and never writes to stdout. Errors and warnings
  go to `.claude/review/hook.log`; set `CLAUDE_CHANGES_DEBUG=1` to log every call.
- **Ignored:** files outside the workspace and anything under `.claude/review/`.

**The install command**:

- copies the hook to `.claude/hooks/claude-changes-snapshot.js`;
- *merges* these entries into `.claude/settings.json`, leaving your other settings and hooks alone
  and never adding a duplicate:

  ```json
  { "hooks": {
      "PreToolUse":  [ { "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell", "hooks": [ H ] } ],
      "PostToolUse": [ { "matcher": "Bash|PowerShell", "hooks": [ H ] } ],
      "Stop":        [ { "hooks": [ H ] } ] } }

  H = { "type": "command",
        "command": "node \"${CLAUDE_PROJECT_DIR}/.claude/hooks/claude-changes-snapshot.js\"",
        "timeout": 30 }
  ```

  This uses shell form on purpose. The newer exec form (`command` + `args`) is silently ignored by
  older Claude Code releases; 2.1.76 was tested. In shell form, newer releases substitute
  `${CLAUDE_PROJECT_DIR}` themselves, and older ones leave it to the shell, which expands the
  environment variable of the same name. The quotes keep paths with spaces working. This setup was
  verified end-to-end with Claude Code 2.1.76 and 2.1.285. Re-running the install command replaces
  older entries of ours; the extension offers this when it finds one.
- adds `.claude/review/` to `.gitignore` if the project has one.

If `settings.json` isn't valid JSON, the install stops and changes nothing.
**Uninstall Hook** reverses all of this and offers to delete the pending review data.

## Reviewing

The review UI follows Cursor and VS Code's chat editing as closely as VS Code's public extension API
allows.

- **Files panel.** Click the Claude Changes icon in the Activity Bar.
  - **Header:** `▾ 19 Files` with **Undo All**, **Keep All** and **Review** buttons.
  - **Rows:** one per changed file, with your icon theme's file icon and a green `+added` / red
    `-removed` count. Deleted files are struck through.
  - **Actions:** click a row to review the file. Hover a row for Open File / Undo File / Keep
    File, or right-click it.
  - **Badge:** the Activity Bar icon shows the pending count after the panel has been shown once;
    the status bar item `Claude: N files changed` always shows it.
- **Stacked review** (the default view):
  - **Layout:** the file opens in VS Code's inline diff editor. Each removed line is a red row
    stacked above the green lines that replaced it, in one editor with one column of line numbers.
  - **Editing:** the right side is the real file, so you can keep editing it while reviewing.
- **File bar.** The first line shows `‹ 2 of 19 Files › · Undo File · Keep File · +60 −40`. The
  editor title bar has the same ‹ › Undo File / Keep File buttons. The status bar shows
  `File 2/19 · Change 4/17` for the cursor position.
- **Per-change bar.** Every change gets a row `⌃ ⌄ 4 of 17 · Undo Ctrl+Alt+N · Keep Ctrl+Alt+Y`.
  Hovering the changed lines shows the same controls.
  - **Undo** restores the original lines through a normal edit, so **Ctrl+Z** brings Claude's
    version back.
  - **Keep** moves the change into the file's baseline, so it stops showing as a change.
- **When a file is done** (every change kept or undone, or Keep File / Undo File), its review tab
  turns back into a normal editor at the same position.
- **File actions.**
  - **Undo File** writes the exact original bytes back, or deletes the file if Claude created it.
  - **Keep File** accepts everything. If Claude edits the file again later, it gets a fresh
    snapshot of the kept state.
- **Your own edits** to a file under review are picked up live, including unsaved ones.

## View modes

Set `claudeChanges.viewMode`.

### `inlineDiff` (default): stacked, like Cursor

VS Code's diff editor, compared against a read-only `claude-original:` document. New files compare
against an empty document, and deleted files against an empty "(deleted)" stand-in.

**One-time settings prompt.** VS Code has no API to make a single diff editor inline: the inline
view, and CodeLens inside diff editors, are global settings. The first time you open a review, the
extension asks once whether to set these in your **User settings**:

| Setting | Value | Why |
| --- | --- | --- |
| `diffEditor.renderSideBySide` | `false` | stacked red/green rows instead of two panes |
| `diffEditor.codeLens` | `true` | the `Keep / Undo` rows inside the diff editor |
| `diffEditor.hideOriginalLineNumbers` | `true` | one line-number column (newer VS Code only) |

Git and other diff editors then use the same view. If you choose **Keep Current View**, reviews
open side by side, and the hover still gives you Undo / Keep. Run **Claude Changes: Use Stacked
(Inline) Review View** to be asked again.

### `decorations`

Opens the plain file with no diff editor.

- **Added or changed lines** get a green background and a **+** gutter icon.
- **Removed lines** get a red marker line, red strikethrough ghost text, and a `▾ N removed`
  CodeLens that shows them in a peek.
- **Toolbar:** the same file bar, per-change bar and hover as the stacked view.

## Commands and keys

| Command | Default key (macOS) |
| --- | --- |
| Keep / Undo change at cursor | `Ctrl+Alt+Y` / `Ctrl+Alt+N` (`⌥⌘Y` / `⌥⌘N`) |
| Keep / Undo file | `Ctrl+Shift+Alt+Y` / `Ctrl+Shift+Alt+N` |
| Next / Previous change | `Alt+F5` / `Shift+Alt+F5` |
| Next / Previous file | `Alt+F6` / `Shift+Alt+F6` |
| Review Changes · Keep All · Undo All · Refresh · Focus Panel | |
| Install Hook in Workspace · Uninstall Hook · Use Stacked (Inline) Review View | |

The change and file keys only apply while a file with pending changes is focused, so Redo
(`Ctrl+Y`) and New File (`Ctrl+N`) are never taken over. Rebind any of them in *Keyboard
Shortcuts* (search for "Claude Changes").

## Settings

| Setting | Default | |
| --- | --- | --- |
| `claudeChanges.viewMode` | `"inlineDiff"` | `"inlineDiff"` (stacked) or `"decorations"` |
| `claudeChanges.showDecorationsAutomatically` | `true` | Show review controls in any tracked file you open, not only ones opened from the panel |
| `claudeChanges.confirmUndo` | `true` | Confirm before undoing a whole file (Undo All always confirms) |
| `claudeChanges.autoOpenPanel` | `false` | Show the panel when new changes appear, without stealing focus |

## What can't be identical to Cursor

These are limits of VS Code's public extension API, not choices:

- **No floating widgets inside an editor.** Cursor's floating `4 of 17 · Undo · Keep` box is a
  CodeLens row plus a hover here.
- **Fixed title-bar text.** Editor title-bar buttons can't show changing text such as
  "2 of 19 Files", so that count is in the file bar and the status bar.
- **Removed rows have no hover.** Only the inline diff editor can stack removed lines, so Keep /
  Undo is on the change's first added line, or on the line where lines were removed.
- **Panel badge.** It appears once the panel has been opened at least once.

## Limitations

- **What is captured.** Edit / Write / MultiEdit / NotebookEdit and Bash / PowerShell commands.
  Not captured:
  - files changed by **MCP tools**;
  - files outside the workspace folder;
  - for shell commands, git-ignored files (in a git repo) and files over 5 MB;
  - changes a **background** command (`run_in_background`, dev servers, watchers) makes after its
    tool call has returned.
- **Rejected edits.** `PreToolUse` runs before the permission prompt, so a rejected edit can leave
  an entry with no changes. Such entries are hidden. **Refresh** prunes them once they're older than
  10 minutes; they aren't pruned sooner so they can't race an edit that is still waiting for
  approval.
- **Binary files and files over 5 MB** are tracked and can be kept or undone as a whole, but show no
  diff.
- Hunk-level actions assume UTF-8 text. File-level Undo always restores the exact original bytes
  (encoding, BOM, line endings).
- **Line endings.** CRLF vs LF differences are ignored when diffing, so a CRLF file never shows
  every line as changed.
- **Multi-root workspaces.** Each folder has its own hook, its own `.claude/review/`, and its own
  section in the panel. The hook only tracks files inside the folder Claude Code was started in.
- **Worktrees.** Files Claude edits inside a separate git worktree are outside the workspace and
  aren't tracked.

## Development

```bash
npm run build              # esbuild → dist/extension.js
npm run typecheck          # tsc --noEmit (strict)
npm test                   # vitest: hook logic, settings merge, hunks/undo
npm run test:integration   # runs test/integration/suite.js inside a real VS Code
                           # (isolated profile; needs a display, e.g. xvfb-run on CI)
npm run package            # → .vsix
```

Layout:

- `hook/snapshot.js`: the hook script. It also exports the manifest, lock and path helpers that the
  extension bundles.
- `src/core/`: pure logic with no `vscode` dependency (hunks, settings merge).
- `src/review/`: manifest state per workspace folder, diff cache, Keep/Undo, and the
  `claude-original:` provider.
- `src/ui/`: tree, badges, decorations, CodeLens, diff editor, navigation.
- `src/install/`: install/uninstall.
