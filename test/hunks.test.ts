import { describe, expect, it } from 'vitest';
import {
  acceptHunk,
  applyLineRangeEdit,
  classifyContent,
  computeHunks,
  detectEol,
  Eol,
  Hunk,
  MAX_DIFF_BYTES,
  revertEdit,
  revertHunk,
  sameText,
  stats,
} from '../src/core/hunks';

/** Line lengths as an editor would report them for `text`. */
function lineLengths(text: string, eol: Eol): number[] {
  return text.split(eol).map((l) => l.length);
}

/** Revert via the editor-style range edit, and assert it matches the pure text revert. */
function revertViaEdit(base: string, rawCur: string, h: Hunk): string {
  const eol = detectEol(rawCur, detectEol(base));
  // Like VS Code, the simulated editor document uses a single EOL throughout.
  const cur = rawCur.replace(/\r?\n/g, eol);
  const edit = revertEdit(base, cur, h, lineLengths(cur, eol), eol);
  const viaEdit = applyLineRangeEdit(cur, edit, eol);
  expect(viaEdit).toBe(revertHunk(base, cur, h));
  return viaEdit;
}

/** Undoing every hunk (last first, so indices stay valid) must yield the baseline. */
function undoAll(base: string, cur: string): string {
  let text = cur;
  for (const h of [...computeHunks(base, cur)].reverse()) text = revertViaEdit(base, text, h);
  return text;
}

/** Keeping every hunk (last first) must turn the baseline into the current text. */
function keepAll(base: string, cur: string): string {
  let b = base;
  for (const h of [...computeHunks(base, cur)].reverse()) b = acceptHunk(b, cur, h);
  return b;
}

describe('computeHunks', () => {
  it('returns nothing for identical text', () => {
    expect(computeHunks('a\nb\n', 'a\nb\n')).toEqual([]);
    expect(computeHunks('', '')).toEqual([]);
  });

  it('detects a modified line in the middle', () => {
    expect(computeHunks('a\nb\nc\n', 'a\nB\nc\n')).toEqual([
      { curStart: 1, curLines: ['B'], baseStart: 1, baseLines: ['b'] },
    ]);
  });

  it('handles an edit on the first line', () => {
    const h = computeHunks('first\nb\nc\n', 'FIRST\nb\nc\n');
    expect(h).toEqual([{ curStart: 0, curLines: ['FIRST'], baseStart: 0, baseLines: ['first'] }]);
  });

  it('handles an edit on the last line', () => {
    const h = computeHunks('a\nb\nlast\n', 'a\nb\nLAST\n');
    expect(h).toEqual([{ curStart: 2, curLines: ['LAST'], baseStart: 2, baseLines: ['last'] }]);
  });

  it('handles lines added at the start and appended at the end', () => {
    expect(computeHunks('a\n', 'x\na\n')).toEqual([{ curStart: 0, curLines: ['x'], baseStart: 0, baseLines: [] }]);
    expect(computeHunks('a\n', 'a\ny\nz\n')).toEqual([
      { curStart: 1, curLines: ['y', 'z'], baseStart: 1, baseLines: [] },
    ]);
  });

  it('handles pure deletions, including at the end', () => {
    expect(computeHunks('a\nb\nc\n', 'a\nc\n')).toEqual([{ curStart: 1, curLines: [], baseStart: 1, baseLines: ['b'] }]);
    expect(computeHunks('a\nb\nc\n', 'a\n')).toEqual([
      { curStart: 1, curLines: [], baseStart: 1, baseLines: ['b', 'c'] },
    ]);
  });

  it('treats a new file as one all-added hunk', () => {
    const h = computeHunks('', 'one\ntwo\n');
    expect(h).toEqual([{ curStart: 0, curLines: ['one', 'two'], baseStart: 0, baseLines: [] }]);
    expect(stats(h)).toEqual({ added: 2, removed: 0 });
  });

  it('keeps hunks separated by one unchanged line apart', () => {
    const h = computeHunks('a\nb\nc\n', 'A\nb\nC\n');
    expect(h).toHaveLength(2);
    expect(h[0]).toMatchObject({ curStart: 0, curLines: ['A'], baseLines: ['a'] });
    expect(h[1]).toMatchObject({ curStart: 2, curLines: ['C'], baseLines: ['c'] });
  });

  it('shows a changed missing final newline on the last line only', () => {
    const h = computeHunks('a\nb\n', 'a\nb');
    expect(h).toEqual([{ curStart: 1, curLines: ['b'], baseStart: 1, baseLines: ['b'] }]);
  });

  it('ignores CRLF vs LF differences entirely', () => {
    const base = 'one\r\ntwo\r\nthree\r\n';
    expect(computeHunks(base, 'one\ntwo\nthree\n')).toEqual([]);
    // A CRLF file edited with LF line endings only shows the real edit.
    const h = computeHunks(base, 'one\r\nTWO\ntwo and a half\nthree\r\n');
    expect(h).toEqual([{ curStart: 1, curLines: ['TWO', 'two and a half'], baseStart: 1, baseLines: ['two'] }]);
    expect(sameText(base, 'one\ntwo\nthree\n')).toBe(true);
  });
});

describe('ambiguous insertions/deletions are placed like VS Code places them', () => {
  it('removes the whole indented block rather than straddling a closing tag', () => {
    const base = [
      '      </dl>',
      '    </div>',
      '    <div className="mt-6 bg-yellow p-5">',
      '      <p>{venue.name}</p>',
      '    </div>',
      '    <p className="text-sm">{address}</p>',
      '',
    ].join('\n');
    const cur = ['      </dl>', '    </div>', '    <p className="text-sm">{address}</p>', ''].join('\n');
    expect(computeHunks(base, cur)).toEqual([
      {
        curStart: 2,
        curLines: [],
        baseStart: 2,
        baseLines: ['    <div className="mt-6 bg-yellow p-5">', '      <p>{venue.name}</p>', '    </div>'],
      },
    ]);
  });

  it('places an inserted function after the closing brace, not inside it', () => {
    const base = 'function a() {\n  return 1;\n}\n';
    const cur = 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n';
    const [h] = computeHunks(base, cur);
    expect(h.curLines[h.curLines.length - 1]).toBe('}');
    expect(h.curLines[0]).toBe('');
    expect(sameText(undoAll(base, cur), base)).toBe(true);
  });

  it('never moves a hunk into its neighbour', () => {
    const base = 'x\nx\nx\ny\nx\nx\n';
    const cur = 'x\nx\ny\nx\n';
    const hunks = computeHunks(base, cur);
    for (let i = 1; i < hunks.length; i++) {
      expect(hunks[i].baseStart).toBeGreaterThanOrEqual(hunks[i - 1].baseStart + hunks[i - 1].baseLines.length);
      expect(hunks[i].curStart).toBeGreaterThanOrEqual(hunks[i - 1].curStart + hunks[i - 1].curLines.length);
    }
    expect(sameText(undoAll(base, cur), base)).toBe(true);
    expect(sameText(keepAll(base, cur), cur)).toBe(true);
  });
});

describe('revert (per-hunk undo)', () => {
  const cases: [string, string, string][] = [
    ['middle', 'a\nb\nc\n', 'a\nB\nc\n'],
    ['first line', 'a\nb\nc\n', 'A\nb\nc\n'],
    ['last line', 'a\nb\nc\n', 'a\nb\nC\n'],
    ['prepend', 'a\nb\n', 'x\ny\na\nb\n'],
    ['append', 'a\nb\n', 'a\nb\nx\n'],
    ['delete at start', 'a\nb\nc\n', 'b\nc\n'],
    ['delete at end', 'a\nb\nc\n', 'a\n'],
    ['delete everything', 'a\nb\n', ''],
    ['new file', '', 'x\ny\n'],
    ['adjacent hunks', 'a\nb\nc\nd\ne\n', 'A\nb\nC\nd\nE\n'],
    ['final newline removed', 'a\nb\n', 'a\nb'],
    ['final newline added', 'a\nb', 'a\nb\n'],
    ['no final newline, last line edited', 'a\nb', 'a\nB'],
    ['no final newline, line appended', 'a\nb', 'a\nb\nc'],
    ['CRLF file', 'a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\nd\r\n'],
    ['CRLF file edited with LF', 'a\r\nb\r\nc\r\n', 'a\r\nB\nc\r\n'],
  ];

  it.each(cases)('undo every hunk restores the baseline: %s', (_name, base, cur) => {
    expect(sameText(undoAll(base, cur), base)).toBe(true);
  });

  it.each(cases)('keep every hunk makes the baseline equal the current text: %s', (_name, base, cur) => {
    expect(sameText(keepAll(base, cur), cur)).toBe(true);
  });

  it('undoes one of two adjacent hunks and leaves the other', () => {
    const base = 'a\nb\nc\n';
    const cur = 'A\nb\nC\n';
    const [first, second] = computeHunks(base, cur);
    const afterFirst = revertViaEdit(base, cur, first);
    expect(afterFirst).toBe('a\nb\nC\n');
    expect(computeHunks(base, afterFirst)).toEqual([{ ...second }]);

    const afterSecond = revertViaEdit(base, cur, second);
    expect(afterSecond).toBe('A\nb\nc\n');
  });

  it('undoes a hunk at the start of the file', () => {
    const base = 'header\nbody\n';
    const cur = 'HEADER\nextra\nbody\n';
    const [h] = computeHunks(base, cur);
    expect(revertViaEdit(base, cur, h)).toBe(base);
  });

  it('undoes a hunk at the end of a file without a final newline', () => {
    const base = 'a\nb';
    const cur = 'a\nb\nc';
    const [h] = computeHunks(base, cur);
    expect(revertViaEdit(base, cur, h)).toBe(base);
  });

  it('keeps CRLF line endings when undoing in a CRLF document', () => {
    const base = 'a\r\nb\r\nc\r\n';
    const cur = 'a\r\nB\r\nX\r\nc\r\n';
    const [h] = computeHunks(base, cur);
    expect(revertViaEdit(base, cur, h)).toBe(base);
  });
});

describe('acceptHunk (per-hunk keep)', () => {
  it('moves only that hunk into the baseline', () => {
    const base = 'a\nb\nc\n';
    const cur = 'A\nb\nC\n';
    const [first, second] = computeHunks(base, cur);
    const newBase = acceptHunk(base, cur, first);
    expect(newBase).toBe('A\nb\nc\n');
    const remaining = computeHunks(newBase, cur);
    expect(remaining).toEqual([second]);
  });

  it('keeps the baseline EOL style', () => {
    const base = 'a\r\nb\r\n';
    const cur = 'a\nB\n';
    const [h] = computeHunks(base, cur);
    expect(acceptHunk(base, cur, h)).toBe('a\r\nB\r\n');
  });
});

describe('classifyContent', () => {
  it('detects text, binary and large content', () => {
    expect(classifyContent(new TextEncoder().encode('hello\n'))).toBe('text');
    expect(classifyContent(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))).toBe('binary');
    expect(classifyContent(new Uint8Array(MAX_DIFF_BYTES + 1))).toBe('large');
    expect(classifyContent(undefined)).toBe('text');
  });
});
