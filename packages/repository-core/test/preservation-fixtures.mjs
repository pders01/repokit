import { spawnSync } from 'node:child_process';

// Like fixtures.mjs's git helper, but accepts stdin for trees and messages too
// large for argv. Every caller owns a disposable repository; inherit no Git,
// home/config, credentials or annotation-store environment from the host.
export function syntheticGit(cwd, args, input) {
  const result = spawnSync('git', ['--no-replace-objects', ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      XDG_CONFIG_HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_LAZY_FETCH: '1',
      LC_ALL: 'C',
    },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout.trim();
}
