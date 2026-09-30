import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { REVIEW_DIR } from '../core/manifest';
import {
  addGitignoreEntry,
  addHook,
  HOOK_SCRIPT_REL,
  isHookInstalled,
  parseSettings,
  removeGitignoreEntry,
  removeHook,
  serializeSettings,
} from '../core/settingsMerge';

const PROMPTED_KEY = 'claudeChanges.installPrompted';

function settingsPath(root: string) {
  return path.join(root, '.claude', 'settings.json');
}

function readIfExists(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export type InstallStatus = 'installed' | 'outdated' | 'notInstalled';

export class Installer {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.LogOutputChannel,
  ) {}

  private get bundledScript(): string {
    return path.join(this.context.extensionPath, 'hook', 'snapshot.js');
  }

  status(folder: vscode.WorkspaceFolder): InstallStatus {
    const root = folder.uri.fsPath;
    let text: string | undefined;
    try {
      text = readIfExists(settingsPath(root));
    } catch {
      return 'notInstalled';
    }
    const parsed = parseSettings(text);
    const script = readIfExists(path.join(root, HOOK_SCRIPT_REL));
    if (!parsed.ok || !isHookInstalled(parsed.settings) || script === undefined) return 'notInstalled';
    const scriptCurrent = script === fs.readFileSync(this.bundledScript, 'utf8');
    return scriptCurrent && !addHook(parsed.settings).changed ? 'installed' : 'outdated';
  }

  anyInstalled(): boolean {
    return (vscode.workspace.workspaceFolders ?? []).some((f) => this.status(f) !== 'notInstalled');
  }

  private async pickFolder(placeHolder: string): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
    if (!folders.length) {
      void vscode.window.showWarningMessage('Claude Changes: open a folder first.');
      return undefined;
    }
    if (folders.length === 1) return folders[0];
    return vscode.window.showWorkspaceFolderPick({ placeHolder });
  }

  async install(folder?: vscode.WorkspaceFolder): Promise<boolean> {
    folder ??= await this.pickFolder('Install the Claude Changes hook in which folder?');
    if (!folder) return false;
    const root = folder.uri.fsPath;
    const sp = settingsPath(root);

    // 1. Validate settings.json BEFORE touching anything.
    const parsed = parseSettings(readIfExists(sp));
    if (!parsed.ok) {
      void vscode.window.showErrorMessage(`Claude Changes: not installed – ${parsed.error}. Fix ${path.relative(root, sp)} and try again.`);
      return false;
    }

    // 2. Copy the hook script.
    const dest = path.join(root, HOOK_SCRIPT_REL);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(this.bundledScript, dest);

    // 3. Merge the hook entry.
    const { settings, changed } = addHook(parsed.settings);
    if (changed) {
      fs.mkdirSync(path.dirname(sp), { recursive: true });
      fs.writeFileSync(sp, serializeSettings(settings, parsed.indent));
    }

    // 4. .gitignore, only if the project has one.
    const gi = path.join(root, '.gitignore');
    const giText = readIfExists(gi);
    if (giText !== undefined) {
      const r = addGitignoreEntry(giText);
      if (r.changed) fs.writeFileSync(gi, r.text);
    }

    this.output.info(`Installed hook in ${root} (settings ${changed ? 'updated' : 'already had the hook'})`);
    if (!nodeOnPath()) {
      void vscode.window.showWarningMessage(
        'Claude Changes hook installed, but "node" was not found on PATH. The hook runs with Node.js – install Node.js (or add it to PATH) for Claude Code, otherwise edits will not be tracked.',
      );
    } else {
      void vscode.window.showInformationMessage(
        `Claude Changes hook installed in "${folder.name}". Restart running Claude Code sessions (or run /hooks) so they pick it up.`,
      );
    }
    return true;
  }

  async uninstall(): Promise<boolean> {
    const folder = await this.pickFolder('Uninstall the Claude Changes hook from which folder?');
    if (!folder) return false;
    const root = folder.uri.fsPath;
    const sp = settingsPath(root);
    const text = readIfExists(sp);
    const parsed = parseSettings(text);
    if (!parsed.ok) {
      void vscode.window.showErrorMessage(`Claude Changes: can't uninstall – ${parsed.error}.`);
      return false;
    }
    const { settings, changed } = removeHook(parsed.settings);
    if (changed) {
      // If our hook was the only content, remove the file we most likely created.
      if (Object.keys(settings).length === 0) fs.rmSync(sp, { force: true });
      else fs.writeFileSync(sp, serializeSettings(settings, parsed.indent));
    }
    fs.rmSync(path.join(root, HOOK_SCRIPT_REL), { force: true });
    removeDirIfEmpty(path.join(root, '.claude', 'hooks'));

    const gi = path.join(root, '.gitignore');
    const giText = readIfExists(gi);
    if (giText !== undefined) {
      const r = removeGitignoreEntry(giText);
      if (r.changed) fs.writeFileSync(gi, r.text);
    }

    const reviewDir = path.join(root, REVIEW_DIR);
    if (fs.existsSync(reviewDir)) {
      const del = 'Delete Review Data';
      const pick = await vscode.window.showInformationMessage(
        `Claude Changes hook removed from "${folder.name}". Also delete pending review data (${REVIEW_DIR})? Pending changes stay in your files either way.`,
        del,
        'Keep It',
      );
      if (pick === del) fs.rmSync(reviewDir, { recursive: true, force: true });
    } else {
      void vscode.window.showInformationMessage(`Claude Changes hook removed from "${folder.name}".`);
    }
    removeDirIfEmpty(path.join(root, '.claude'));
    this.output.info(`Uninstalled hook from ${root}`);
    return true;
  }

  /** One-time (per workspace) offer to install, and an offer to update an outdated script. */
  async promptIfNeeded(): Promise<void> {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
    for (const folder of folders) {
      const status = this.status(folder);
      if (status === 'outdated') {
        const key = `claudeChanges.updatePrompted.${this.context.extension.packageJSON.version}`;
        if (this.context.workspaceState.get(key)) continue;
        await this.context.workspaceState.update(key, true);
        const pick = await vscode.window.showInformationMessage(
          `The Claude Changes hook in "${folder.name}" is from a different version of the extension. Update it?`,
          'Update',
        );
        if (pick === 'Update') await this.install(folder);
      }
    }
    if (this.anyInstalled() || !folders.length) return;
    if (this.context.workspaceState.get(PROMPTED_KEY)) return;
    await this.context.workspaceState.update(PROMPTED_KEY, true);
    const pick = await vscode.window.showInformationMessage(
      'Claude Changes: install the Claude Code hook in this workspace so edits by Claude can be reviewed here?',
      'Install Hook',
      'Not Now',
    );
    if (pick === 'Install Hook') await this.install();
  }
}

function nodeOnPath(): boolean {
  try {
    const r = cp.spawnSync('node', ['--version'], { timeout: 3000, windowsHide: true });
    return r.status === 0;
  } catch {
    return false;
  }
}

function removeDirIfEmpty(dir: string): void {
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    /* missing or not empty */
  }
}
