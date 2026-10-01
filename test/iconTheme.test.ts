import { describe, expect, it } from 'vitest';
import { buildLanguageMap, decodeFontCharacter, IconThemeDocument, languageIdFor, parseJsonc, resolveIconId } from '../src/core/iconTheme';

const theme: IconThemeDocument = {
  file: '_file',
  fileExtensions: { tsx: '_react', 'test.tsx': '_test', md: '_markdown' },
  fileNames: { 'package.json': '_npm', 'Dockerfile': '_docker' },
  languageIds: { typescript: '_ts', css: '_css' },
  light: { fileExtensions: { tsx: '_react_light' }, file: '_file_light' },
};

const languages = buildLanguageMap([
  { id: 'typescript', extensions: ['.ts', '.mts'] },
  { id: 'css', extensions: ['.css'] },
  { id: 'dockerfile', filenames: ['Dockerfile'] },
]);

describe('resolveIconId', () => {
  it('follows VS Code precedence: file name, then longest extension, then language, then default', () => {
    expect(resolveIconId(theme, 'package.json', languageIdFor('package.json', languages), 'dark')).toBe('_npm');
    expect(resolveIconId(theme, 'dockerfile', undefined, 'dark')).toBe('_docker'); // case-insensitive name
    expect(resolveIconId(theme, 'Button.test.tsx', undefined, 'dark')).toBe('_test');
    expect(resolveIconId(theme, 'EventInfo.tsx', undefined, 'dark')).toBe('_react');
    expect(resolveIconId(theme, 'content.ts', languageIdFor('content.ts', languages), 'dark')).toBe('_ts');
    expect(resolveIconId(theme, 'globals.css', languageIdFor('globals.css', languages), 'dark')).toBe('_css');
    expect(resolveIconId(theme, 'notes.xyz', undefined, 'dark')).toBe('_file');
  });

  it('prefers the light-theme associations in light themes', () => {
    expect(resolveIconId(theme, 'EventInfo.tsx', undefined, 'light')).toBe('_react_light');
    expect(resolveIconId(theme, 'MASTER.md', undefined, 'light')).toBe('_markdown'); // falls back to base
    expect(resolveIconId(theme, 'x.unknown', undefined, 'light')).toBe('_file_light');
  });
});

describe('languageIdFor', () => {
  it('maps by file name first, then extension', () => {
    expect(languageIdFor('Dockerfile', languages)).toBe('dockerfile');
    expect(languageIdFor('a.mts', languages)).toBe('typescript');
    expect(languageIdFor('a.nope', languages)).toBeUndefined();
  });
});

describe('parseJsonc', () => {
  it('accepts comments and trailing commas but keeps strings intact', () => {
    const v = parseJsonc('{\n // line\n "a": "http://x/*y*/", /* block */ "b": [1, 2,],\n}') as Record<string, unknown>;
    expect(v).toEqual({ a: 'http://x/*y*/', b: [1, 2] });
  });
  it('handles escaped quotes inside strings', () => {
    expect(parseJsonc('{"a": "say \\"hi\\" // not a comment"}')).toEqual({ a: 'say "hi" // not a comment' });
  });
});

describe('decodeFontCharacter', () => {
  it('decodes backslash hex escapes', () => {
    expect(decodeFontCharacter('\\E001')).toBe('\uE001');
    expect(decodeFontCharacter('x')).toBe('x');
  });
});
