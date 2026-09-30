import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as manifestIO from '../core/manifest';
import type { Manifest, ManifestEntry } from '../core/manifest';

/** Review state for one workspace folder: its manifest and snapshot files under .claude/review/. */
export class ReviewRoot implements vscode.Disposable {
  readonly rootPath: string;
  private entries: ManifestEntry[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private reloadTimer: NodeJS.Timeout | undefined;
  private readonly onDidReloadEmitter = new vscode.EventEmitter<void>();
  /** Fires (debounced) after the manifest was re-read from disk. */
  readonly onDidReload = this.onDidReloadEmitter.event;

  constructor(
    readonly folder: vscode.WorkspaceFolder,
    private readonly output: vscode.LogOutputChannel,
  ) {
    this.rootPath = folder.uri.fsPath;
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, `${manifestIO.REVIEW_DIR}/manifest.json`),
    );
    const schedule = () => this.scheduleReload();
    this.disposables.push(
      watcher,
      watcher.onDidCreate(schedule),
      watcher.onDidChange(schedule),
      watcher.onDidDelete(schedule),
      this.onDidReloadEmitter,
    );
    this.load();
  }

  get paths() {
    return manifestIO.reviewPaths(this.rootPath);
  }

  get files(): readonly ManifestEntry[] {
    return this.entries;
  }

  find(fsPath: string): ManifestEntry | undefined {
    return manifestIO.findEntry({ version: manifestIO.MANIFEST_VERSION, files: this.entries }, fsPath);
  }

  contains(fsPath: string): boolean {
    return manifestIO.isInside(fsPath, this.rootPath);
  }

  scheduleReload(delay = 150): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      this.load();
      this.onDidReloadEmitter.fire();
    }, delay);
  }

  /** Synchronously re-read the manifest (it is small). Corruption is logged, never thrown. */
  load(): void {
    const { manifest, warning } = manifestIO.readManifest(this.rootPath);
    if (warning) this.output.warn(`[${this.folder.name}] ${warning}`);
    this.entries = manifest.files.filter((e) => this.contains(e.path));
  }

  /** Absolute path of an entry's snapshot file, if it has one. */
  snapshotPath(entry: ManifestEntry): string | undefined {
    return entry.snapshot ? path.join(this.paths.originals, entry.snapshot) : undefined;
  }

  readSnapshot(entry: ManifestEntry): Uint8Array | undefined {
    const p = this.snapshotPath(entry);
    if (!p) return undefined;
    try {
      return fs.readFileSync(p);
    } catch (err) {
      this.output.warn(`[${this.folder.name}] snapshot for ${entry.path} is missing: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * Read-modify-write the manifest under the shared lock (the same lock the hook uses), then reload.
   * `fn` may return false to skip the write.
   */
  async mutate(fn: (manifest: Manifest) => boolean | void): Promise<void> {
    await manifestIO.withLock(this.rootPath, () => {
      const { manifest, warning } = manifestIO.readManifest(this.rootPath);
      if (warning) this.output.warn(`[${this.folder.name}] ${warning}`);
      if (fn(manifest) === false) return;
      manifestIO.writeManifestAtomic(this.rootPath, manifest);
    });
    this.load();
    this.onDidReloadEmitter.fire();
  }

  /** Remove entries (and their snapshot files) for the given paths. */
  async remove(fsPaths: readonly string[]): Promise<void> {
    if (!fsPaths.length) return;
    const keys = new Set(fsPaths.map((p) => manifestIO.pathKey(p)));
    const removed: ManifestEntry[] = [];
    await this.mutate((m) => {
      const before = m.files.length;
      m.files = m.files.filter((e) => {
        if (!keys.has(manifestIO.pathKey(e.path))) return true;
        removed.push(e);
        return false;
      });
      return m.files.length !== before;
    });
    for (const e of removed) {
      const p = this.snapshotPath(e);
      if (p) fs.rmSync(p, { force: true });
    }
  }

  /** Replace an entry's baseline (after keeping a hunk). Creates a snapshot for new files. */
  async setBaseline(fsPath: string, content: Uint8Array): Promise<void> {
    await this.mutate((m) => {
      const entry = manifestIO.findEntry(m, fsPath);
      if (!entry) return false;
      if (!entry.snapshot) entry.snapshot = manifestIO.snapshotName(entry.path);
      manifestIO.writeFileAtomic(path.join(this.paths.originals, entry.snapshot), content);
      return true;
    });
  }

  dispose(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    for (const d of this.disposables) d.dispose();
  }
}
