import * as vscode from 'vscode';
import type { Hunk } from '../core/hunks';
import { pathKey } from '../core/manifest';

export type ViewMode = 'inlineDiff' | 'decorations';

export function config() {
  const c = vscode.workspace.getConfiguration('claudeChanges');
  const mode = c.get<string>('viewMode', 'inlineDiff');
  return {
    // "inlineDiffEditor" is the 0.1/0.2 name of the inline diff mode.
    viewMode: (mode === 'decorations' ? 'decorations' : 'inlineDiff') as ViewMode,
    showDecorationsAutomatically: c.get<boolean>('showDecorationsAutomatically', true),
    confirmUndo: c.get<boolean>('confirmUndo', true),
    autoOpenPanel: c.get<boolean>('autoOpenPanel', false),
  };
}

export function sameFile(a: vscode.Uri | undefined, b: vscode.Uri | undefined): boolean {
  return !!a && !!b && a.scheme === 'file' && b.scheme === 'file' && pathKey(a.fsPath) === pathKey(b.fsPath);
}

/** The file the user is looking at: active text editor, or the modified side of an active diff tab. */
export function activeFileUri(): vscode.Uri | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (tab?.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === 'file') return tab.input.modified;
  const ed = vscode.window.activeTextEditor;
  if (ed?.document.uri.scheme === 'file') return ed.document.uri;
  if (tab?.input instanceof vscode.TabInputText && tab.input.uri.scheme === 'file') return tab.input.uri;
  return undefined;
}

/** Command arguments arrive as a Uri (CodeLens), a tree node ({ uri }), a string, or nothing (palette). */
export function resolveUri(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  if (typeof arg === 'string') return vscode.Uri.parse(arg);
  // Webview context menus pass the row's data-vscode-context object, with `uri` as a string.
  if (arg && typeof arg === 'object' && typeof (arg as { uri?: unknown }).uri === 'string') {
    return vscode.Uri.parse((arg as { uri: string }).uri);
  }
  if (arg && typeof arg === 'object' && 'uri' in arg && (arg as { uri: unknown }).uri instanceof vscode.Uri) {
    return (arg as { uri: vscode.Uri }).uri;
  }
  return activeFileUri();
}

/**
 * Is this text editor one side of a diff editor (so the diff editor already colors it)? Editors
 * embedded in a diff editor don't always report a viewColumn, so match on the open diff tabs instead.
 */
export function isInDiffEditor(editor: vscode.TextEditor): boolean {
  const u = editor.document.uri.toString();
  const diffs = vscode.window.tabGroups.all
    .map((g) => g.activeTab?.input)
    .filter((i): i is vscode.TabInputTextDiff => i instanceof vscode.TabInputTextDiff);
  const inDiff = diffs.some((i) => i.modified.toString() === u || i.original.toString() === u);
  if (!inDiff) return false;
  // The same file may also be visible in a plain editor next to the diff; that one keeps decorations.
  if (editor.viewColumn !== undefined) {
    const group = vscode.window.tabGroups.all.find((g) => g.viewColumn === editor.viewColumn);
    const input = group?.activeTab?.input;
    if (input instanceof vscode.TabInputText && input.uri.toString() === u) return false;
  }
  return true;
}

/** The editor line a hunk is anchored to: its first added line, or the line where lines were removed. */
export function hunkAnchorLine(h: Hunk, lineCount: number): number {
  return Math.max(0, Math.min(h.curStart, lineCount - 1));
}

/** True when a pure deletion sits after the last line (marker goes below it instead of above). */
export function isDeletionBelowLastLine(h: Hunk, lineCount: number): boolean {
  return h.curLines.length === 0 && h.curStart > lineCount - 1;
}

/** Index of the hunk at `line`: the one containing it, else the next one below, else the last one. */
export function hunkIndexAt(hunks: readonly Hunk[], line: number, lineCount: number): number {
  if (!hunks.length) return -1;
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i];
    const start = hunkAnchorLine(h, lineCount);
    const end = h.curLines.length ? h.curStart + h.curLines.length - 1 : start;
    if (line >= start && line <= end) return i;
  }
  const below = hunks.findIndex((h) => hunkAnchorLine(h, lineCount) > line);
  return below === -1 ? hunks.length - 1 : below;
}

/** Index of the hunk whose lines contain `line` exactly, or -1. */
export function hunkIndexContaining(hunks: readonly Hunk[], line: number, lineCount: number): number {
  return hunks.findIndex((h) => {
    const start = hunkAnchorLine(h, lineCount);
    const end = h.curLines.length ? h.curStart + h.curLines.length - 1 : start;
    return line >= start && line <= end;
  });
}

/** Human label for our default keybindings, e.g. "Ctrl+Alt+Y" (or "⌥⌘Y" on macOS). */
export function keyLabel(key: 'Y' | 'N', shift = false): string {
  if (process.platform === 'darwin') return `${shift ? '⇧' : ''}⌥⌘${key}`;
  return `Ctrl+${shift ? 'Shift+' : ''}Alt+${key}`;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
