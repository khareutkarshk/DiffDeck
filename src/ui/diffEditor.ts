// Mode B: VS Code's built-in diff editor, in inline (unified) mode.
//
// The API cannot force inline mode for a single diff (neither `vscode.diff` nor TextDocumentShowOptions
// has such an option; the built-in "Toggle Inline View" flips the same global setting). So we never touch
// User settings: the first time a side-by-side user opens a diff from here, we ask once whether to set
// `diffEditor.renderSideBySide: false` for THIS WORKSPACE only (which also affects Git diffs here).

import * as path from 'path';
import * as vscode from 'vscode';
import { FileState } from '../review/reviewService';
import { originalUri } from '../review/originalProvider';

const CHOICE_KEY = 'claudeChanges.inlineDiffChoice';
type Choice = 'workspace' | 'sideBySide';

async function ensureInlinePreference(context: vscode.ExtensionContext): Promise<void> {
  const diffConfig = vscode.workspace.getConfiguration('diffEditor');
  if (diffConfig.get<boolean>('renderSideBySide', true) === false) return;
  if (context.workspaceState.get<Choice>(CHOICE_KEY)) return;

  const useInline = 'Use Inline in This Workspace';
  const keep = 'Keep Side-by-Side';
  const pick = await vscode.window.showInformationMessage(
    'VS Code can only show inline diffs through the "diffEditor.renderSideBySide" setting. ' +
      'Set it to inline for this workspace only? (Your User settings stay unchanged; Git diffs in this workspace become inline too.)',
    useInline,
    keep,
  );
  if (pick === useInline) {
    await diffConfig.update('renderSideBySide', false, vscode.ConfigurationTarget.Workspace);
    await context.workspaceState.update(CHOICE_KEY, 'workspace');
  } else if (pick === keep) {
    await context.workspaceState.update(CHOICE_KEY, 'sideBySide');
  }
}

export async function openInlineDiff(context: vscode.ExtensionContext, st: FileState): Promise<void> {
  await ensureInlinePreference(context);
  const name = path.basename(st.file.uri.fsPath);
  const left = originalUri(st.file.uri);
  const right = st.exists ? st.file.uri : originalUri(st.file.uri, 'deleted');
  const label = st.status === 'new' ? 'new file' : st.status === 'deleted' ? 'deleted' : 'original ↔ Claude';
  await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (${label})`, { preview: false });
}

/** Forget the stored answer (used when the user runs the command again after changing their mind). */
export function resetInlinePreference(context: vscode.ExtensionContext): Thenable<void> {
  return context.workspaceState.update(CHOICE_KEY, undefined);
}
