import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  buildLanguageMap,
  decodeFontCharacter,
  IconThemeDocument,
  languageIdFor,
  LanguageMap,
  parseJsonc,
  resolveIconId,
  ThemeKind,
} from '../core/iconTheme';

/** What the webview needs to draw one icon. */
export type WebviewIcon =
  | { type: 'svg'; src: string }
  | { type: 'font'; char: string; color?: string; font: string; size?: string };

interface LoadedTheme {
  doc: IconThemeDocument;
  dir: string;
  root: vscode.Uri;
}

/** Loads the active file icon theme (`workbench.iconTheme`) and resolves icons for file names. */
export class IconThemeLoader implements vscode.Disposable {
  private theme: LoadedTheme | undefined;
  private languages: LanguageMap = buildLanguageMap([]);
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly subs: vscode.Disposable[];

  constructor(private readonly output: vscode.LogOutputChannel) {
    this.reload();
    this.subs = [
      this.emitter,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('workbench.iconTheme')) this.reload();
      }),
      vscode.window.onDidChangeActiveColorTheme(() => this.emitter.fire()),
      vscode.extensions.onDidChange(() => this.reload()),
    ];
  }

  private reload(): void {
    this.theme = undefined;
    this.languages = buildLanguageMap(
      vscode.extensions.all.flatMap((e) => (e.packageJSON?.contributes?.languages as never[] | undefined) ?? []),
    );
    const id = vscode.workspace.getConfiguration('workbench').get<string | null>('iconTheme');
    if (id) {
      for (const ext of vscode.extensions.all) {
        const themes = (ext.packageJSON?.contributes?.iconThemes ?? []) as { id: string; path: string }[];
        const t = themes.find((x) => x.id === id);
        if (!t) continue;
        const file = path.join(ext.extensionPath, t.path);
        try {
          const doc = parseJsonc(fs.readFileSync(file, 'utf8')) as IconThemeDocument;
          this.theme = { doc, dir: path.dirname(file), root: ext.extensionUri };
        } catch (err) {
          this.output.warn(`Could not load icon theme ${id}: ${(err as Error).message}`);
        }
        break;
      }
    }
    this.emitter.fire();
  }

  /** Folder(s) the webview must be allowed to load icon files from. */
  get resourceRoots(): vscode.Uri[] {
    return this.theme ? [this.theme.root] : [];
  }

  private get kind(): ThemeKind {
    const k = vscode.window.activeColorTheme.kind;
    if (k === vscode.ColorThemeKind.Light) return 'light';
    if (k === vscode.ColorThemeKind.HighContrast || k === vscode.ColorThemeKind.HighContrastLight) return 'highContrast';
    return 'dark';
  }

  /** @font-face rules for font-based icon themes (e.g. Seti). */
  fontFaces(webview: vscode.Webview): string {
    const t = this.theme;
    if (!t?.doc.fonts) return '';
    return t.doc.fonts
      .map((f) => {
        const src = f.src
          .map((s) => `url("${webview.asWebviewUri(vscode.Uri.file(path.join(t.dir, s.path)))}")${s.format ? ` format("${s.format}")` : ''}`)
          .join(', ');
        return `@font-face { font-family: "cc-icon-${f.id}"; src: ${src}; font-weight: ${f.weight ?? 'normal'}; font-style: ${f.style ?? 'normal'}; }`;
      })
      .join('\n');
  }

  iconFor(fileName: string, webview: vscode.Webview): WebviewIcon | undefined {
    const t = this.theme;
    if (!t) return undefined;
    const id = resolveIconId(t.doc, fileName, languageIdFor(fileName, this.languages), this.kind);
    const def = id ? t.doc.iconDefinitions?.[id] : undefined;
    if (!def) return undefined;
    if (def.iconPath) {
      return { type: 'svg', src: webview.asWebviewUri(vscode.Uri.file(path.join(t.dir, def.iconPath))).toString() };
    }
    if (def.fontCharacter) {
      const font = def.fontId ?? t.doc.fonts?.[0]?.id;
      if (!font) return undefined;
      const size = def.fontSize ?? t.doc.fonts?.find((f) => f.id === font)?.size;
      return { type: 'font', char: decodeFontCharacter(def.fontCharacter), color: def.fontColor, font: `cc-icon-${font}`, size };
    }
    return undefined;
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
  }
}
