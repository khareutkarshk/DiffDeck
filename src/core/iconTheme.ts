// Resolving a file's icon from a VS Code file icon theme (the JSON format of `contributes.iconThemes`),
// so the files panel can show the same icons as the Explorer. Pure logic – no `vscode` import.

export interface IconDefinition {
  iconPath?: string;
  fontCharacter?: string;
  fontColor?: string;
  fontSize?: string;
  fontId?: string;
}

export interface IconAssociations {
  file?: string;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  languageIds?: Record<string, string>;
}

export interface IconFont {
  id: string;
  src: { path: string; format?: string }[];
  weight?: string;
  style?: string;
  size?: string;
}

export interface IconThemeDocument extends IconAssociations {
  iconDefinitions?: Record<string, IconDefinition>;
  fonts?: IconFont[];
  light?: IconAssociations;
  highContrast?: IconAssociations;
}

export type ThemeKind = 'dark' | 'light' | 'highContrast';

/** Parse JSON with comments and trailing commas (icon themes are often JSONC). */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[++i] ?? '';
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** Map file names and extensions to language ids, from `contributes.languages` of all extensions. */
export interface LanguageMap {
  byFileName: Map<string, string>;
  byExtension: Map<string, string>;
}

export function buildLanguageMap(contributions: { id?: string; extensions?: string[]; filenames?: string[] }[]): LanguageMap {
  const byFileName = new Map<string, string>();
  const byExtension = new Map<string, string>();
  for (const c of contributions) {
    if (!c.id) continue;
    for (const f of c.filenames ?? []) if (!byFileName.has(f.toLowerCase())) byFileName.set(f.toLowerCase(), c.id);
    for (const e of c.extensions ?? []) {
      const ext = e.replace(/^\./, '').toLowerCase();
      if (ext && !byExtension.has(ext)) byExtension.set(ext, c.id);
    }
  }
  return { byFileName, byExtension };
}

export function languageIdFor(fileName: string, map: LanguageMap): string | undefined {
  const name = fileName.toLowerCase();
  const byName = map.byFileName.get(name);
  if (byName) return byName;
  for (const ext of extensionCandidates(name)) {
    const id = map.byExtension.get(ext);
    if (id) return id;
  }
  return undefined;
}

/** "a.test.tsx" → ["test.tsx", "tsx"] (longest first, like VS Code). */
function extensionCandidates(name: string): string[] {
  const parts = name.split('.');
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(i).join('.'));
  return out;
}

/** The icon definition id VS Code would use for a file, following its precedence rules. */
export function resolveIconId(theme: IconThemeDocument, fileName: string, languageId: string | undefined, kind: ThemeKind): string | undefined {
  const name = fileName.toLowerCase();
  const layers: IconAssociations[] = [];
  if (kind === 'light' && theme.light) layers.push(theme.light);
  if (kind === 'highContrast' && theme.highContrast) layers.push(theme.highContrast);
  layers.push(theme);

  const pick = (get: (a: IconAssociations) => string | undefined) => {
    for (const l of layers) {
      const v = get(l);
      if (v) return v;
    }
    return undefined;
  };
  const lower = (rec: Record<string, string> | undefined, key: string) => {
    if (!rec) return undefined;
    if (rec[key]) return rec[key];
    for (const k of Object.keys(rec)) if (k.toLowerCase() === key) return rec[k];
    return undefined;
  };

  return (
    pick((l) => lower(l.fileNames, name)) ??
    extensionCandidates(name)
      .map((ext) => pick((l) => lower(l.fileExtensions, ext)))
      .find((v) => v !== undefined) ??
    (languageId ? pick((l) => lower(l.languageIds, languageId)) : undefined) ??
    pick((l) => l.file)
  );
}

/** Decode a font icon character such as "\\E001" or "" into the actual character. */
export function decodeFontCharacter(value: string): string {
  const m = /^\\([0-9a-fA-F]{1,6})$/.exec(value);
  return m ? String.fromCodePoint(parseInt(m[1], 16)) : value;
}
