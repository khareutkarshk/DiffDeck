import * as vscode from 'vscode';
import type { Hunk } from '../core/hunks';
import { pathKey } from '../core/manifest';

export type ViewMode = 'decorations' | 'inlineDiffEditor';

export function config() {
  const c = vscode.workspace.getConfiguration('claudeChanges');
  return {
    viewMode: c.get<ViewMode>('viewMode', 'decorations'),
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
  if (arg && typeof arg === 'object' && 'uri' in arg && (arg as { uri: unknown }).uri instanceof vscode.Uri) {
    return (arg as { uri: vscode.Uri }).uri;
  }
  return activeFileUri();
}

/** Is this text editor one side of a diff editor (so the diff editor already colors it)? */
export function isInDiffEditor(editor: vscode.TextEditor): boolean {
  if (editor.viewColumn === undefined) return false;
  const group = vscode.window.tabGroups.all.find((g) => g.viewColumn === editor.viewColumn);
  const input = group?.activeTab?.input;
  if (!(input instanceof vscode.TabInputTextDiff)) return false;
  const u = editor.document.uri;
  return input.modified.toString() === u.toString() || input.original.toString() === u.toString();
}

/** The editor line a hunk is anchored to: its first added line, or the line where lines were removed. */
export function hunkAnchorLine(h: Hunk, lineCount: number): number {
  return Math.max(0, Math.min(h.curStart, lineCount - 1));
}

/** True when a pure deletion sits after the last line (marker goes below it instead of above). */
export function isDeletionBelowLastLine(h: Hunk, lineCount: number): boolean {
  return h.curLines.length === 0 && h.curStart > lineCount - 1;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
