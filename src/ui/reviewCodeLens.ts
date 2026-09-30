import * as vscode from 'vscode';
import { hunkFingerprint } from '../core/hunks';
import { ReviewService } from '../review/reviewService';
import { hunkAnchorLine, plural, sameFile } from './common';
import { InlineDecorations } from './inlineDecorations';

/**
 * Line 0:      Keep File | Undo File | ◀ Prev | Next ▶ (2/5 files)      – replaces Cursor's review bar
 * Each hunk:   Keep | Undo | ▾ Show N removed
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
    const uriArg = doc.uri.toString();

    const files = await this.service.changedFiles();
    const idx = files.findIndex((f) => sameFile(f.file.uri, doc.uri));
    const position = files.length ? `(${idx + 1}/${plural(files.length, 'file')})` : '';

    lenses.push(
      new vscode.CodeLens(top, { title: '$(check) Keep File', command: 'claudeChanges.keepFile', arguments: [doc.uri] }),
      new vscode.CodeLens(top, { title: '$(discard) Undo File', command: 'claudeChanges.undoFile', arguments: [doc.uri] }),
    );
    if (files.length > 1) {
      lenses.push(
        new vscode.CodeLens(top, { title: '◀ Prev', command: 'claudeChanges.prevFile' }),
        new vscode.CodeLens(top, { title: `Next ▶ ${position}`, command: 'claudeChanges.nextFile' }),
      );
    } else {
      lenses.push(new vscode.CodeLens(top, { title: position, command: '' }));
    }
    if (st.kind !== 'text') {
      lenses.push(new vscode.CodeLens(top, { title: `${st.kind === 'binary' ? 'Binary' : 'Large'} file – no inline diff`, command: '' }));
      return lenses;
    }
    lenses.push(
      new vscode.CodeLens(top, {
        title: `Claude: ${plural(st.hunks.length, 'change')}  +${st.stats.added} −${st.stats.removed}`,
        command: '',
      }),
    );

    for (const h of st.hunks) {
      const line = hunkAnchorLine(h, doc.lineCount);
      const range = new vscode.Range(line, 0, line, 0);
      const args = [uriArg, hunkFingerprint(h)];
      lenses.push(
        new vscode.CodeLens(range, { title: '$(check) Keep', command: 'claudeChanges.keepHunk', arguments: args }),
        new vscode.CodeLens(range, { title: '$(discard) Undo', command: 'claudeChanges.undoHunk', arguments: args }),
      );
      if (h.baseLines.length) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: `▾ Show ${h.baseLines.length} removed`,
            tooltip: 'Show the removed lines inline (peek)',
            command: 'claudeChanges.showRemoved',
            arguments: args,
          }),
        );
      }
    }
    return lenses;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
