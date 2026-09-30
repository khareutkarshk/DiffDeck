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
Claude Code ──PreToolUse(Edit|Write|MultiEdit|NotebookEdit)──▶ .claude/hooks/claude-changes-snapshot.js
                                                                   │  first time a file is touched:
                                                                   ▼
                                               .claude/review/manifest.json   (tracked files)
                                               .claude/review/originals/<sha1> (original contents)
                                                                   │  FileSystemWatcher
                                                                   ▼
                                            VS Code extension: panel · inline diff · Keep / Undo
```

**The hook** (`hook/snapshot.js`) is plain Node.js with no dependencies. Before Claude's first edit
to a file, it copies the file into `originals/`. A file that doesn't exist yet is recorded as *new*.
Later edits to the same file are ignored, so the snapshot stays the true original until you Keep or
Undo.

- The manifest is written atomically (temp file + rename) while holding a lock file, because Claude
  Code runs matching hooks in parallel and a rename alone would lose concurrent updates.
- The hook always exits 0 and never writes to stdout, so it can't block Claude. Errors go to
  `.claude/review/hook.log`; set `CLAUDE_CHANGES_DEBUG=1` to log every call.
- Files outside the workspace and anything under `.claude/review/` are ignored.

**The install command**:

- copies the hook to `.claude/hooks/claude-changes-snapshot.js`;
- *merges* this entry into `.claude/settings.json`, leaving your other settings and hooks alone and
  never adding a duplicate:

  ```json
  { "hooks": { "PreToolUse": [ { "matcher": "Edit|Write|MultiEdit|NotebookEdit",
      "hooks": [ { "type": "command",
                   "command": "node \"${CLAUDE_PROJECT_DIR}/.claude/hooks/claude-changes-snapshot.js\"",
                   "timeout": 10 } ] } ] } }
  ```

  This uses shell form on purpose. The newer exec form (`command` + `args`) is silently ignored by
  older Claude Code releases; 2.1.76 was tested. In shell form, newer releases substitute
  `${CLAUDE_PROJECT_DIR}` themselves, and older ones leave it to the shell, which expands the
  environment variable of the same name. The quotes keep paths with spaces working. This entry was
  verified end-to-end with Claude Code 2.1.76 and 2.1.285. Re-running the install command updates
  an older entry of ours in place.
- adds `.claude/review/` to `.gitignore` if the project has one.

If `settings.json` isn't valid JSON, the install stops and changes nothing.
**Uninstall Hook** reverses all of this and offers to delete the pending review data.

## Reviewing

- **Panel.** The Claude Changes icon in the Activity Bar lists every pending file with its relative
  path, a `+added −removed` count, and a **U** (new), **M** (modified) or **D** (deleted) badge.
  Hover a file for Keep / Undo / Open Diff; the context menu adds Open File. The title bar has
  **Keep All**, **Undo All** (always asks first) and **Refresh**. The icon's badge and the status
  bar item (`Claude: N files changed`) show the pending count.
- **In the file** (decorations mode), CodeLenses stand in for Cursor's floating review bar:
  - `Keep File | Undo File | ◀ Prev | Next ▶ (2/5 files)` on the first line;
  - `Keep | Undo | ▾ Show N removed` above each hunk.
- **Hunk actions.**
  - **Undo** restores the original lines in place through a `WorkspaceEdit`, so **Ctrl+Z** brings
    Claude's version back.
  - **Keep** moves the hunk into the file's baseline, so it stops showing as a change.
  - Once every hunk has been kept, the file leaves the list. Once every hunk has been undone, it
    leaves the list immediately and is removed from the manifest when you close the editor, so
    Ctrl+Z still works until then.
- **File actions.**
  - **Undo** writes the exact original bytes back, or deletes the file if Claude created it. Open
    editors update to match.
  - **Keep** accepts everything and drops the snapshot. If Claude edits the file again later, it
    gets a fresh snapshot of the kept state.
- **Your own edits** to a file under review are picked up live, including unsaved ones: hunks,
  counts and decorations recompute as you type.

## View modes

Set `claudeChanges.viewMode`.

### `decorations` (default, closest to Cursor)

Opens the real file in a normal, editable editor.

- **Added or changed lines** get a green whole-line background (`diffEditor.insertedLineBackground`)
  and a green **+** gutter icon.
- **Removed lines.** VS Code's API can't insert real virtual lines, so they're shown with:
  - a red marker line where lines were removed, plus a red **−** gutter icon for pure deletions;
  - red strikethrough ghost text at the end of that line, showing the first removed line and a count;
  - a hover with the full removed block as a `diff` code block, with Keep / Undo links;
  - **`▾ Show N removed`**, which opens the removed lines *inline* in a peek widget. That is the
    only public API that actually opens vertical space inside the file.
- All colors follow the theme. You can override them under `workbench.colorCustomizations`:
  `claudeChanges.addedLineBackground`, `claudeChanges.removedLineBackground`,
  `claudeChanges.removedGhostText`, `claudeChanges.removedMarker`.

### `inlineDiffEditor`

Opens VS Code's built-in diff editor against a read-only `claude-original:` document. New files diff
against an empty document, and deleted files against an empty "(deleted)" stand-in.

**Trade-off:** VS Code has no API to force inline (unified) mode for a single diff. The only switch
is the `diffEditor.renderSideBySide` setting. So, if you use side-by-side, the first time you open a
diff from here the extension asks once whether to set `"diffEditor.renderSideBySide": false` **for
this workspace only** (`.vscode/settings.json`).

- It never changes your User settings.
- If you accept, Git diffs in that workspace become inline too. To undo it, delete that line from
  `.vscode/settings.json`.

Hunk CodeLenses work in the diff editor's editable side as well.

## Commands

| Command | Default key |
| --- | --- |
| Claude Changes: Install Hook in Workspace / Uninstall Hook | |
| Claude Changes: Next File / Previous File (opens in the current view mode) | `Alt+F6` / `Shift+Alt+F6` |
| Claude Changes: Next Hunk / Previous Hunk | `Alt+F5` / `Shift+Alt+F5` |
| Claude Changes: Keep File / Undo File / Open File / Open Diff | |
| Claude Changes: Keep All / Undo All / Refresh / Focus Panel | |

You can rebind any of them in *Keyboard Shortcuts* (search for "Claude Changes").

## Settings

| Setting | Default | |
| --- | --- | --- |
| `claudeChanges.viewMode` | `"decorations"` | `"decorations"` or `"inlineDiffEditor"` |
| `claudeChanges.showDecorationsAutomatically` | `true` | Decorate any tracked file you open, not only ones opened from the panel |
| `claudeChanges.confirmUndo` | `true` | Confirm before undoing a whole file (Undo All always confirms) |
| `claudeChanges.autoOpenPanel` | `false` | Reveal the panel when new changes appear, without stealing focus |

## Limitations

- **Only Edit / Write / MultiEdit / NotebookEdit are captured.** Changes Claude makes through
  **Bash** (`sed -i`, `mv`, code generators, `git checkout`, …), PowerShell, or MCP tools don't go
  through these tools, so they aren't snapshotted. Neither are files changed outside the workspace
  folder.
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
