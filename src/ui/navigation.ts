import * as vscode from 'vscode';
import { findHunk, hunkFingerprint } from '../core/hunks';
import { FileState, ReviewService } from '../review/reviewService';
import { originalUri } from '../review/originalProvider';
import { activeFileUri, config, hunkAnchorLine, hunkIndexAt, sameFile, ViewMode } from './common';
import { openInlineDiff } from './diffEditor';
import { InlineDecorations } from './inlineDecorations';

export class Navigator {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: ReviewService,
    private readonly decorations: InlineDecorations,
  ) {}

  /** Open a changed file in the configured view mode (or the one given). */
  async open(uri: vscode.Uri, mode: ViewMode = config().viewMode): Promise<void> {
    const st = await this.service.state(uri);
    if (!st) {
      await vscode.window.showTextDocument(uri, { preview: false });
      return;
    }
    if (st.kind !== 'text') return this.showBinaryMessage(st);
    this.decorations.enable(uri);
    let editor: vscode.TextEditor | undefined;
    if (mode === 'inlineDiff' || !st.exists) {
      editor = await openInlineDiff(this.context, st);
    } else {
      editor = await vscode.window.showTextDocument(uri, { preview: false });
    }
    const first = st.hunks[0];
    // Land on the first change, unless the editor was already open somewhere inside the file.
    if (editor && first && editor.selection.active.line === 0) {
      this.revealLine(editor, hunkAnchorLine(first, editor.document.lineCount));
    }
  }

  /** "Review": the file in the active editor if it has changes, else the first changed file. */
  async review(): Promise<void> {
    const files = await this.service.changedFiles();
    if (!files.length) {
      void vscode.window.showInformationMessage('No pending Claude changes.');
      return;
    }
    const current = activeFileUri();
    const target = files.find((f) => sameFile(f.file.uri, current)) ?? files[0];
    await this.open(target.file.uri);
  }

  /** Jump to the i-th change of a file (CodeLens / hover ⌃ ⌄). */
  async gotoHunk(uriArg: string, index: number): Promise<void> {
    const uri = vscode.Uri.parse(uriArg);
    const st = await this.service.state(uri);
    const h = st?.hunks[index];
    if (!h) return;
    const editor =
      vscode.window.activeTextEditor && sameFile(vscode.window.activeTextEditor.document.uri, uri)
        ? vscode.window.activeTextEditor
        : vscode.window.visibleTextEditors.find((e) => sameFile(e.document.uri, uri));
    if (editor) this.revealLine(editor, hunkAnchorLine(h, editor.document.lineCount));
  }

  /** The change at the cursor of the active editor (for the Keep/Undo keybindings). */
  async hunkAtCursor(): Promise<{ uri: vscode.Uri; fingerprint: string } | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') return undefined;
    const st = await this.service.state(editor.document.uri);
    if (!st?.hunks.length) return undefined;
    const i = hunkIndexAt(st.hunks, editor.selection.active.line, editor.document.lineCount);
    return { uri: editor.document.uri, fingerprint: hunkFingerprint(st.hunks[i]) };
  }

  /** Plain "Open File": the real file, no forced decorations. */
  async openPlain(uri: vscode.Uri): Promise<void> {
    const st = await this.service.state(uri);
    if (st && !st.exists) {
      void vscode.window.showWarningMessage(`${st.file.relPath} no longer exists. Use Undo to restore it.`);
      return;
    }
    await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
  }

  private async showBinaryMessage(st: FileState): Promise<void> {
    const what = st.kind === 'binary' ? 'a binary file' : 'larger than 5 MB';
    const pick = await vscode.window.showInformationMessage(
      `${st.file.relPath} is ${what}, so no diff is shown. You can keep or undo it as a whole.`,
      'Keep',
      'Undo',
      'Open',
    );
    if (pick === 'Keep') await vscode.commands.executeCommand('claudeChanges.keepFile', st.file.uri);
    else if (pick === 'Undo') await vscode.commands.executeCommand('claudeChanges.undoFile', st.file.uri);
    else if (pick === 'Open' && st.exists) await vscode.commands.executeCommand('vscode.open', st.file.uri);
  }

  async stepFile(delta: 1 | -1): Promise<void> {
    const files = await this.service.changedFiles();
    if (!files.length) {
      void vscode.window.showInformationMessage('No pending Claude changes.');
      return;
    }
    const current = activeFileUri();
    const idx = files.findIndex((f) => sameFile(f.file.uri, current));
    const next = idx === -1 ? (delta === 1 ? 0 : files.length - 1) : (idx + delta + files.length) % files.length;
    await this.open(files[next].file.uri);
  }

  async stepHunk(delta: 1 | -1): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') return;
    const st = await this.service.state(editor.document.uri);
    if (!st || !st.hunks.length) {
      void vscode.window.setStatusBarMessage('Claude Changes: no changes in this file', 2500);
      return;
    }
    const lines = st.hunks.map((h) => hunkAnchorLine(h, editor.document.lineCount));
    const cur = editor.selection.active.line;
    let target: number;
    if (delta === 1) target = lines.find((l) => l > cur) ?? lines[0];
    else target = [...lines].reverse().find((l) => l < cur) ?? lines[lines.length - 1];
    this.revealLine(editor, target);
  }

  /** "▾ Show N removed": peek the removed lines of the baseline right inside the editor. */
  async showRemoved(uriArg: string, fingerprint: string): Promise<void> {
    const uri = vscode.Uri.parse(uriArg);
    const st = await this.service.state(uri);
    const hunk = st && findHunk(st.hunks, fingerprint);
    if (!st || !hunk || !hunk.baseLines.length) return;
    let editor = vscode.window.visibleTextEditors.find((e) => sameFile(e.document.uri, uri));
    if (!editor) editor = await vscode.window.showTextDocument(uri, { preview: false });
    const anchor = new vscode.Position(hunkAnchorLine(hunk, editor.document.lineCount), 0);
    const removed = new vscode.Range(hunk.baseStart, 0, hunk.baseStart + hunk.baseLines.length - 1, Number.MAX_SAFE_INTEGER);
    await vscode.commands.executeCommand(
      'editor.action.peekLocations',
      uri,
      anchor,
      [new vscode.Location(originalUri(uri), removed)],
      'peek',
    );
  }

  private revealLine(editor: vscode.TextEditor, line: number): void {
    const pos = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}
