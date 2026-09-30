import * as path from 'path';
import * as vscode from 'vscode';
import { ReviewRoot } from '../review/reviewRoot';
import { FileState, FileStatus, ReviewService } from '../review/reviewService';
import { plural } from './common';

/** Tree items use this scheme for resourceUri so file icons work but our badges don't leak into Explorer/tabs. */
export const TREE_ITEM_SCHEME = 'claude-changes-item';

export interface RootNode {
  kind: 'root';
  root: ReviewRoot;
  files: FileNode[];
}

export interface FileNode {
  kind: 'file';
  uri: vscode.Uri;
  state: FileState;
  parent?: RootNode;
}

type Node = RootNode | FileNode;

const STATUS_LABEL: Record<FileStatus, string> = { new: 'New', modified: 'Modified', deleted: 'Deleted' };

export class ChangesTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private nodes: Node[] = [];
  private files: FileNode[] = [];
  private readonly sub: vscode.Disposable;

  constructor(private readonly service: ReviewService) {
    this.sub = service.onDidChange(() => this.emitter.fire(undefined));
  }

  /** Rebuild the node list from the current diff states. */
  async load(): Promise<FileNode[]> {
    const states = await this.service.changedFiles();
    const roots = this.service.getRoots();
    const byRoot = new Map<ReviewRoot, FileNode[]>();
    for (const st of states) {
      const list = byRoot.get(st.file.root) ?? [];
      list.push({ kind: 'file', uri: st.file.uri, state: st });
      byRoot.set(st.file.root, list);
    }
    if (roots.length > 1) {
      this.nodes = roots
        .filter((r) => byRoot.has(r))
        .map((r) => {
          const node: RootNode = { kind: 'root', root: r, files: byRoot.get(r)! };
          for (const f of node.files) f.parent = node;
          return node;
        });
    } else {
      this.nodes = [...byRoot.values()].flat();
    }
    this.files = this.nodes.flatMap((n) => (n.kind === 'root' ? n.files : [n]));
    return this.files;
  }

  fileNodes(): readonly FileNode[] {
    return this.files;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (!element) {
      await this.load();
      return this.nodes;
    }
    return element.kind === 'root' ? element.files : [];
  }

  getParent(element: Node): Node | undefined {
    return element.kind === 'file' ? element.parent : undefined;
  }

  getTreeItem(element: Node): vscode.TreeItem {
    if (element.kind === 'root') {
      const item = new vscode.TreeItem(element.root.folder.name, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon('root-folder');
      item.description = plural(element.files.length, 'file');
      item.contextValue = 'claudeRoot';
      return item;
    }
    const st = element.state;
    const rel = st.file.relPath;
    const dir = path.posix.dirname(rel);
    const item = new vscode.TreeItem(path.basename(element.uri.fsPath), vscode.TreeItemCollapsibleState.None);
    item.id = st.file.key;
    item.resourceUri = element.uri.with({ scheme: TREE_ITEM_SCHEME });
    const counts = st.kind === 'text' ? `+${st.stats.added} −${st.stats.removed}` : st.kind;
    item.description = `${dir === '.' ? '' : dir + '  '}${counts}`;
    item.contextValue = st.kind === 'text' ? 'claudeFile' : 'claudeFileBinary';
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**${rel}** — ${STATUS_LABEL[st.status]} by Claude\n\n`);
    if (st.kind === 'text') {
      tooltip.appendMarkdown(`${plural(st.hunks.length, 'change')}: +${st.stats.added} / −${st.stats.removed} lines`);
    } else {
      tooltip.appendMarkdown(`${st.kind === 'binary' ? 'Binary' : 'Large (> 5 MB)'} file — no inline diff. Keep or Undo it as a whole.`);
    }
    item.tooltip = tooltip;
    item.command = { title: 'Open Diff', command: 'claudeChanges.openDiff', arguments: [element.uri] };
    return item;
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }
}

/** U / M / D badges (like Source Control), only on our tree items. */
export class ChangesDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private status = new Map<string, FileStatus>();

  update(nodes: readonly FileNode[]): void {
    this.status = new Map(nodes.map((n) => [n.uri.with({ scheme: TREE_ITEM_SCHEME }).toString(), n.state.status]));
    this.emitter.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== TREE_ITEM_SCHEME) return undefined;
    switch (this.status.get(uri.toString())) {
      case 'new':
        return new vscode.FileDecoration('U', 'New (created by Claude)', new vscode.ThemeColor('gitDecoration.untrackedResourceForeground'));
      case 'modified':
        return new vscode.FileDecoration('M', 'Modified by Claude', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
      case 'deleted':
        return new vscode.FileDecoration('D', 'Deleted', new vscode.ThemeColor('gitDecoration.deletedResourceForeground'));
      default:
        return undefined;
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
