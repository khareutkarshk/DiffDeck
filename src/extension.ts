import * as vscode from 'vscode';
import { Installer } from './install/installer';
import { ORIGINAL_SCHEME, OriginalContentProvider } from './review/originalProvider';
import { ReviewService } from './review/reviewService';
import { activeFileUri, config, hunkIndexAt, plural, resolveUri, sameFile } from './ui/common';
import { closeFinishedReviews, ensureInlineSettings } from './ui/diffEditor';
import { FILES_VIEW_ID, FilesViewProvider } from './ui/filesView';
import { HunkHoverProvider } from './ui/hunkHover';
import { IconThemeLoader } from './ui/iconThemeLoader';
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
  const icons = new IconThemeLoader(output);
  const filesView = new FilesViewProvider(context.extensionUri, service, icons);
  const codeLens = new ReviewCodeLensProvider(service, decorations);
  const originals = new OriginalContentProvider(service);

  const status = vscode.window.createStatusBarItem('claudeChanges.status', vscode.StatusBarAlignment.Left, 50);
  status.name = 'Claude Changes';
  status.command = 'claudeChanges.focusPanel';
  // "File 2/19 · Change 4/17" while a changed file is focused.
  const position = vscode.window.createStatusBarItem('claudeChanges.position', vscode.StatusBarAlignment.Left, 49);
  position.name = 'Claude Changes: position';
  position.command = 'claudeChanges.nextHunk';

  context.subscriptions.push(
    output,
    service,
    decorations,
    icons,
    filesView,
    codeLens,
    originals,
    status,
    position,
    vscode.window.registerWebviewViewProvider(FILES_VIEW_ID, filesView, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, originals),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLens),
    vscode.languages.registerHoverProvider({ scheme: 'file' }, new HunkHoverProvider(service, decorations)),
  );

  // ---- summary: badge, status bar, context keys, auto-open --------------------------------------
  let lastCount = -1;
  let summaryTimer: NodeJS.Timeout | undefined;
  let changed: Awaited<ReturnType<typeof service.changedFiles>> = [];
  const updateSummary = async () => {
    changed = await service.changedFiles().catch(() => []);
    const n = changed.length;
    const hookInstalled = installer.anyInstalled();
    filesView.update(changed, hookInstalled);
    status.text = `$(sparkle) Claude: ${plural(n, 'file')} changed`;
    status.tooltip = 'Review changes made by Claude Code';
    if (n) status.show();
    else status.hide();
    void vscode.commands.executeCommand('setContext', 'claudeChanges.hasChanges', n > 0);
    void vscode.commands.executeCommand('setContext', 'claudeChanges.multipleFiles', n > 1);
    void vscode.commands.executeCommand('setContext', 'claudeChanges.hookInstalled', hookInstalled);
    if (lastCount >= 0 && n > lastCount && config().autoOpenPanel && !filesView.visible) {
      // Show the panel without taking focus away from the terminal where Claude is running.
      void vscode.commands.executeCommand(`${FILES_VIEW_ID}.focus`, { preserveFocus: true });
    }
    lastCount = n;
    void updateActiveContext();
    void closeFinishedReviews(service).catch((err) => output.warn(`closing finished reviews: ${err}`));
  };
  const scheduleSummary = () => {
    if (summaryTimer) clearTimeout(summaryTimer);
    summaryTimer = setTimeout(() => void updateSummary(), 100);
  };
  const updateActiveContext = async () => {
    const uri = activeFileUri();
    const idx = uri ? changed.findIndex((f) => sameFile(f.file.uri, uri)) : -1;
    void vscode.commands.executeCommand('setContext', 'claudeChanges.activeEditorTracked', idx !== -1);
    if (idx === -1) {
      position.hide();
      return;
    }
    const st = await service.state(changed[idx].file.uri).catch(() => undefined);
    const editor = vscode.window.activeTextEditor;
    let text = `File ${idx + 1}/${changed.length}`;
    if (st?.hunks.length && editor && sameFile(editor.document.uri, uri)) {
      const h = hunkIndexAt(st.hunks, editor.selection.active.line, editor.document.lineCount);
      text += ` · Change ${h + 1}/${st.hunks.length}`;
    }
    position.text = `$(diff) ${text}`;
    position.tooltip = 'Claude Changes – click for the next change';
    position.show();
  };
  let cursorTimer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    service.onDidChange(scheduleSummary),
    vscode.window.onDidChangeActiveTextEditor(() => void updateActiveContext()),
    vscode.window.tabGroups.onDidChangeTabs(() => void updateActiveContext()),
    vscode.window.onDidChangeTextEditorSelection(() => {
      if (cursorTimer) clearTimeout(cursorTimer);
      cursorTimer = setTimeout(() => void updateActiveContext(), 80);
    }),
    {
      dispose: () => {
        if (summaryTimer) clearTimeout(summaryTimer);
        if (cursorTimer) clearTimeout(cursorTimer);
      },
    },
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
  register('claudeChanges.focusPanel', () => vscode.commands.executeCommand(`${FILES_VIEW_ID}.focus`));

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

  const hunkCommand = (action: 'keep' | 'undo') => async (uriArg?: string, fp?: string) => {
    const target = uriArg && fp ? { uri: vscode.Uri.parse(uriArg), fingerprint: fp } : await navigator.hunkAtCursor();
    if (!target) return;
    const op = action === 'keep' ? service.keepHunk(target.uri, target.fingerprint) : service.undoHunk(target.uri, target.fingerprint);
    await run(
      op.then((ok) => {
        if (!ok) void vscode.window.setStatusBarMessage('Claude Changes: that change moved – try again', 2500);
      }),
    );
  };
  register('claudeChanges.keepHunk', hunkCommand('keep'));
  register('claudeChanges.undoHunk', hunkCommand('undo'));
  register('claudeChanges.gotoHunk', (uriArg: string, index: number) => run(navigator.gotoHunk(uriArg, index)));
  register('claudeChanges.review', () => run(navigator.review()));
  register('claudeChanges.useStackedView', () => run(ensureInlineSettings(context, true)));
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
