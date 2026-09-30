import { describe, expect, it } from 'vitest';
import {
  addGitignoreEntry,
  addHook,
  GITIGNORE_ENTRY,
  HOOK_MATCHER,
  isHookInstalled,
  ourGroups,
  ourHandler,
  parseSettings,
  removeGitignoreEntry,
  removeHook,
  serializeSettings,
  SHELL_MATCHER,
} from '../src/core/settingsMerge';

const otherGroup = {
  matcher: 'Bash',
  hooks: [{ type: 'command', command: '${CLAUDE_PROJECT_DIR}/.claude/hooks/block-rm.sh' }],
};

describe('parseSettings', () => {
  it('treats a missing or blank file as empty settings', () => {
    expect(parseSettings(undefined)).toEqual({ ok: true, settings: {}, indent: 2 });
    expect(parseSettings('  \n')).toMatchObject({ ok: true, settings: {} });
  });

  it('refuses invalid JSON and unexpected shapes instead of overwriting', () => {
    expect(parseSettings('{ "permissions": ')).toMatchObject({ ok: false });
    expect(parseSettings('// comment\n{}')).toMatchObject({ ok: false });
    expect(parseSettings('[]')).toMatchObject({ ok: false });
    expect(parseSettings('{"hooks": []}')).toMatchObject({ ok: false });
    expect(parseSettings('{"hooks": {"PreToolUse": {}}}')).toMatchObject({ ok: false });
  });

  it('detects the existing indentation', () => {
    expect(parseSettings('{\n    "a": 1\n}')).toMatchObject({ ok: true, indent: 4 });
    expect(parseSettings('{\n\t"a": 1\n}')).toMatchObject({ ok: true, indent: '\t' });
  });

  it('accepts a UTF-8 BOM', () => {
    expect(parseSettings('﻿{"a":1}')).toMatchObject({ ok: true, settings: { a: 1 } });
  });
});

describe('addHook', () => {
  it('adds our PreToolUse, PostToolUse and Stop groups to empty settings', () => {
    const { settings, changed } = addHook({});
    expect(changed).toBe(true);
    expect(settings).toEqual({
      hooks: {
        PreToolUse: [{ matcher: HOOK_MATCHER, hooks: [ourHandler()] }],
        PostToolUse: [{ matcher: SHELL_MATCHER, hooks: [ourHandler()] }],
        Stop: [{ hooks: [ourHandler()] }],
      },
    });
    expect(HOOK_MATCHER).toBe('Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell');
    expect(isHookInstalled(settings)).toBe(true);
  });

  it('preserves unrelated settings, other events and other groups (appending ours)', () => {
    const post = { matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier' }] };
    const input = {
      permissions: { allow: ['Bash(npm test)'] },
      env: { FOO: '1' },
      hooks: { PostToolUse: [post], PreToolUse: [otherGroup], Notification: [{ hooks: [{ type: 'command', command: 'beep' }] }] },
    };
    const snapshot = structuredClone(input);
    const { settings } = addHook(input);
    expect(input).toEqual(snapshot); // input not mutated
    expect(settings.permissions).toEqual(input.permissions);
    expect(settings.env).toEqual(input.env);
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toEqual([otherGroup, ourGroups().PreToolUse]);
    expect(hooks.PostToolUse).toEqual([post, ourGroups().PostToolUse]);
    expect(hooks.Stop).toEqual([ourGroups().Stop]);
    expect(hooks.Notification).toEqual(input.hooks.Notification);
  });

  it('does not add a duplicate when already installed', () => {
    const once = addHook({}).settings;
    const twice = addHook(once);
    expect(twice.changed).toBe(false);
    expect(twice.settings).toBe(once);
    const hooks = twice.settings.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PostToolUse).toHaveLength(1);
    expect(hooks.Stop).toHaveLength(1);
  });

  it('installs a shell-form command that quotes the project dir', () => {
    expect(ourHandler().command).toBe('node "${CLAUDE_PROJECT_DIR}/.claude/hooks/claude-changes-snapshot.js"');
    expect(ourHandler().args).toBeUndefined();
  });

  it('migrates an older install (exec form, file tools only) without duplicating', () => {
    const legacy = {
      hooks: {
        PreToolUse: [
          otherGroup,
          {
            matcher: 'Edit|Write|MultiEdit|NotebookEdit',
            hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/.claude/hooks/claude-changes-snapshot.js'] }],
          },
        ],
      },
    };
    expect(isHookInstalled(legacy)).toBe(true);
    const { settings, changed } = addHook(legacy);
    expect(changed).toBe(true);
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toEqual([otherGroup, ourGroups().PreToolUse]);
    expect(hooks.PostToolUse).toEqual([ourGroups().PostToolUse]);
    expect(hooks.Stop).toEqual([ourGroups().Stop]);
    expect(addHook(settings).changed).toBe(false);
  });

  it('pulls our handler out of a shared group but keeps the other handler there', () => {
    const shared = {
      hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'lint.sh' }, ourHandler()] }] },
    };
    const hooks = addHook(shared).settings.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toEqual([
      { matcher: 'Edit', hooks: [{ type: 'command', command: 'lint.sh' }] },
      ourGroups().PreToolUse,
    ]);
  });

  it('refuses a settings file whose hook events are not arrays', () => {
    expect(parseSettings('{"hooks": {"Stop": {}}}')).toMatchObject({ ok: false });
  });

  it('round-trips through serialize/parse', () => {
    const text = serializeSettings(addHook({ model: 'opus' }).settings, 2);
    const parsed = parseSettings(text);
    expect(parsed.ok && isHookInstalled(parsed.settings)).toBe(true);
    expect(parsed.ok && addHook(parsed.settings).changed).toBe(false);
    expect(text.endsWith('\n')).toBe(true);
  });
});

describe('removeHook', () => {
  it('removes our group and prunes empty containers', () => {
    const installed = addHook({ model: 'opus' }).settings;
    const { settings, changed } = removeHook(installed);
    expect(changed).toBe(true);
    expect(settings).toEqual({ model: 'opus' });
  });

  it('leaves other hooks and events untouched', () => {
    const installed = addHook({
      hooks: { PreToolUse: [otherGroup], Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }] },
    }).settings;
    const { settings } = removeHook(installed);
    expect(settings).toEqual({
      hooks: { PreToolUse: [otherGroup], Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }] },
    });
  });

  it('only removes our handler from a group shared with another handler', () => {
    const shared = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Edit|Write',
            hooks: [ourHandler(), { type: 'command', command: 'lint.sh' }],
          },
        ],
      },
    };
    const { settings } = removeHook(shared);
    expect(settings).toEqual({
      hooks: { PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'lint.sh' }] }] },
    });
  });

  it('is a no-op when not installed', () => {
    expect(removeHook({ a: 1 })).toEqual({ settings: { a: 1 }, changed: false });
  });
});

describe('.gitignore', () => {
  it('appends the entry once', () => {
    const first = addGitignoreEntry('node_modules/\n');
    expect(first.changed).toBe(true);
    expect(first.text).toContain(`\n${GITIGNORE_ENTRY}\n`);
    expect(addGitignoreEntry(first.text).changed).toBe(false);
  });

  it('handles a file without a trailing newline and CRLF files', () => {
    expect(addGitignoreEntry('dist').text.startsWith('dist\n\n')).toBe(true);
    const crlf = addGitignoreEntry('dist\r\n').text;
    expect(crlf).toContain(`\r\n${GITIGNORE_ENTRY}\r\n`);
    expect(crlf).not.toMatch(/[^\r]\n/);
  });

  it('does not add when .claude/ is already ignored', () => {
    expect(addGitignoreEntry('.claude/\n').changed).toBe(false);
    expect(addGitignoreEntry('/.claude/review\n').changed).toBe(false);
  });

  it('removes exactly what it added', () => {
    const original = 'node_modules/\ndist/\n';
    const added = addGitignoreEntry(original).text;
    const removed = removeGitignoreEntry(added);
    expect(removed.changed).toBe(true);
    expect(removed.text).toBe(original);
  });

  it('leaves a user-written entry alone', () => {
    expect(removeGitignoreEntry('.claude/review/\n')).toEqual({ text: '.claude/review/\n', changed: false });
  });
});
