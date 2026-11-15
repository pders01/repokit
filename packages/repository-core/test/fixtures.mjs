import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function git(cwd, ...args) {
  const result = spawnSync('git', ['--no-replace-objects', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout.trim();
}

export async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), 'repository-core-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Repository Test');
  git(root, 'config', 'user.email', 'repository@example.test');
  return root;
}

export async function commit(root, message) {
  git(root, 'add', '.');
  git(root, 'commit', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

export async function fakeGit(t, source) {
  const root = await mkdtemp(join(tmpdir(), 'repository-core-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, 'fake.mjs');
  await writeFile(script, source);
  // The fake replaces only this test's PATH. exec leaves one owned child, no
  // process discovery, listeners, detached descendants or cleanup by prefix.
  await writeFile(join(root, 'git'), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${root}:${oldPath ?? '/usr/bin:/bin'}`;
  t.after(() => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  });
  return root;
}
