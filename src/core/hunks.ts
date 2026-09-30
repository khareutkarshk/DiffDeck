// Line-level hunk computation between a baseline (the original) and the current text.
// Pure logic – no `vscode` import – so it can be unit-tested.
//
// Texts are tokenized into lines that KEEP their "\n" terminator (after CRLF → LF normalization), so a
// missing final newline is a real, visible difference on the last line (like git's "\ No newline at end
// of file") instead of an invisible one, and joining tokens reproduces the text exactly.

import { diffArrays } from 'diff';

export const MAX_DIFF_BYTES = 5 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8000;
const DIFF_TIMEOUT_MS = 1500;

export interface Hunk {
  /** 0-based index of the first current line in the hunk (for pure deletions: where the lines were). */
  curStart: number;
  /** Current lines of the hunk (added side), without terminators. */
  curLines: string[];
  /** 0-based index of the first baseline line in the hunk. */
  baseStart: number;
  /** Baseline lines of the hunk (removed side), without terminators. */
  baseLines: string[];
}

export interface DiffStats {
  added: number;
  removed: number;
}

export type Eol = '\n' | '\r\n';

export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function detectEol(text: string, fallback: Eol = '\n'): Eol {
  const crlf = text.indexOf('\r\n');
  const lf = text.indexOf('\n');
  if (lf === -1) return fallback;
  return crlf !== -1 && crlf === lf - 1 ? '\r\n' : '\n';
}

/** Split into line tokens, each keeping its "\n" (only the last one may lack it). */
export function tokenize(text: string): string[] {
  const norm = normalizeEol(text);
  if (norm === '') return [];
  return norm.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function stripNl(token: string): string {
  return token.endsWith('\n') ? token.slice(0, -1) : token;
}

/** Compute hunks between baseline and current text. EOL style differences are ignored. */
export function computeHunks(baseText: string, curText: string): Hunk[] {
  const base = tokenize(baseText);
  const cur = tokenize(curText);

  // Fast path: trim the common prefix/suffix so large mostly-unchanged files diff quickly.
  let pre = 0;
  while (pre < base.length && pre < cur.length && base[pre] === cur[pre]) pre++;
  let suf = 0;
  while (
    suf < base.length - pre &&
    suf < cur.length - pre &&
    base[base.length - 1 - suf] === cur[cur.length - 1 - suf]
  ) {
    suf++;
  }
  const baseMid = base.slice(pre, base.length - suf);
  const curMid = cur.slice(pre, cur.length - suf);
  if (baseMid.length === 0 && curMid.length === 0) return [];

  const changes = diffArrays(baseMid, curMid, { timeout: DIFF_TIMEOUT_MS }) as
    | { added?: boolean; removed?: boolean; value: string[] }[]
    | undefined;
  if (!changes) {
    // Diff gave up (pathologically different input): one hunk covering the changed middle.
    return [{ curStart: pre, curLines: curMid.map(stripNl), baseStart: pre, baseLines: baseMid.map(stripNl) }];
  }

  const hunks: Hunk[] = [];
  let bi = pre;
  let ci = pre;
  let open: Hunk | undefined;
  for (const part of changes) {
    const n = part.value.length;
    if (!part.added && !part.removed) {
      if (open) hunks.push(open);
      open = undefined;
      bi += n;
      ci += n;
      continue;
    }
    if (!open) open = { curStart: ci, curLines: [], baseStart: bi, baseLines: [] };
    if (part.removed) {
      open.baseLines.push(...part.value.map(stripNl));
      bi += n;
    } else {
      open.curLines.push(...part.value.map(stripNl));
      ci += n;
    }
  }
  if (open) hunks.push(open);
  return hunks;
}

export function stats(hunks: readonly Hunk[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    added += h.curLines.length;
    removed += h.baseLines.length;
  }
  return { added, removed };
}

/** Stable-ish identity of a hunk, used to find it again after a recompute (CodeLens args). */
export function hunkFingerprint(h: Hunk): string {
  return `${h.curStart}:${h.curLines.length}:${h.baseStart}:${h.baseLines.length}`;
}

export function findHunk(hunks: readonly Hunk[], fingerprint: string): Hunk | undefined {
  return hunks.find((h) => hunkFingerprint(h) === fingerprint);
}

/** Replace tokens [start, start+count) of `tokens` with `replacement`. */
function splice(tokens: string[], start: number, count: number, replacement: string[]): string[] {
  return [...tokens.slice(0, start), ...replacement, ...tokens.slice(start + count)];
}

/**
 * Tokens of one side of a hunk, with terminators restored. The only token that can lack "\n" is the
 * last token of the whole text, so we read the real tokens instead of re-adding "\n" blindly.
 */
function sideTokens(text: string, start: number, count: number): string[] {
  return tokenize(text).slice(start, start + count);
}

/**
 * "Keep" one hunk: the new baseline is the old baseline with this hunk's baseline lines replaced by
 * its current lines. Returned with the baseline's EOL style.
 */
export function acceptHunk(baseText: string, curText: string, hunk: Hunk): string {
  const eol = detectEol(baseText, detectEol(curText));
  const next = splice(
    tokenize(baseText),
    hunk.baseStart,
    hunk.baseLines.length,
    sideTokens(curText, hunk.curStart, hunk.curLines.length),
  ).join('');
  return eol === '\n' ? next : next.replace(/\n/g, '\r\n');
}

/** "Undo" one hunk on a text: restore its baseline lines in place. Returned with the current EOL style. */
export function revertHunk(baseText: string, curText: string, hunk: Hunk): string {
  const eol = detectEol(curText, detectEol(baseText));
  const next = splice(
    tokenize(curText),
    hunk.curStart,
    hunk.curLines.length,
    sideTokens(baseText, hunk.baseStart, hunk.baseLines.length),
  ).join('');
  return eol === '\n' ? next : next.replace(/\n/g, '\r\n');
}

export interface LineRangeEdit {
  /** Start position (line, character 0 unless `startAtEndOfLine`). */
  startLine: number;
  startChar: number;
  /** End position. */
  endLine: number;
  endChar: number;
  /** Replacement text using `eol`. */
  text: string;
}

/**
 * The same revert as `revertHunk`, expressed as a single range replacement on the current document, so
 * the editor can apply it as a WorkspaceEdit (keeps Ctrl+Z working and leaves the rest untouched).
 *
 * `lineLengths` are the lengths of the current document's lines (without EOL), as the editor sees them.
 */
export function revertEdit(baseText: string, curText: string, hunk: Hunk, lineLengths: readonly number[], eol: Eol): LineRangeEdit {
  const cur = tokenize(curText);
  const baseSide = sideTokens(baseText, hunk.baseStart, hunk.baseLines.length);
  const start = hunk.curStart;
  const end = hunk.curStart + hunk.curLines.length; // exclusive token index
  const lastLine = lineLengths.length - 1;

  // Token i always starts at (line i, char 0). A token before `start` can't lack its "\n" (only the
  // very last token can, and an unterminated last token never equals its terminated counterpart, so it
  // would have been part of the hunk), so the start position always exists.
  let endLine: number;
  let endChar: number;
  if (end < cur.length || (end === cur.length && cur.length > 0 && cur[cur.length - 1].endsWith('\n'))) {
    // The range ends at the start of a line that exists (possibly the empty line after a final "\n").
    endLine = end;
    endChar = 0;
  } else {
    // The hunk runs to the very end of a document without a final newline (or the document is empty).
    endLine = lastLine;
    endChar = lineLengths[lastLine] ?? 0;
  }

  let text = baseSide.join('');
  if (eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  return { startLine: start, startChar: 0, endLine, endChar, text };
}

/** Apply a LineRangeEdit to a text (used by tests to prove `revertEdit` matches `revertHunk`). */
export function applyLineRangeEdit(text: string, edit: LineRangeEdit, eol: Eol): string {
  const lines = text.split(eol);
  const offsetOf = (line: number, ch: number): number => {
    let off = 0;
    for (let i = 0; i < line; i++) off += lines[i].length + eol.length;
    return off + ch;
  };
  const a = offsetOf(edit.startLine, edit.startChar);
  const b = offsetOf(edit.endLine, edit.endChar);
  return text.slice(0, a) + edit.text + text.slice(b);
}

export type ContentKind = 'text' | 'binary' | 'large';

export function classifyContent(data: Uint8Array | undefined): ContentKind {
  if (!data) return 'text';
  if (data.byteLength > MAX_DIFF_BYTES) return 'large';
  const n = Math.min(data.byteLength, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (data[i] === 0) return 'binary';
  return 'text';
}

/** Equal after EOL normalization. */
export function sameText(a: string, b: string): boolean {
  return normalizeEol(a) === normalizeEol(b);
}
