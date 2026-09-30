# Changelog

## 0.2.0
- Track changes Claude makes through **Bash / PowerShell** commands (sed, python scripts, generators, rm, …),
  via an incremental workspace cache refreshed before each command and compared after it.
- Hook entry uses shell form (exec-form `args` is ignored by older Claude Code releases).
- Install now adds PreToolUse, PostToolUse and Stop entries; re-running Install migrates older entries.

## 0.1.0
- Initial release: PreToolUse snapshot hook, review panel, inline decorations and inline diff editor modes,
  per-hunk / per-file / all Keep & Undo, file and hunk navigation.
