import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runGit, withGitBudget, assertGitBudget } from '@jpahd/repository-core/git';
import { fakeGit, repository } from './fixtures.mjs';
import { listRepositoryRefs } from '@jpahd/repository-core';

// The fake executable uses a POSIX exec wrapper; actual repository reads are
// otherwise exercised independently under native Node.
const posix = { skip: process.platform === 'win32' };

test('bounded stdout/stderr, argument controls and isolated Git environment', posix, async (t) => {
  const root = await fakeGit(t, `
    import assert from 'node:assert/strict';
    assert.deepEqual(process.argv.slice(2), ['--no-replace-objects', '-c', 'core.quotepath=false', '--no-pager', '--fixture']);
    assert.equal(process.env.GIT_DIR, undefined);
    assert.equal(process.env.GIT_CONFIG_COUNT, undefined);
    for (const key of ['GIT_NO_LAZY_FETCH', 'GIT_NO_REPLACE_OBJECTS', 'GIT_CONFIG_NOSYSTEM']) assert.equal(process.env[key], '1');
    for (const key of ['GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT']) assert.equal(process.env[key], '0');
    assert.equal(process.env.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(process.env.GIT_CONFIG_SYSTEM, '/dev/null');
    assert.equal(process.env.LC_ALL, 'C');
    await new Promise((resolve) => process.stdout.write('o'.repeat(100000), resolve));
    await new Promise((resolve) => process.stderr.write('e'.repeat(100000), resolve));
  `);
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT };
  process.env.GIT_DIR = 'not-inherited';
  process.env.GIT_CONFIG_COUNT = 'invalid';
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const result = await runGit(root, ['--fixture'], 31);
  assert.equal(result.exitCode, 0, result.stderr.slice(0, 500));
  assert.equal(result.stdout, 'o'.repeat(31));
  assert.equal(result.bytes.length, 31);
  assert.equal(result.stderr.length, 64 * 1024);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
  assert.equal(result.truncated, true);
  assert.equal(result.timedOut, false);
});

test('default metadata cap and zero-byte cap drain the child', posix, async (t) => {
  const root = await fakeGit(t, `for (let i=0; i<130; i++) await new Promise((resolve) => process.stdout.write('a'.repeat(65536), resolve));`);
  const result = await runGit(root, []);
  assert.equal(result.bytes.length, 8 * 1024 * 1024);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.exitCode, 0);
  const zero = await runGit(root, [], 0);
  assert.equal(zero.bytes.length, 0);
  assert.equal(zero.stdoutTruncated, true);
  assert.equal(zero.exitCode, 0);
});

test('deadline kills and awaits only the owned child and latches the aggregate budget', posix, async (t) => {
  const root = await fakeGit(t, `import { writeSync } from 'node:fs'; writeSync(1, 'ready'); setInterval(() => {}, 1000);`);
  let result;
  await assert.rejects(withGitBudget(async () => {
    result = await runGit(root, [], 16);
  }, { timeoutMs: 700, commands: 1 }), /work budget exceeded/);
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.stdout, 'ready');
});

test('aggregate commands, cached deadlines and concurrent budgets remain independent', async (t) => {
  const root = await repository(t);
  await assert.rejects(withGitBudget(async () => {
    await runGit(root, ['--version'], 256);
    try { await runGit(root, ['--version'], 256); } catch { /* latched */ }
  }, { timeoutMs: 2000, commands: 1 }), /work budget exceeded/);
  await assert.rejects(withGitBudget(async () => assertGitBudget(), { timeoutMs: 0, commands: 1 }), /work budget exceeded/);
  await assert.rejects(withGitBudget(async () => delay(30), { timeoutMs: 5, commands: 1 }), /work budget exceeded/);
  await Promise.all([0, 1].map(() => withGitBudget(async () => {
    assert.equal((await runGit(root, ['--version'], 256)).exitCode, 0);
  }, { timeoutMs: 2000, commands: 1 })));
});

test('metadata consumers refuse malformed UTF-8 instead of publishing replacement names', posix, async (t) => {
  const root = await fakeGit(t, `process.stdout.write(Buffer.from([0xff]));`);
  await assert.rejects(listRepositoryRefs(root), /UTF-8 without loss/);
});

test('invalid byte limits refuse before spawning', async () => {
  for (const limit of [-1, NaN, Infinity, 1.5]) {
    await assert.rejects(runGit('.', ['--version'], limit), /byte limit/);
  }
});
