import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  acceptHunk,
  classifyContent,
  computeHunks,
  ContentKind,
  DiffStats,
  findHunk,
  Hunk,
  revertEdit,
  sameText,
  stats,
} from '../core/hunks';
import { pathKey } from '../core/manifest';
import type { ManifestEntry } from '../core/manifest';
import { ReviewRoot } from './reviewRoot';

/** Zero-diff entries older than this are pruned on Refresh (see README: rejected edits). */
const STALE_EMPTY_MS = 10 * 60 * 1000;

export type FileStatus = 'new' | 'modified' | 'deleted';

export interface TrackedFile {
  root: ReviewRoot;
  entry: ManifestEntry;
  uri: vscode.Uri;
  key: string;
  relPath: string;
}

export interface FileState {
  file: TrackedFile;
  kind: ContentKind;
  status: FileStatus;
  exists: boolean;
  /** Baseline text (empty for new files). Only meaningful when kind === 'text'. */
  baseline: string;
  /** Current text (open document if any, else disk). Only meaningful when kind === 'text'. */
  current: string;
  hunks: Hunk[];
  stats: DiffStats;
  hasChanges: boolean;
}

const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

function bytesEqual(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (!a || !b) return a === b;
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

function openDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  const key = pathKey(uri.fsPath);
  return vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && pathKey(d.uri.fsPath) === key);
}

export class ReviewService implements vscode.Disposable {
  private roots: ReviewRoot[] = [];
  private readonly rootDisposables: vscode.Disposable[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private readonly cache = new Map<string, Promise<FileState>>();
  private fileWatchers: vscode.Disposable[] = [];
  private lastTrackedPaths = new Set<string>();
  /** Files whose last hunk was undone: removed from the manifest once their editor closes. */
  private readonly removeOnClose = new Set<string>();
  private changeTimer: NodeJS.Timeout | undefined;
  private readonly changedKeys = new Set<string>();
  private allChanged = false;

  private readonly onDidChangeEmitter = new vscode.EventEmitter<{ keys: ReadonlySet<string> | 'all' }>();
  /** Fires (debounced) when tracked files or their diffs changed. */
  readonly onDidChange = this.onDidChangeEmitter.event;

  private readonly onDidChangeBaselineEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChangeBaseline = this.onDidChangeBaselineEmitter.event;

  constructor(private readonly output: vscode.LogOutputChannel) {
    this.rebuildRoots();
    this.disposables.push(
      this.onDidChangeEmitter,
      this.onDidChangeBaselineEmitter,
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.rebuildRoots()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length) this.invalidate(e.document.uri);
      }),
      vscode.workspace.onDidSaveTextDocument((d) => this.invalidate(d.uri)),
      vscode.workspace.onDidCloseTextDocument((d) => void this.onDocumentClosed(d)),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Roots & tracked files
  // -------------------------------------------------------------------------------------------

  private rebuildRoots(): void {
    for (const d of this.rootDisposables.splice(0)) d.dispose();
    for (const r of this.roots) r.dispose();
    this.roots = (vscode.workspace.workspaceFolders ?? [])
      .filter((f) => f.uri.scheme === 'file')
      .map((f) => new ReviewRoot(f, this.output));
    for (const r of this.roots) {
      this.rootDisposables.push(
        r.onDidReload(() => {
          this.onManifestReloaded(r);
        }),
      );
    }
    this.onManifestReloaded(undefined);
  }

  private onManifestReloaded(root: ReviewRoot | undefined): void {
    for (const k of [...this.cache.keys()]) {
      if (!root || root.contains(k)) this.cache.delete(k);
    }
    // Baselines may have changed (or disappeared) for anything tracked before or after this reload.
    const now = new Set(this.allTracked().map((f) => f.entry.path));
    for (const p of new Set([...this.lastTrackedPaths, ...now])) this.onDidChangeBaselineEmitter.fire(vscode.Uri.file(p));
    this.lastTrackedPaths = now;
    this.rewatchFiles();
    this.fireChanged('all');
  }

  /** Watch each tracked file on disk, so edits Claude makes after the first one refresh the diff. */
  private rewatchFiles(): void {
    for (const w of this.fileWatchers) w.dispose();
    this.fileWatchers = [];
    for (const f of this.allTracked()) {
      const dir = vscode.Uri.file(path.dirname(f.uri.fsPath));
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, path.basename(f.uri.fsPath)));
      const inv = () => this.invalidate(f.uri);
      this.fileWatchers.push(w, w.onDidChange(inv), w.onDidCreate(inv), w.onDidDelete(inv));
    }
  }

  getRoots(): readonly ReviewRoot[] {
    return this.roots;
  }

  rootFor(uri: vscode.Uri): ReviewRoot | undefined {
    if (uri.scheme !== 'file') return undefined;
    // Innermost root wins for nested workspace folders.
    return this.roots
      .filter((r) => r.contains(uri.fsPath))
      .sort((a, b) => b.rootPath.length - a.rootPath.length)[0];
  }

  private toTracked(root: ReviewRoot, entry: ManifestEntry): TrackedFile {
    const uri = vscode.Uri.file(entry.path);
    return {
      root,
      entry,
      uri,
      key: pathKey(uri.fsPath),
      relPath: path.relative(root.rootPath, uri.fsPath).replace(/\\/g, '/'),
    };
  }

  /** Every manifest entry, including ones that currently have no diff. Sorted by root, then path. */
  allTracked(): TrackedFile[] {
    const out: TrackedFile[] = [];
    for (const r of this.roots) {
      const files = r.files.map((e) => this.toTracked(r, e));
      files.sort((a, b) => a.relPath.localeCompare(b.relPath));
      out.push(...files);
    }
    return out;
  }

  tracked(uri: vscode.Uri): TrackedFile | undefined {
    const root = this.rootFor(uri);
    const entry = root?.find(uri.fsPath);
    return root && entry ? this.toTracked(root, entry) : undefined;
  }

  /** Tracked files that actually differ from their baseline (what the panel shows). */
  async changedFiles(): Promise<FileState[]> {
    const states = await Promise.all(this.allTracked().map((f) => this.stateOf(f)));
    return states.filter((s) => s.hasChanges);
  }

  // -------------------------------------------------------------------------------------------
  // Diff state
  // -------------------------------------------------------------------------------------------

  async state(uri: vscode.Uri): Promise<FileState | undefined> {
    const f = this.tracked(uri);
    return f ? this.stateOf(f) : undefined;
  }

  private stateOf(file: TrackedFile): Promise<FileState> {
    let p = this.cache.get(file.key);
    if (!p) {
      p = this.computeState(file).catch((err) => {
        this.output.error(`Failed to compute diff for ${file.entry.path}: ${(err as Error).message}`);
        this.cache.delete(file.key);
        throw err;
      });
      this.cache.set(file.key, p);
    }
    return p;
  }

  private async computeState(file: TrackedFile): Promise<FileState> {
    const baseBytes = file.root.readSnapshot(file.entry);
    const doc = openDocument(file.uri);
    let curBytes: Uint8Array | undefined;
    let current: string | undefined;
    let exists = true;
    if (doc && !doc.isClosed) {
      current = doc.getText();
    } else {
      try {
        curBytes = await fs.promises.readFile(file.uri.fsPath);
      } catch {
        exists = false;
      }
    }

    const hasBaseline = file.entry.snapshot !== null;
    const status: FileStatus = !exists ? 'deleted' : file.entry.isNew ? 'new' : 'modified';

    // New file that was never created (edit rejected), or deleted again: nothing to review.
    if (!exists && !hasBaseline) {
      return this.emptyState(file, 'text', status, false);
    }

    const kind = classifyContent(baseBytes) !== 'text' ? classifyContent(baseBytes) : classifyContent(curBytes);
    if (kind !== 'text') {
      const changed = !exists || !bytesEqual(baseBytes, curBytes ?? encoder.encode(current ?? ''));
      return this.emptyState(file, kind, status, changed);
    }

    const baseline = baseBytes ? decoder.decode(baseBytes) : '';
    const cur = current ?? (curBytes ? decoder.decode(curBytes) : '');
    const hunks = exists ? computeHunks(baseline, cur) : computeHunks(baseline, '');
    return {
      file,
      kind,
      status,
      exists,
      baseline,
      current: cur,
      hunks,
      stats: stats(hunks),
      hasChanges: !exists || hunks.length > 0,
    };
  }

  private emptyState(file: TrackedFile, kind: ContentKind, status: FileStatus, hasChanges: boolean): FileState {
    return {
      file,
      kind,
      status,
      exists: status !== 'deleted',
      baseline: '',
      current: '',
      hunks: [],
      stats: { added: 0, removed: 0 },
      hasChanges,
    };
  }

  /** Baseline text for the claude-original: provider. */
  baselineText(uri: vscode.Uri): string {
    const f = this.tracked(uri);
    if (!f) {
      // Not (or no longer) under review: the "original" is the current text, so a review tab that is
      // still open shows no changes instead of the whole file as added.
      const doc = openDocument(uri);
      if (doc) return doc.getText();
      try {
        return decoder.decode(fs.readFileSync(uri.fsPath));
      } catch {
        return '';
      }
    }
    const bytes = f.root.readSnapshot(f.entry);
    if (!bytes) return '';
    const kind = classifyContent(bytes);
    if (kind !== 'text') return `(${kind === 'binary' ? 'binary' : 'large'} file – diff not shown)`;
    return decoder.decode(bytes);
  }

  invalidate(uri: vscode.Uri): void {
    if (uri.scheme !== 'file') return;
    const key = pathKey(uri.fsPath);
    if (!this.cache.has(key) && !this.tracked(uri)) return;
    this.cache.delete(key);
    this.fireChanged(new Set([key]));
  }

  private fireChanged(keys: ReadonlySet<string> | 'all'): void {
    if (keys === 'all') this.allChanged = true;
    else for (const k of keys) this.changedKeys.add(k);
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      const payload = this.allChanged ? ('all' as const) : new Set(this.changedKeys);
      this.allChanged = false;
      this.changedKeys.clear();
      this.onDidChangeEmitter.fire({ keys: payload });
    }, 120);
  }

  // -------------------------------------------------------------------------------------------
  // Keep / Undo
  // -------------------------------------------------------------------------------------------

  async keepFile(uri: vscode.Uri): Promise<void> {
    const f = this.tracked(uri);
    if (!f) return;
    this.removeOnClose.delete(f.key);
    await f.root.remove([f.entry.path]);
  }

  async undoFile(uri: vscode.Uri): Promise<void> {
    const f = this.tracked(uri);
    if (!f) return;
    this.removeOnClose.delete(f.key);
    const baseBytes = f.root.readSnapshot(f.entry);
    if (f.entry.snapshot === null) {
      await this.deleteCreatedFile(f.uri);
    } else if (baseBytes) {
      await this.restoreBytes(f.uri, baseBytes);
    } else {
      throw new Error(`The snapshot of ${f.relPath} is missing, so it cannot be undone.`);
    }
    await f.root.remove([f.entry.path]);
  }

  async keepAll(): Promise<void> {
    this.removeOnClose.clear();
    for (const r of this.roots) await r.remove(r.files.map((e) => e.path));
  }

  /** Undo every file; returns the files that failed. */
  async undoAll(): Promise<string[]> {
    const failed: string[] = [];
    for (const f of this.allTracked()) {
      try {
        const st = await this.stateOf(f);
        if (st.hasChanges) await this.undoFile(f.uri);
        else await f.root.remove([f.entry.path]);
      } catch (err) {
        this.output.error(`Undo failed for ${f.entry.path}: ${(err as Error).message}`);
        failed.push(f.relPath);
      }
    }
    return failed;
  }

  /** Keep one hunk: fold it into the baseline. Removes the file once nothing is left to review. */
  async keepHunk(uri: vscode.Uri, fingerprint: string): Promise<boolean> {
    const st = await this.freshState(uri);
    const hunk = st && findHunk(st.hunks, fingerprint);
    if (!st || !hunk) return false;
    const newBase = acceptHunk(st.baseline, st.current, hunk);
    if (sameText(newBase, st.current)) {
      await st.file.root.remove([st.file.entry.path]);
    } else {
      await st.file.root.setBaseline(st.file.entry.path, encoder.encode(newBase));
      this.invalidate(uri);
      this.onDidChangeBaselineEmitter.fire(uri);
    }
    return true;
  }

  /**
   * Undo one hunk in the editor via a WorkspaceEdit, so Ctrl+Z brings it back. When no hunks are left,
   * the entry is hidden immediately and removed from the manifest when the editor is closed (removing
   * it right away would make a following Ctrl+Z restore untracked changes).
   */
  async undoHunk(uri: vscode.Uri, fingerprint: string): Promise<boolean> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const st = await this.freshState(uri);
    const hunk = st && findHunk(st.hunks, fingerprint);
    if (!st || !hunk) return false;
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const lineLengths = Array.from({ length: doc.lineCount }, (_, i) => doc.lineAt(i).text.length);
    const e = revertEdit(st.baseline, doc.getText(), hunk, lineLengths, eol);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(e.startLine, e.startChar, e.endLine, e.endChar), e.text);
    const ok = await vscode.workspace.applyEdit(edit);
    if (ok && st.hunks.length === 1) this.removeOnClose.add(st.file.key);
    return ok;
  }

  private async freshState(uri: vscode.Uri): Promise<FileState | undefined> {
    const f = this.tracked(uri);
    if (!f) return undefined;
    this.cache.delete(f.key);
    return this.stateOf(f);
  }

  private async onDocumentClosed(doc: vscode.TextDocument): Promise<void> {
    if (doc.uri.scheme !== 'file') return;
    const key = pathKey(doc.uri.fsPath);
    this.invalidate(doc.uri);
    if (!this.removeOnClose.has(key)) return;
    this.removeOnClose.delete(key);
    const st = await this.freshState(doc.uri);
    if (st && !st.hasChanges) await st.file.root.remove([st.file.entry.path]);
  }

  /** Re-read manifests and prune long-stale entries that have nothing to review. */
  async refresh(): Promise<void> {
    for (const r of this.roots) r.load();
    this.onManifestReloaded(undefined);
    const now = Date.now();
    for (const f of this.allTracked()) {
      if (openDocument(f.uri) || now - f.entry.timestamp < STALE_EMPTY_MS) continue;
      const st = await this.stateOf(f);
      if (!st.hasChanges) await f.root.remove([f.entry.path]);
    }
  }

  private async restoreBytes(uri: vscode.Uri, bytes: Uint8Array): Promise<void> {
    const doc = openDocument(uri);
    const kind = classifyContent(bytes);
    if (doc && !doc.isClosed && kind === 'text') {
      // Go through the editor so an open (possibly dirty) document reflects the undo, then save.
      const edit = new vscode.WorkspaceEdit();
      const full = new vscode.Range(0, 0, doc.lineCount, 0);
      edit.replace(uri, doc.validateRange(full), decoder.decode(bytes));
      await vscode.workspace.applyEdit(edit);
      await doc.save();
    }
    // Always finish with the exact original bytes (EOLs, encoding, BOM) on disk.
    await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
    await fs.promises.writeFile(uri.fsPath, bytes);
  }

  private async deleteCreatedFile(uri: vscode.Uri): Promise<void> {
    await closeEditorsFor(uri);
    try {
      await vscode.workspace.fs.delete(uri, { useTrash: true });
    } catch (err) {
      if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') return;
      try {
        await vscode.workspace.fs.delete(uri, { useTrash: false });
      } catch (err2) {
        if (!(err2 instanceof vscode.FileSystemError && err2.code === 'FileNotFound')) throw err2;
      }
    }
  }

  dispose(): void {
    if (this.changeTimer) clearTimeout(this.changeTimer);
    for (const w of this.fileWatchers) w.dispose();
    for (const d of this.rootDisposables) d.dispose();
    for (const r of this.roots) r.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

/** Close every tab showing `uri`, discarding unsaved changes (the file is about to be deleted). */
async function closeEditorsFor(uri: vscode.Uri): Promise<void> {
  const key = pathKey(uri.fsPath);
  const matches = (u: vscode.Uri | undefined) => !!u && u.scheme === 'file' && pathKey(u.fsPath) === key;
  const doc = openDocument(uri);
  if (doc?.isDirty) {
    // Revert first so closing doesn't prompt to save a file we're deleting.
    await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
    await vscode.commands.executeCommand('workbench.action.files.revert');
  }
  const tabs = vscode.window.tabGroups.all.flatMap((g) =>
    g.tabs.filter((t) => {
      const input = t.input;
      if (input instanceof vscode.TabInputText) return matches(input.uri);
      if (input instanceof vscode.TabInputTextDiff) return matches(input.modified);
      if (input instanceof vscode.TabInputCustom) return matches(input.uri);
      return false;
    }),
  );
  if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
}
