import * as vscode from 'vscode';
import { ReviewService } from './reviewService';

export const ORIGINAL_SCHEME = 'claude-original';

/** claude-original: URI for a file's baseline. `deleted` gives an empty stand-in for a missing file. */
export function originalUri(fileUri: vscode.Uri, variant: 'original' | 'deleted' = 'original'): vscode.Uri {
  return vscode.Uri.from({ scheme: ORIGINAL_SCHEME, path: fileUri.path, query: variant === 'deleted' ? 'deleted' : '' });
}

/** Read-only provider serving the snapshot (original) content of tracked files. */
export class OriginalContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly service: ReviewService) {
    this.sub = service.onDidChangeBaseline((uri) => this.emitter.fire(originalUri(uri)));
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    if (uri.query === 'deleted') return '';
    return this.service.baselineText(vscode.Uri.file(uri.fsPath));
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }
}
