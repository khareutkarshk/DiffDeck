// Mode A: Cursor-style red/green decorations inside the real, editable file.
//
// VS Code's public API can't insert real "virtual" lines, so removed lines are shown with:
//   • a red border line at the deletion point (+ a red "−" gutter icon for pure deletions),
//   • red strikethrough ghost text at the end of that line summarizing the first removed line,
//   • a hover with the complete removed block as a diff (plus Keep / Undo / Show links), and
//   • a CodeLens "▾ Show N removed" (see reviewCodeLens.ts) that opens the removed lines inline in a peek.

import * as vscode from 'vscode';
import { hunkFingerprint, Hunk } from '../core/hunks';
import { pathKey } from '../core/manifest';
import { ReviewService } from '../review/reviewService';
import { config, hunkAnchorLine, isDeletionBelowLastLine, isInDiffEditor, plural, truncate } from './common';

const MAX_HOVER_LINES = 60;

export class InlineDecorations implements vscode.Disposable {
  private readonly added: vscode.TextEditorDecorationType;
  private readonly removedAbove: vscode.TextEditorDecorationType;
  private readonly removedBelow: vscode.TextEditorDecorationType;
  private readonly removedGutter: vscode.TextEditorDecorationType;
  private readonly ghost: vscode.TextEditorDecorationType;
  private readonly all: vscode.TextEditorDecorationType[];
  /** Files explicitly opened for review from the panel (shown even if automatic decorations are off). */
  private readonly enabled = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly onDidChangeEnabledEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeEnabled = this.onDidChangeEnabledEmitter.event;

  constructor(
    extensionUri: vscode.Uri,
    private readonly service: ReviewService,
  ) {
    const media = (f: string) => vscode.Uri.joinPath(extensionUri, 'media', f);
    const addedBg = new vscode.ThemeColor('claudeChanges.addedLineBackground');
    const border = new vscode.ThemeColor('claudeChanges.removedMarker');

    this.added = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: addedBg,
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      dark: { gutterIconPath: media('gutter-added.svg') },
      light: { gutterIconPath: media('gutter-added-light.svg') },
      gutterIconSize: '75%',
    });
    this.removedAbove = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderColor: border,
      borderStyle: 'solid',
      borderWidth: '2px 0 0 0',
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.removedBelow = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderColor: border,
      borderStyle: 'solid',
      borderWidth: '0 0 2px 0',
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.removedGutter = vscode.window.createTextEditorDecorationType({
      dark: { gutterIconPath: media('gutter-removed.svg') },
      light: { gutterIconPath: media('gutter-removed-light.svg') },
      gutterIconSize: '75%',
    });
    this.ghost = vscode.window.createTextEditorDecorationType({
      after: {
        color: new vscode.ThemeColor('claudeChanges.removedGhostText'),
        backgroundColor: new vscode.ThemeColor('claudeChanges.removedLineBackground'),
        textDecoration: 'line-through',
        fontStyle: 'italic',
        margin: '0 0 0 2.5em',
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    this.all = [this.added, this.removedAbove, this.removedBelow, this.removedGutter, this.ghost];

    this.disposables.push(
      ...this.all,
      this.onDidChangeEnabledEmitter,
      service.onDidChange(({ keys }) => this.refresh(keys)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refresh('all')),
      vscode.window.tabGroups.onDidChangeTabs(() => this.refresh('all')),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('claudeChanges')) this.refresh('all');
      }),
    );
    this.refresh('all');
  }

  /** Show decorations for this file even when automatic decorations are off (opened from the panel). */
  enable(uri: vscode.Uri): void {
    this.enabled.add(pathKey(uri.fsPath));
    this.onDidChangeEnabledEmitter.fire();
    this.refresh(new Set([pathKey(uri.fsPath)]));
  }

  /** Whether decorations/CodeLens should be shown for this file at all. */
  shouldShow(uri: vscode.Uri): boolean {
    if (uri.scheme !== 'file') return false;
    return config().showDecorationsAutomatically || this.enabled.has(pathKey(uri.fsPath));
  }

  refresh(keys: ReadonlySet<string> | 'all'): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.scheme !== 'file') continue;
      if (keys !== 'all' && !keys.has(pathKey(editor.document.uri.fsPath))) continue;
      void this.apply(editor);
    }
  }

  private clear(editor: vscode.TextEditor): void {
    for (const t of this.all) editor.setDecorations(t, []);
  }

  private async apply(editor: vscode.TextEditor): Promise<void> {
    const doc = editor.document;
    if (!this.shouldShow(doc.uri) || isInDiffEditor(editor)) return this.clear(editor);
    let st;
    try {
      st = await this.service.state(doc.uri);
    } catch {
      st = undefined;
    }
    // The document may have moved on while we computed; a newer refresh will follow.
    if (!st || st.kind !== 'text' || !st.hasChanges || doc.isClosed) return this.clear(editor);
    if (st.current !== doc.getText()) return;

    const added: vscode.DecorationOptions[] = [];
    const above: vscode.DecorationOptions[] = [];
    const below: vscode.DecorationOptions[] = [];
    const gutter: vscode.DecorationOptions[] = [];
    const ghost: vscode.DecorationOptions[] = [];
    const lineCount = doc.lineCount;

    for (const h of st.hunks) {
      const hover = hoverFor(doc.uri, h);
      if (h.curLines.length) {
        const last = Math.min(h.curStart + h.curLines.length - 1, lineCount - 1);
        added.push({ range: new vscode.Range(h.curStart, 0, last, 0), hoverMessage: hover });
      }
      if (h.baseLines.length) {
        const line = hunkAnchorLine(h, lineCount);
        const range = doc.lineAt(line).range;
        const isBelow = isDeletionBelowLastLine(h, lineCount);
        (isBelow ? below : above).push({ range, hoverMessage: hover });
        if (!h.curLines.length) gutter.push({ range });
        ghost.push({
          range: new vscode.Range(range.end, range.end),
          hoverMessage: hover,
          renderOptions: { after: { contentText: ghostText(h) } },
        });
      }
    }

    editor.setDecorations(this.added, added);
    editor.setDecorations(this.removedAbove, above);
    editor.setDecorations(this.removedBelow, below);
    editor.setDecorations(this.removedGutter, gutter);
    editor.setDecorations(this.ghost, ghost);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

function ghostText(h: Hunk): string {
  const first = h.baseLines.find((l) => l.trim() !== '') ?? h.baseLines[0] ?? '';
  const more = h.baseLines.length > 1 ? `   (${plural(h.baseLines.length, 'line')} removed)` : '';
  // Non-breaking spaces keep the leading gap from collapsing.
  return ` − ${truncate(first.trim(), 80)} ${more} `;
}

function commandLink(command: string, args: unknown[]): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

function hoverFor(uri: vscode.Uri, h: Hunk): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: ['claudeChanges.keepHunk', 'claudeChanges.undoHunk', 'claudeChanges.showRemoved'] };
  md.supportThemeIcons = true;
  const fp = hunkFingerprint(h);
  const args = [uri.toString(), fp];
  const parts: string[] = [];
  if (h.baseLines.length && h.curLines.length) {
    parts.push(`**Claude changed ${plural(h.baseLines.length, 'line')} → ${plural(h.curLines.length, 'line')}**`);
  } else if (h.baseLines.length) {
    parts.push(`**Claude removed ${plural(h.baseLines.length, 'line')}**`);
  } else {
    parts.push(`**Claude added ${plural(h.curLines.length, 'line')}**`);
  }
  md.appendMarkdown(parts.join('') + '\n\n');
  if (h.baseLines.length) {
    const shown = h.baseLines.slice(0, MAX_HOVER_LINES).map((l) => `- ${l}`);
    if (h.baseLines.length > MAX_HOVER_LINES) shown.push(`  … ${h.baseLines.length - MAX_HOVER_LINES} more`);
    md.appendCodeblock(shown.join('\n'), 'diff');
  }
  const links = [
    `[$(check) Keep](${commandLink('claudeChanges.keepHunk', args)})`,
    `[$(discard) Undo](${commandLink('claudeChanges.undoHunk', args)})`,
  ];
  if (h.baseLines.length) links.push(`[$(eye) Show removed inline](${commandLink('claudeChanges.showRemoved', args)})`);
  md.appendMarkdown(links.join(' &nbsp;·&nbsp; '));
  return md;
}
