// Merging the Claude Changes PreToolUse hook into <workspace>/.claude/settings.json, and the matching
// .gitignore entry. Pure logic – no `vscode` import – so it can be unit-tested.
//
// Rules: never drop or reorder anything that is already there, never add a duplicate handler, and
// refuse to touch a settings file we can't parse (rather than overwriting it).

export const HOOK_SCRIPT_REL = '.claude/hooks/claude-changes-snapshot.js';
export const HOOK_MARKER = 'claude-changes-snapshot.js';
export const HOOK_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';
export const GITIGNORE_ENTRY = '.claude/review/';
export const GITIGNORE_COMMENT = '# Claude Changes review data (snapshots of files before Claude edited them)';

export interface HookHandler {
  type: 'command';
  command: string;
  args?: string[];
  timeout?: number;
  [key: string]: unknown;
}

/**
 * The handler we install. Shell form, because exec form (`args`) is only understood by recent Claude
 * Code releases – older ones silently run `command` without the args. In shell form, newer releases
 * substitute ${CLAUDE_PROJECT_DIR} themselves and older ones leave it to the shell, which expands the
 * environment variable of the same name; the quotes keep paths with spaces intact either way.
 */
export function ourHandler(): HookHandler {
  return {
    type: 'command',
    command: 'node "${CLAUDE_PROJECT_DIR}/' + HOOK_SCRIPT_REL + '"',
    timeout: 10,
  };
}

type Json = Record<string, unknown>;

export type ParseResult = { ok: true; settings: Json; indent: string | number } | { ok: false; error: string };

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function detectIndent(text: string): string | number {
  const m = /^([ \t]+)\S/m.exec(text);
  if (!m) return 2;
  return m[1].includes('\t') ? '\t' : m[1].length;
}

/** Parse settings.json text. Missing or blank → empty object. Anything we can't safely merge → error. */
export function parseSettings(text: string | undefined): ParseResult {
  if (text === undefined || text.trim() === '') return { ok: true, settings: {}, indent: 2 };
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    return { ok: false, error: `settings.json is not valid JSON (${(err as Error).message})` };
  }
  if (!isObject(data)) return { ok: false, error: 'settings.json does not contain a JSON object' };
  if (data.hooks !== undefined && !isObject(data.hooks)) {
    return { ok: false, error: '"hooks" in settings.json is not an object' };
  }
  const pre = isObject(data.hooks) ? data.hooks.PreToolUse : undefined;
  if (pre !== undefined && !Array.isArray(pre)) {
    return { ok: false, error: '"hooks.PreToolUse" in settings.json is not an array' };
  }
  return { ok: true, settings: data, indent: detectIndent(text) };
}

export function serializeSettings(settings: Json, indent: string | number = 2): string {
  return JSON.stringify(settings, null, indent) + '\n';
}

function isOurHandler(h: unknown): boolean {
  if (!isObject(h)) return false;
  const parts = [h.command, ...(Array.isArray(h.args) ? h.args : [])];
  return parts.some((p) => typeof p === 'string' && p.includes(HOOK_MARKER));
}

function preToolUse(settings: Json): unknown[] | undefined {
  const hooks = settings.hooks;
  if (!isObject(hooks) || !Array.isArray(hooks.PreToolUse)) return undefined;
  return hooks.PreToolUse;
}

export function isHookInstalled(settings: Json): boolean {
  const groups = preToolUse(settings);
  if (!groups) return false;
  return groups.some((g) => isObject(g) && Array.isArray(g.hooks) && g.hooks.some(isOurHandler));
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Add our PreToolUse group, or bring an existing handler of ours up to date in place (keeping its
 * position and any extra fields the user added). Returns a new object; the input is not mutated.
 */
export function addHook(settings: Json): { settings: Json; changed: boolean } {
  if (isHookInstalled(settings)) {
    const next = structuredClone(settings);
    let changed = false;
    for (const g of preToolUse(next) ?? []) {
      if (!isObject(g) || !Array.isArray(g.hooks)) continue;
      g.hooks = g.hooks.map((h) => {
        if (!isOurHandler(h)) return h;
        const { args: _args, ...rest } = h as Json;
        const updated = { ...rest, ...ourHandler() };
        if (sameJson(updated, h)) return h;
        changed = true;
        return updated;
      });
    }
    return changed ? { settings: next, changed } : { settings, changed: false };
  }
  const next = structuredClone(settings);
  const hooks: Json = isObject(next.hooks) ? next.hooks : {};
  const groups: unknown[] = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  groups.push({ matcher: HOOK_MATCHER, hooks: [ourHandler()] });
  hooks.PreToolUse = groups;
  next.hooks = hooks;
  return { settings: next, changed: true };
}

/** Remove only our handler; prune groups/arrays/objects that become empty because of it. */
export function removeHook(settings: Json): { settings: Json; changed: boolean } {
  if (!isHookInstalled(settings)) return { settings, changed: false };
  const next = structuredClone(settings);
  const hooks = next.hooks as Json;
  const groups = (hooks.PreToolUse as unknown[])
    .map((g) => {
      if (!isObject(g) || !Array.isArray(g.hooks) || !g.hooks.some(isOurHandler)) return g;
      const remaining = g.hooks.filter((h) => !isOurHandler(h));
      return remaining.length ? { ...g, hooks: remaining } : undefined;
    })
    .filter((g) => g !== undefined);
  if (groups.length) hooks.PreToolUse = groups;
  else delete hooks.PreToolUse;
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return { settings: next, changed: true };
}

// ---------------------------------------------------------------------------------------------
// .gitignore
// ---------------------------------------------------------------------------------------------

function gitignoreCovers(line: string): boolean {
  const l = line.trim().replace(/^\//, '');
  return ['.claude/review', '.claude/review/', '.claude/review/**', '.claude', '.claude/', '.claude/**'].includes(l);
}

export function addGitignoreEntry(text: string): { text: string; changed: boolean } {
  const lines = text.split(/\r?\n/);
  if (lines.some(gitignoreCovers)) return { text, changed: false };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let out = text;
  if (out.length && !out.endsWith('\n')) out += eol;
  if (out.length) out += eol;
  out += GITIGNORE_COMMENT + eol + GITIGNORE_ENTRY + eol;
  return { text: out, changed: true };
}

/** Remove only the block we added (comment + entry); a user-written entry is left alone. */
export function removeGitignoreEntry(text: string): { text: string; changed: boolean } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l, idx) => l.trim() === GITIGNORE_COMMENT && lines[idx + 1]?.trim() === GITIGNORE_ENTRY);
  if (i === -1) return { text, changed: false };
  let start = i;
  // Also remove the blank separator line we inserted before the block.
  if (start > 0 && lines[start - 1].trim() === '') start--;
  lines.splice(start, i + 2 - start);
  return { text: lines.join(eol), changed: true };
}
