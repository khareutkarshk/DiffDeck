// Review view: VS Code's built-in diff editor in inline mode, which stacks removed lines (red) above
// the lines that replaced them (green) inside one editable editor.
//
// The API cannot force inline mode for a single diff: `vscode.diff` has no such option and even the
// built-in "inline view" commands just flip the `diffEditor.renderSideBySide` setting. So the first
// time a review opens while the diff editor is side-by-side, we ask once (in User settings) to switch
// it to inline and to enable CodeLens in diff editors (our Keep / Undo rows are CodeLenses).

import * as path from 'path';
import * as vscode from 'vscode';
import { ORIGINAL_SCHEME, originalUri } from '../review/originalProvider';
import { FileState, ReviewService } from '../review/reviewService';
import { sameFile } from './common';

const CHOICE_KEY = 'claudeChanges.inlineSettingsChoice';
type Choice = 'applied' | 'declined';

const WANTED: [key: string, value: boolean][] = [
  ['renderSideBySide', false], // stacked (inline) red/green view
  ['codeLens', true], // Keep / Undo rows above each change
  ['hideOriginalLineNumbers', true], // one line-number column, like Cursor (newer VS Code only)
];

/** Settings that still differ from what the stacked review needs (unknown settings are skipped). */
function missingSettings(): typeof WANTED {
  const c = vscode.workspace.getConfiguration('diffEditor');
  return WANTED.filter(([k, v]) => c.inspect<boolean>(k)?.defaultValue !== undefined && c.get<boolean>(k) !== v);
}

export async function ensureInlineSettings(context: vscode.ExtensionContext, force = false): Promise<void> {
  const missing = missingSettings();
  if (!missing.length) return;
  if (!force && context.globalState.get<Choice>(CHOICE_KEY) === 'declined') return;

  const apply = 'Use Stacked View';
  const no = 'Keep Current View';
  const pick = await vscode.window.showInformationMessage(
    'Claude Changes shows removed and added lines stacked in one editor using VS Code\'s inline diff view. ' +
      `Update your User settings (${missing.map(([k, v]) => `diffEditor.${k}: ${v}`).join(', ')})? ` +
      'Other diff editors (e.g. Git) will use the same view.',
    apply,
    no,
  );
  if (pick === apply) {
    const c = vscode.workspace.getConfiguration('diffEditor');
    for (const [k, v] of missing) {
      await c.update(k, v, vscode.ConfigurationTarget.Global);
      // A workspace value would still win over the User value; remove only values set to the opposite.
      const ins = c.inspect<boolean>(k);
      if (ins?.workspaceValue !== undefined && ins.workspaceValue !== v) {
        await c.update(k, undefined, vscode.ConfigurationTarget.Workspace);
      }
    }
    await context.globalState.update(CHOICE_KEY, 'applied');
  } else if (pick === no) {
    await context.globalState.update(CHOICE_KEY, 'declined');
  }
}

export function diffTitle(st: FileState): string {
  const name = path.basename(st.file.uri.fsPath);
  const what = st.status === 'new' ? 'new file' : st.status === 'deleted' ? 'deleted' : 'Claude changes';
  return `${name} (${what})`;
}

/** Open (or focus) the stacked review of a file. */
export async function openInlineDiff(context: vscode.ExtensionContext, st: FileState): Promise<vscode.TextEditor | undefined> {
  await ensureInlineSettings(context);
  const left = originalUri(st.file.uri);
  const right = st.exists ? st.file.uri : originalUri(st.file.uri, 'deleted');
  await vscode.commands.executeCommand('vscode.diff', left, right, diffTitle(st), { preview: false });
  const editor = vscode.window.activeTextEditor;
  return editor && sameFile(editor.document.uri, st.file.uri) ? editor : undefined;
}

/** Diff tabs we opened (original side served by claude-original:). */
export function reviewDiffTabs(): { tab: vscode.Tab; input: vscode.TabInputTextDiff; group: vscode.TabGroup }[] {
  const out = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === ORIGINAL_SCHEME) {
        out.push({ tab, input: tab.input, group });
      }
    }
  }
  return out;
}

/**
 * When a file has nothing left to review (kept, undone, or all hunks resolved), turn its review tab
 * back into a normal editor at the same position – like Cursor does when a review is finished.
 */
let closing: Promise<void> | undefined;
let closeAgain = false;

export function closeFinishedReviews(service: ReviewService): Promise<void> {
  // Serialize: overlapping runs would each try to swap the same tab.
  if (closing) {
    closeAgain = true;
    return closing;
  }
  closing = (async () => {
    do {
      closeAgain = false;
      await closeFinishedOnce(service);
    } while (closeAgain);
  })().finally(() => (closing = undefined));
  return closing;
}

async function closeFinishedOnce(service: ReviewService): Promise<void> {
  for (const { tab, input, group } of reviewDiffTabs()) {
    if (input.modified.scheme !== 'file') {
      // Deleted-file placeholder: finished once the file is no longer tracked.
      if (!service.tracked(vscode.Uri.file(input.modified.fsPath))) await vscode.window.tabGroups.close(tab, true);
      continue;
    }
    const st = await service.state(input.modified).catch(() => undefined);
    if (st && st.hasChanges) continue;
    const wasActive = tab.isActive && group.isActive;
    const editor = vscode.window.visibleTextEditors.find((e) => sameFile(e.document.uri, input.modified) && e.viewColumn === group.viewColumn);
    const selection = editor?.selection;
    const visible = editor?.visibleRanges[0];
    // Open the plain editor first so the document (and its undo stack / unsaved state) stays open
    // while the diff tab closes – no save prompt, and Ctrl+Z keeps working.
    if (wasActive) {
      const plain = await vscode.window.showTextDocument(input.modified, {
        viewColumn: group.viewColumn,
        preview: false,
        selection,
      });
      if (visible) plain.revealRange(visible, vscode.TextEditorRevealType.AtTop);
    }
    // Look the tabs up again: tab/group objects captured before opening the editor may be stale.
    const same = vscode.window.tabGroups.all
      .filter((g) => g.viewColumn === group.viewColumn)
      .flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputTextDiff && t.input.original.toString() === input.original.toString());
    if (same.length) await vscode.window.tabGroups.close(same, true);
  }
}
