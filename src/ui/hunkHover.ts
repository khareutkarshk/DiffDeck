// Hovering a changed block shows "Change 4 of 17  ⌃ ⌄ · Undo · Keep", like the floating per-block
// widget in Cursor / chat editing (VS Code has no API for floating widgets inside an editor).

import * as vscode from 'vscode';
import { Hunk, hunkFingerprint } from '../core/hunks';
import { ReviewService } from '../review/reviewService';
import { hunkAnchorLine, hunkIndexContaining, isInDiffEditor, keyLabel, plural } from './common';
import { InlineDecorations } from './inlineDecorations';

const MAX_REMOVED_LINES = 60;

function link(command: string, args: unknown[]): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

export class HunkHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly service: ReviewService,
    private readonly decorations: InlineDecorations,
  ) {}

  async provideHover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
    if (!this.decorations.shouldShow(doc.uri)) return undefined;
    const st = await this.service.state(doc.uri).catch(() => undefined);
    if (!st || st.kind !== 'text' || !st.hunks.length) return undefined;
    const i = hunkIndexContaining(st.hunks, pos.line, doc.lineCount);
    if (i === -1) return undefined;
    const h = st.hunks[i];

    // In the stacked view the removed lines are already visible; elsewhere, show them in the hover.
    const editor = vscode.window.visibleTextEditors.find((e) => e.document === doc);
    const stacked = !!editor && isInDiffEditor(editor);
    const md = hunkHoverMarkdown(doc.uri, st.hunks, i, !stacked);
    const start = hunkAnchorLine(h, doc.lineCount);
    const end = h.curLines.length ? h.curStart + h.curLines.length - 1 : start;
    return new vscode.Hover(md, new vscode.Range(start, 0, end, doc.lineAt(end).text.length));
  }
}

export function hunkHoverMarkdown(uri: vscode.Uri, hunks: readonly Hunk[], i: number, withRemoved: boolean): vscode.MarkdownString {
  const h = hunks[i];
  const count = hunks.length;
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = {
    enabledCommands: ['claudeChanges.keepHunk', 'claudeChanges.undoHunk', 'claudeChanges.gotoHunk', 'claudeChanges.showRemoved'],
  };
  md.supportThemeIcons = true;
  const args = [uri.toString(), hunkFingerprint(h)];
  const nav =
    count > 1
      ? `[$(chevron-up)](${link('claudeChanges.gotoHunk', [uri.toString(), (i - 1 + count) % count])} "Previous change") ` +
        `[$(chevron-down)](${link('claudeChanges.gotoHunk', [uri.toString(), (i + 1) % count])} "Next change") `
      : '';
  const what =
    h.baseLines.length && h.curLines.length
      ? `+${h.curLines.length} −${h.baseLines.length}`
      : h.baseLines.length
        ? `−${plural(h.baseLines.length, 'line')}`
        : `+${plural(h.curLines.length, 'line')}`;
  md.appendMarkdown(
    `${nav}**${i + 1} of ${count}** &nbsp;<span style="color:var(--vscode-descriptionForeground);">${what}</span>` +
      ` &nbsp;&nbsp; [$(discard) Undo](${link('claudeChanges.undoHunk', args)} "Undo this change (${keyLabel('N')})")` +
      ` \`${keyLabel('N')}\`` +
      ` &nbsp; [$(check) Keep](${link('claudeChanges.keepHunk', args)} "Keep this change (${keyLabel('Y')})")` +
      ` \`${keyLabel('Y')}\``,
  );
  if (withRemoved && h.baseLines.length) {
    md.appendMarkdown('\n\n');
    const shown = h.baseLines.slice(0, MAX_REMOVED_LINES).map((l) => `- ${l}`);
    if (h.baseLines.length > MAX_REMOVED_LINES) shown.push(`  … ${h.baseLines.length - MAX_REMOVED_LINES} more`);
    md.appendCodeblock(shown.join('\n'), 'diff');
  }
  md.supportHtml = true;
  return md;
}
