import * as vscode from 'vscode';
import { Installer } from './install/installer';
import { ORIGINAL_SCHEME, OriginalContentProvider } from './review/originalProvider';
import { ReviewService } from './review/reviewService';
import { ChangesDecorationProvider, ChangesTreeProvider, FileNode } from './ui/changesTree';
import { activeFileUri, config, plural, resolveUri } from './ui/common';
import { InlineDecorations } from './ui/inlineDecorations';
import { Navigator } from './ui/navigation';
import { ReviewCodeLensProvider } from './ui/reviewCodeLens';

/** Internal handle returned from activate() for the integration tests. Not a public API. */
export interface TestApi {
  service: ReviewService;
}

export function activate(context: vscode.ExtensionContext): TestApi {
  const output = vscode.window.createOutputChannel('Claude Changes', { log: true });
  const service = new ReviewService(output);
  const installer = new Installer(context, output);
  const decorations = new InlineDecorations(context.extensionUri, service);
  const navigator = new Navigator(context, service, decorations);
  const tree = new ChangesTreeProvider(service);
  const badges = new ChangesDecorationProvider();
  const treeView = vscode.window.createTreeView('claudeChanges.files', { treeDataProvider: tree, showCollapseAll: false });
  const codeLens = new ReviewCodeLensProvider(service, decorations);
  const originals = new OriginalContentProvider(service);

  const status = vscode.window.createStatusBarItem('claudeChanges.status', vscode.StatusBarAlignment.Left, 50);
  status.name = 'Claude Changes';
  status.command = 'claudeChanges.focusPanel';

  context.subscriptions.push(
    output,
    service,
    decorations,
    tree,
    badges,
    treeView,
    codeLens,
    originals,
    status,
    vscode.window.registerFileDecorationProvider(badges),
    vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, originals),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLens),
  );

  // ---- summary: badge, status bar, context keys, auto-open --------------------------------------
  let lastCount = -1;
  let summaryTimer: NodeJS.Timeout | undefined;
  const updateSummary = async () => {
    const files = await tree.load().catch(() => [] as FileNode[]);
    const n = files.length;
    badges.update(files);
    treeView.badge = n ? { value: n, tooltip: `${plural(n, 'file')} changed by Claude` } : undefined;
    treeView.description = n ? plural(n, 'file') : undefined;
    status.text = `$(sparkle) Claude: ${plural(n, 'file')} changed`;
    status.tooltip = 'Review changes made by Claude Code';
    if (n) status.show();
    else status.hide();
    void vscode.commands.executeCommand('setContext', 'claudeChanges.hasChanges', n > 0);
    void vscode.commands.executeCommand('setContext', 'claudeChanges.hookInstalled', installer.anyInstalled());
    if (lastCount >= 0 && n > lastCount && config().autoOpenPanel && files[0]) {
      // Reveal without taking focus away from the terminal where Claude is running.
      void treeView.reveal(files[0], { select: false, focus: false }).then(undefined, () => undefined);
    }
    lastCount = n;
    updateActiveContext();
  };
  const scheduleSummary = () => {
    if (summaryTimer) clearTimeout(summaryTimer);
    summaryTimer = setTimeout(() => void updateSummary(), 100);
  };
  const updateActiveContext = () => {
    const uri = activeFileUri();
    void vscode.commands.executeCommand('setContext', 'claudeChanges.activeEditorTracked', !!uri && !!service.tracked(uri));
  };
  context.subscriptions.push(
    service.onDidChange(scheduleSummary),
    vscode.window.onDidChangeActiveTextEditor(updateActiveContext),
    { dispose: () => summaryTimer && clearTimeout(summaryTimer) },
  );
  void updateSummary();

  // ---- commands -------------------------------------------------------------------------------
  const withUri =
    (fn: (uri: vscode.Uri) => Promise<unknown>) =>
    async (arg?: unknown): Promise<void> => {
      const uri = resolveUri(arg);
      if (!uri || !service.tracked(uri)) {
        void vscode.window.showInformationMessage('Claude Changes: this file has no pending Claude changes.');
        return;
      }
      await run(fn(uri));
    };

  const run = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      output.error(String((err as Error).stack ?? err));
      void vscode.window.showErrorMessage(`Claude Changes: ${(err as Error).message}`);
    }
  };

  const register = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register('claudeChanges.installHook', () => run(installer.install().then(scheduleSummary)));
  register('claudeChanges.uninstallHook', () => run(installer.uninstall().then(scheduleSummary)));
  register('claudeChanges.refresh', () => run(service.refresh()));
  register('claudeChanges.focusPanel', () => vscode.commands.executeCommand('claudeChanges.files.focus'));

  register('claudeChanges.openDiff', withUri((uri) => navigator.open(uri)));
  register('claudeChanges.openFile', withUri((uri) => navigator.openPlain(uri)));
  register('claudeChanges.keepFile', withUri((uri) => service.keepFile(uri)));
  register(
    'claudeChanges.undoFile',
    withUri(async (uri) => {
      const f = service.tracked(uri)!;
      if (config().confirmUndo) {
        const what = f.entry.snapshot === null ? 'delete the new file' : 'restore the original';
        const ok = await vscode.window.showWarningMessage(
          `Undo Claude's changes to ${f.relPath}? This will ${what}.`,
          { modal: true },
          'Undo',
        );
        if (ok !== 'Undo') return;
      }
      await service.undoFile(uri);
    }),
  );

  register('claudeChanges.keepAll', () => run(service.keepAll()));
  register('claudeChanges.undoAll', async () => {
    const files = await service.changedFiles();
    if (!files.length) return;
    const ok = await vscode.window.showWarningMessage(
      `Undo all of Claude's changes in ${plural(files.length, 'file')}? New files will be deleted and modified files restored.`,
      { modal: true },
      'Undo All',
    );
    if (ok !== 'Undo All') return;
    await run(
      service.undoAll().then((failed) => {
        if (failed.length) void vscode.window.showErrorMessage(`Claude Changes: could not undo ${failed.join(', ')} (see Output).`);
      }),
    );
  });

  register('claudeChanges.keepHunk', (uriArg: string, fp: string) =>
    run(
      service.keepHunk(vscode.Uri.parse(uriArg), fp).then((ok) => {
        if (!ok) void vscode.window.setStatusBarMessage('Claude Changes: that change moved – try again', 2500);
      }),
    ),
  );
  register('claudeChanges.undoHunk', (uriArg: string, fp: string) =>
    run(
      service.undoHunk(vscode.Uri.parse(uriArg), fp).then((ok) => {
        if (!ok) void vscode.window.setStatusBarMessage('Claude Changes: that change moved – try again', 2500);
      }),
    ),
  );
  register('claudeChanges.showRemoved', (uriArg: string, fp: string) => run(navigator.showRemoved(uriArg, fp)));

  register('claudeChanges.nextFile', () => run(navigator.stepFile(1)));
  register('claudeChanges.prevFile', () => run(navigator.stepFile(-1)));
  register('claudeChanges.nextHunk', () => run(navigator.stepHunk(1)));
  register('claudeChanges.prevHunk', () => run(navigator.stepHunk(-1)));

  void installer.promptIfNeeded().then(scheduleSummary);
  return { service };
}

export function deactivate(): void {
  /* everything is disposed through context.subscriptions */
}
