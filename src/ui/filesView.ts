// The "N Files · Undo All · Keep All · Review" panel, as a webview so it can match the Cursor / chat
// editing look: theme file icons, green/red line counts, hover actions.

import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { FileState, ReviewService } from '../review/reviewService';
import { activeFileUri, sameFile } from './common';
import { IconThemeLoader, WebviewIcon } from './iconThemeLoader';

export const FILES_VIEW_ID = 'claudeChanges.files';

interface Row {
  uri: string;
  name: string;
  dir: string;
  showDir: boolean;
  added: number;
  removed: number;
  status: FileState['status'];
  kind: FileState['kind'];
  icon?: WebviewIcon;
  active: boolean;
}

interface Group {
  name?: string;
  rows: Row[];
}

type Message =
  | { type: 'ready' }
  | { type: 'open' | 'keep' | 'undo' | 'openFile'; uri: string }
  | { type: 'keepAll' | 'undoAll' | 'review' | 'install' };

export class FilesViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private files: FileState[] = [];
  private hookInstalled = false;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: ReviewService,
    private readonly icons: IconThemeLoader,
  ) {
    this.subs.push(
      icons.onDidChange(() => {
        if (this.view) {
          this.view.webview.options = this.webviewOptions();
          this.view.webview.html = this.html(this.view.webview);
        }
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.post()),
      vscode.window.tabGroups.onDidChangeTabs(() => this.post()),
    );
  }

  /** Called by the extension whenever the list of changed files is recomputed. */
  update(files: FileState[], hookInstalled: boolean): void {
    this.files = files;
    this.hookInstalled = hookInstalled;
    if (this.view) {
      const n = files.length;
      this.view.badge = n ? { value: n, tooltip: `${n} file${n === 1 ? '' : 's'} changed by Claude` } : undefined;
      this.view.description = undefined;
    }
    this.post();
  }

  get visible(): boolean {
    return !!this.view?.visible;
  }

  private webviewOptions(): vscode.WebviewOptions {
    return {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media'), ...this.icons.resourceRoots],
    };
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = this.webviewOptions();
    view.webview.html = this.html(view.webview);
    this.subs.push(
      view.webview.onDidReceiveMessage((m: Message) => void this.onMessage(m)),
      view.onDidDispose(() => (this.view = undefined)),
      view.onDidChangeVisibility(() => this.post()),
    );
    this.update(this.files, this.hookInstalled);
  }

  private async onMessage(m: Message): Promise<void> {
    switch (m.type) {
      case 'ready':
        return this.post();
      case 'open':
        await vscode.commands.executeCommand('claudeChanges.openDiff', vscode.Uri.parse(m.uri));
        return;
      case 'openFile':
        await vscode.commands.executeCommand('claudeChanges.openFile', vscode.Uri.parse(m.uri));
        return;
      case 'keep':
        await vscode.commands.executeCommand('claudeChanges.keepFile', vscode.Uri.parse(m.uri));
        return;
      case 'undo':
        await vscode.commands.executeCommand('claudeChanges.undoFile', vscode.Uri.parse(m.uri));
        return;
      case 'keepAll':
        await vscode.commands.executeCommand('claudeChanges.keepAll');
        return;
      case 'undoAll':
        await vscode.commands.executeCommand('claudeChanges.undoAll');
        return;
      case 'review':
        await vscode.commands.executeCommand('claudeChanges.review');
        return;
      case 'install':
        await vscode.commands.executeCommand('claudeChanges.installHook');
        return;
    }
  }

  private post(): void {
    const view = this.view;
    if (!view) return;
    const active = activeFileUri();
    const nameCount = new Map<string, number>();
    for (const f of this.files) {
      const n = path.basename(f.file.uri.fsPath);
      nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
    }
    const byRoot = new Map<string, Group>();
    const multiRoot = this.service.getRoots().length > 1;
    for (const f of this.files) {
      const name = path.basename(f.file.uri.fsPath);
      const dir = path.posix.dirname(f.file.relPath);
      const row: Row = {
        uri: f.file.uri.toString(),
        name,
        dir: dir === '.' ? '' : dir,
        showDir: (nameCount.get(name) ?? 0) > 1,
        added: f.stats.added,
        removed: f.stats.removed,
        status: f.status,
        kind: f.kind,
        icon: this.icons.iconFor(name, view.webview),
        active: sameFile(f.file.uri, active),
      };
      const key = f.file.root.rootPath;
      const g = byRoot.get(key) ?? { name: multiRoot ? f.file.root.folder.name : undefined, rows: [] };
      g.rows.push(row);
      byRoot.set(key, g);
    }
    void view.webview.postMessage({
      type: 'state',
      total: this.files.length,
      groups: [...byRoot.values()],
      hookInstalled: this.hookInstalled,
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${nonce}">
${this.icons.fontFaces(webview)}
:root {
  --added: var(--vscode-gitDecoration-addedResourceForeground, #81b88b);
  --removed: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39);
  --muted: var(--vscode-descriptionForeground);
  --hover: var(--vscode-list-hoverBackground);
  --active: var(--vscode-list-inactiveSelectionBackground);
  --border: var(--vscode-widget-border, var(--vscode-panel-border, transparent));
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 6px 8px 10px;
  color: var(--vscode-foreground);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  background: transparent;
  user-select: none;
}
.card {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--vscode-sideBar-background, transparent);
  overflow: hidden;
}
.header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 6px 5px 8px;
  min-height: 30px;
}
.toggle {
  display: flex; align-items: center; gap: 4px; white-space: nowrap; flex: none;
  background: none; border: 0; color: var(--muted); cursor: pointer;
  font: inherit; padding: 2px 2px; border-radius: 4px;
}
.toggle:hover { color: var(--vscode-foreground); }
.chev { width: 16px; height: 16px; transition: transform .12s ease; }
.collapsed .chev { transform: rotate(-90deg); }
.spacer { flex: 1; min-width: 4px; }
/* Narrow sidebar: drop the secondary labels before anything wraps. */
@media (max-width: 250px) { .tbtn.secondary { display: none; } }
.tbtn {
  background: none; border: 0; color: var(--muted); cursor: pointer;
  font: inherit; padding: 3px 7px; border-radius: 5px; white-space: nowrap; flex: none;
}
.tbtn:hover { color: var(--vscode-foreground); background: var(--hover); }
.tbtn.primary {
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  background: var(--vscode-button-secondaryBackground, var(--hover));
}
.tbtn.primary:hover { background: var(--vscode-button-secondaryHoverBackground, var(--hover)); }
.tbtn:focus-visible, .row:focus-visible, .toggle:focus-visible, .act:focus-visible {
  outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px;
}
.list { padding: 0 4px 4px; }
.collapsed .list { display: none; }
.group { padding: 6px 8px 2px; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
.row {
  display: flex; align-items: center; gap: 6px;
  height: 24px; padding: 0 6px; border-radius: 5px; cursor: pointer;
  outline: none;
}
.row:hover { background: var(--hover); }
.row.active { background: var(--active); }
.icon { width: 16px; height: 16px; flex: none; display: flex; align-items: center; justify-content: center; }
.icon img { width: 16px; height: 16px; }
.icon .glyph { font-size: 16px; line-height: 1; }
.icon .fallback { width: 12px; height: 14px; border: 1.5px solid var(--muted); border-radius: 2px; opacity: .7; }
.name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.row.deleted .name { text-decoration: line-through; opacity: .75; }
.dir { color: var(--muted); font-size: 0.92em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.add { color: var(--added); font-variant-numeric: tabular-nums; flex: none; }
.rem { color: var(--removed); font-variant-numeric: tabular-nums; flex: none; }
.tag { color: var(--muted); font-size: .85em; flex: none; }
.acts { margin-left: auto; display: none; gap: 2px; flex: none; }
.row:hover .acts, .row:focus-within .acts { display: flex; }
.act {
  width: 20px; height: 20px; border: 0; border-radius: 4px; background: none; color: var(--muted);
  display: flex; align-items: center; justify-content: center; cursor: pointer; padding: 0;
}
.act:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, var(--hover)); }
.act svg { width: 14px; height: 14px; }
.empty { padding: 14px 10px; color: var(--muted); line-height: 1.5; }
.empty button {
  margin-top: 8px; font: inherit; cursor: pointer; border: 0; border-radius: 4px; padding: 4px 10px;
  background: var(--vscode-button-background); color: var(--vscode-button-foreground);
}
.empty button:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}">
(() => {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let state = { total: 0, groups: [], hookInstalled: true };
  let collapsed = (vscode.getState() || {}).collapsed === true;

  const svg = {
    chev: '<svg class="chev" viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 6l3.5 3.5L11.5 6l.7.7L8 10.9 3.8 6.7z"/></svg>',
    undo: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 3v3.8h3.8l-1.5-1.5A4 4 0 1 1 4.3 9.5l-1 .3A5 5 0 1 0 5.1 4.6L3.5 3z"/></svg>',
    keep: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M6.3 11.6L2.7 8l.7-.7 2.9 2.9 6.3-6.3.7.7z"/></svg>',
    file: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M9.5 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4.5L9.5 1zM12 14H4V2h5v3h3v9z"/></svg>',
  };

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  function iconEl(icon) {
    const box = el('span', 'icon');
    if (icon && icon.type === 'svg') {
      const img = el('img');
      img.src = icon.src;
      img.alt = '';
      box.appendChild(img);
    } else if (icon && icon.type === 'font') {
      const g = el('span', 'glyph', icon.char);
      g.style.fontFamily = '"' + icon.font + '"';
      if (icon.color) g.style.color = icon.color;
      if (icon.size) g.style.fontSize = icon.size;
      box.appendChild(g);
    } else {
      box.appendChild(el('span', 'fallback'));
    }
    return box;
  }

  function actButton(kind, title, onClick) {
    const b = el('button', 'act');
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = svg[kind];
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  function rowEl(r) {
    const row = el('div', 'row' + (r.active ? ' active' : '') + (r.status === 'deleted' ? ' deleted' : ''));
    row.tabIndex = 0;
    row.title = (r.dir ? r.dir + '/' : '') + r.name + (r.status === 'new' ? ' (new)' : r.status === 'deleted' ? ' (deleted)' : '');
    row.dataset.vscodeContext = JSON.stringify({ webviewSection: 'file', uri: r.uri, preventDefaultContextMenuItems: true });
    row.appendChild(iconEl(r.icon));
    row.appendChild(el('span', 'name', r.name));
    if (r.showDir && r.dir) row.appendChild(el('span', 'dir', r.dir));
    if (r.kind === 'text') {
      if (r.added) row.appendChild(el('span', 'add', '+' + r.added));
      if (r.removed) row.appendChild(el('span', 'rem', '-' + r.removed));
    } else {
      row.appendChild(el('span', 'tag', r.kind));
    }
    if (r.status === 'deleted') row.appendChild(el('span', 'tag', 'deleted'));
    const acts = el('span', 'acts');
    acts.appendChild(actButton('file', 'Open File', () => vscode.postMessage({ type: 'openFile', uri: r.uri })));
    acts.appendChild(actButton('undo', 'Undo File', () => vscode.postMessage({ type: 'undo', uri: r.uri })));
    acts.appendChild(actButton('keep', 'Keep File', () => vscode.postMessage({ type: 'keep', uri: r.uri })));
    row.appendChild(acts);
    const open = () => vscode.postMessage({ type: 'open', uri: r.uri });
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    return row;
  }

  function textButton(label, cls, type) {
    const b = el('button', 'tbtn' + (cls ? ' ' + cls : ''), label);
    b.addEventListener('click', () => vscode.postMessage({ type }));
    return b;
  }

  function render() {
    app.textContent = '';
    if (!state.total) {
      const empty = el('div', 'empty');
      if (state.hookInstalled) {
        empty.textContent = 'No pending changes. Files Claude Code edits or creates will show up here for review.';
      } else {
        empty.appendChild(el('div', '', 'The Claude Code hook is not installed in this workspace yet.'));
        const b = el('button', '', 'Install Hook');
        b.addEventListener('click', () => vscode.postMessage({ type: 'install' }));
        empty.appendChild(b);
      }
      app.appendChild(empty);
      return;
    }
    const card = el('div', 'card' + (collapsed ? ' collapsed' : ''));
    const header = el('div', 'header');
    const toggle = el('button', 'toggle');
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.innerHTML = svg.chev;
    toggle.appendChild(el('span', '', state.total + (state.total === 1 ? ' File' : ' Files')));
    toggle.addEventListener('click', () => {
      collapsed = !collapsed;
      vscode.setState({ collapsed });
      render();
    });
    header.appendChild(toggle);
    header.appendChild(el('span', 'spacer'));
    header.appendChild(textButton('Undo All', 'secondary', 'undoAll'));
    header.appendChild(textButton('Keep All', 'secondary', 'keepAll'));
    header.appendChild(textButton('Review', 'primary', 'review'));
    card.appendChild(header);
    const list = el('div', 'list');
    for (const g of state.groups) {
      if (g.name) list.appendChild(el('div', 'group', g.name));
      for (const r of g.rows) list.appendChild(rowEl(r));
    }
    card.appendChild(list);
    app.appendChild(card);
  }

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'state') {
      state = e.data;
      render();
    }
  });
  render();
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
  }
}
