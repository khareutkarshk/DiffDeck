// Runs test/integration/suite.js inside a real VS Code, using an isolated profile.
//   node test/integration/run.mjs            (uses `code` from PATH, or CODE_BIN)
// Needs a display (on headless Linux: xvfb-run -a node test/integration/run.mjs).
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'claude-changes-it-'));
const ws = path.join(tmp, 'workspace');

fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
fs.writeFileSync(path.join(ws, 'src/a.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\n');
fs.writeFileSync(path.join(ws, 'crlf.txt'), 'alpha\r\nbeta\r\ngamma\r\n');
fs.writeFileSync(path.join(ws, '.gitignore'), 'node_modules/\n');
fs.writeFileSync(
  path.join(ws, '.claude/settings.json'),
  JSON.stringify(
    {
      permissions: { allow: ['Bash(ls)'] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo ok' }] }] },
    },
    null,
    2,
  ),
);

spawnSync(process.execPath, [path.join(repo, 'esbuild.mjs')], { stdio: 'inherit', cwd: repo });

const bin = process.env.CODE_BIN || (process.platform === 'linux' && fs.existsSync('/usr/share/code/code') ? '/usr/share/code/code' : 'code');
const resultFile = path.join(tmp, 'result.txt');
const args = [
  '--no-sandbox',
  '--disable-gpu',
  '--disable-workspace-trust',
  '--skip-welcome',
  '--skip-release-notes',
  '--disable-extensions',
  `--user-data-dir=${path.join(tmp, 'user-data')}`,
  `--extensions-dir=${path.join(tmp, 'extensions')}`,
  `--extensionDevelopmentPath=${repo}`,
  `--extensionTestsPath=${path.join(repo, 'test/integration/suite.js')}`,
  ws,
];
const child = spawn(bin, args, {
  stdio: 'inherit',
  env: { ...process.env, RESULT_FILE: resultFile, NODE_BIN: process.execPath, ELECTRON_RUN_AS_NODE: undefined },
});
child.on('exit', (code) => {
  if (fs.existsSync(resultFile)) console.log(fs.readFileSync(resultFile, 'utf8'));
  console.log(`VS Code exited with ${code}. Workspace: ${ws}`);
  process.exit(code ?? 1);
});
