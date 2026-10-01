import * as vscode from 'vscode';
import { hunkFingerprint } from '../core/hunks';
import { ReviewService } from '../review/reviewService';
import { config, hunkAnchorLine, keyLabel, plural, sameFile } from './common';
import { reviewDiffTabs } from './diffEditor';
import { InlineDecorations } from './inlineDecorations';

/**
 * Line 1:       ‹ 2 of 19 Files › · Undo File · Keep File · +60 −40       (the file review bar)
 * Each change:  ⌃ ⌄ 4 of 17 · Undo Ctrl+Alt+N · Keep Ctrl+Alt+Y            (the per-block bar)
 *
 * In the stacked (inline diff) view these render inside the diff editor (`diffEditor.codeLens`).
 */
export class ReviewCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly disposables: vscode.Disposable[];

  constructor(
    private readonly service: ReviewService,
    private readonly decorations: InlineDecorations,
  ) {
    const fire = () => this.emitter.fire();
    this.disposables = [
      this.emitter,
      service.onDidChange(fire),
      decorations.onDidChangeEnabled(fire),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('claudeChanges')) fire();
      }),
    ];
  }

  async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (!this.decorations.shouldShow(doc.uri)) return [];
    const st = await this.service.state(doc.uri).catch(() => undefined);
    if (!st || !st.hasChanges) return [];

    const top = new vscode.Range(0, 0, 0, 0);
    const lenses: vscode.CodeLens[] = [];
    const text = (title: string, tooltip?: string) => new vscode.CodeLens(top, { title, tooltip, command: '' });

    const files = await this.service.changedFiles();
    const idx = files.findIndex((f) => sameFile(f.file.uri, doc.uri));
    const n = files.length;
    if (n > 1) {
      lenses.push(new vscode.CodeLens(top, { title: '‹', tooltip: 'Previous changed file', command: 'claudeChanges.prevFile' }));
    }
    lenses.push(text(`${idx + 1} of ${plural(n, 'File')}`));
    if (n > 1) {
      lenses.push(new vscode.CodeLens(top, { title: '›', tooltip: 'Next changed file', command: 'claudeChanges.nextFile' }));
    }
    lenses.push(
      new vscode.CodeLens(top, {
        title: '$(discard) Undo File',
        tooltip: `Undo all of Claude's changes to this file (${keyLabel('N', true)})`,
        command: 'claudeChanges.undoFile',
        arguments: [doc.uri],
      }),
      new vscode.CodeLens(top, {
        title: '$(check) Keep File',
        tooltip: `Keep all of Claude's changes to this file (${keyLabel('Y', true)})`,
        command: 'claudeChanges.keepFile',
        arguments: [doc.uri],
      }),
    );
    if (st.kind !== 'text') {
      lenses.push(text(`${st.kind === 'binary' ? 'Binary' : 'Large'} file – no inline diff`));
      return lenses;
    }
    lenses.push(text(`+${st.stats.added} −${st.stats.removed}`));

    const count = st.hunks.length;
    const inDiff = config().viewMode === 'inlineDiff' && isShownInReviewDiff(doc.uri);
    st.hunks.forEach((h, i) => {
      const line = hunkAnchorLine(h, doc.lineCount);
      const range = new vscode.Range(line, 0, line, 0);
      const args = [doc.uri.toString(), hunkFingerprint(h)];
      if (count > 1) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: '$(chevron-up)',
            tooltip: 'Previous change',
            command: 'claudeChanges.gotoHunk',
            arguments: [doc.uri.toString(), (i - 1 + count) % count],
          }),
          new vscode.CodeLens(range, {
            title: '$(chevron-down)',
            tooltip: 'Next change',
            command: 'claudeChanges.gotoHunk',
            arguments: [doc.uri.toString(), (i + 1) % count],
          }),
        );
      }
      lenses.push(
        new vscode.CodeLens(range, { title: `${i + 1} of ${count}`, command: '' }),
        new vscode.CodeLens(range, {
          title: `$(discard) Undo ${keyLabel('N')}`,
          tooltip: 'Undo this change',
          command: 'claudeChanges.undoHunk',
          arguments: args,
        }),
        new vscode.CodeLens(range, {
          title: `$(check) Keep ${keyLabel('Y')}`,
          tooltip: 'Keep this change',
          command: 'claudeChanges.keepHunk',
          arguments: args,
        }),
      );
      // Decorations mode can't stack removed lines, so offer them in a peek.
      if (h.baseLines.length && !inDiff) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: `▾ ${h.baseLines.length} removed`,
            tooltip: 'Show the removed lines inline (peek)',
            command: 'claudeChanges.showRemoved',
            arguments: args,
          }),
        );
      }
    });
    return lenses;
  }

  refresh(): void {
    this.emitter.fire();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

/** Is the file currently open in one of our stacked review tabs? */
function isShownInReviewDiff(uri: vscode.Uri): boolean {
  return reviewDiffTabs().some((t) => sameFile(t.input.modified, uri));
}
