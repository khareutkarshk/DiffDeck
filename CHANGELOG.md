# Changelog

## 0.3.0
- **Stacked review** (new default `viewMode: "inlineDiff"`): removed lines in red stacked above added
  lines in green inside VS Code's inline diff editor, editable, one line-number column.
- File bar `‹ 2 of 19 Files › · Undo File · Keep File`, per-change bar `⌃ ⌄ 4 of 17 · Undo · Keep`,
  hover with the same controls, editor title buttons and a status bar position item.
- Keybindings: Keep / Undo change at cursor (`Ctrl+Alt+Y` / `Ctrl+Alt+N`) and file
  (`Ctrl+Shift+Alt+Y` / `Ctrl+Shift+Alt+N`).
- New files panel (webview): `N Files · Undo All · Keep All · Review`, icon-theme file icons, green/red counts.
- Review tabs turn back into normal editors when a file is finished.
- Hunks are placed like VS Code's diff editor places them, so controls line up with the red/green rows.

## 0.2.0
- Track changes Claude makes through **Bash / PowerShell** commands (sed, python scripts, generators, rm, …),
  via an incremental workspace cache refreshed before each command and compared after it.
- Hook entry uses shell form (exec-form `args` is ignored by older Claude Code releases).
- Install now adds PreToolUse, PostToolUse and Stop entries; re-running Install migrates older entries.

## 0.1.0
- Initial release: PreToolUse snapshot hook, review panel, inline decorations and inline diff editor modes,
  per-hunk / per-file / all Keep & Undo, file and hunk navigation.
