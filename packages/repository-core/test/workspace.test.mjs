import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { describe, test } from 'node:test';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  captureWorkspaceDiffs,
  getWorkspaceDiff,
  getWorkspaceFilePreview,
  getWorkspaceStatus,
  listWorkspaceDirectory,
  parseNumstat,
  parsePorcelain,
} from '@jpahd/repository-core/workspace';
import { commit, fakeGit, git, repository } from './fixtures.mjs';

async function createGitWorkspace(t, files) {
  const root = await repository(t);
  for (const [path, content] of Object.entries(files)) {
    const filePath = join(root, path);
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, content);
  }
  await commit(root, 'initial fixture');
  return root;
}

describe('parsePorcelain', () => {
  test('separates staged, unstaged, untracked, and conflicted entries', () => {
    assert.deepEqual(parsePorcelain('M  staged.ts\0 M unstaged.ts\0?? new.ts\0UU conflict.ts\0'), [
      { path: 'staged.ts', fromPath: undefined, status: 'M', bucket: 'staged' },
      { path: 'unstaged.ts', fromPath: undefined, status: 'M', bucket: 'unstaged' },
      { path: 'new.ts', status: '?', bucket: 'untracked' },
      { path: 'conflict.ts', fromPath: undefined, status: 'U', bucket: 'conflicted' },
    ]);
  });

  test('keeps both sides of a partially staged file', () => {
    assert.deepEqual(parsePorcelain('MM src/app.ts\0'), [
      { path: 'src/app.ts', fromPath: undefined, status: 'M', bucket: 'staged' },
      { path: 'src/app.ts', fromPath: undefined, status: 'M', bucket: 'unstaged' },
    ]);
  });

  test('consumes the second nul field for renames', () => {
    assert.deepEqual(parsePorcelain('R  src/new.ts\0src/old.ts\0'), [
      { path: 'src/new.ts', fromPath: 'src/old.ts', status: 'R', bucket: 'staged' },
    ]);
  });

  test('recognizes every unmerged status and preserves control characters in names', () => {
    for (const code of ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']) {
      assert.deepEqual(parsePorcelain(`${code} tab\tline\n.txt\0`), [
        { path: 'tab\tline\n.txt', fromPath: undefined, status: 'U', bucket: 'conflicted' },
      ]);
    }
  });
});

test('parseNumstat reads text counts, rename destinations, and skips binary markers', () => {
  const stats = parseNumstat([
    '3\t2\tsrc/app.ts', '-\t-\tpublic-board.png', '0\t1\t', 'src/old.ts', 'src/new.ts', '',
  ].join('\0'));
  assert.deepEqual([...stats], [
    ['src/app.ts', { additions: 3, deletions: 2 }],
    ['src/new.ts', { additions: 0, deletions: 1 }],
  ]);
});

describe('Git workspace fixtures', () => {
  test('reports renames, partial staging, and untracked files with distinct diffs', async (t) => {
    const root = await createGitWorkspace(t, {
      'src/old-name.ts': "export const name = 'old';\n",
      'src/partial.ts': "export const state = 'base';\n",
    });
    git(root, 'mv', 'src/old-name.ts', 'src/new-name.ts');
    await writeFile(join(root, 'src/partial.ts'), "export const state = 'staged';\n");
    git(root, 'add', 'src/partial.ts');
    await writeFile(join(root, 'src/partial.ts'), "export const state = 'unstaged';\n");
    await writeFile(join(root, 'src/untracked.ts'), 'export const untracked = true;\n');

    const status = await getWorkspaceStatus(root);
    assert.equal(status.isGit, true);
    assert.equal(status.branch, 'main');
    assert.equal(status.head, git(root, 'rev-parse', 'HEAD'));
    assert(status.files.some((file) => {
      assert.equal(typeof file.path, 'string');
      return file.path === 'src/new-name.ts' && file.fromPath === 'src/old-name.ts'
        && file.status === 'R' && file.bucket === 'staged' && file.additions === 0 && file.deletions === 0;
    }));
    assert.deepEqual(status.files.filter((file) => file.path === 'src/partial.ts'), [
      { path: 'src/partial.ts', fromPath: undefined, status: 'M', bucket: 'staged', additions: 1, deletions: 1 },
      { path: 'src/partial.ts', fromPath: undefined, status: 'M', bucket: 'unstaged', additions: 1, deletions: 1 },
    ]);
    assert(status.files.some((file) => file.path === 'src/untracked.ts' && file.status === '?' && file.bucket === 'untracked'));

    const [rename, staged, unstaged, untracked] = await Promise.all([
      getWorkspaceDiff(root, 'src/new-name.ts', 'staged'),
      getWorkspaceDiff(root, 'src/partial.ts', 'staged'),
      getWorkspaceDiff(root, 'src/partial.ts', 'unstaged'),
      getWorkspaceDiff(root, 'src/untracked.ts', 'untracked'),
    ]);
    // A destination-only diff retains the inherited addition view of a rename.
    assert.match(rename.rawDiff, /new file mode/);
    assert.match(rename.rawDiff, /\+\+\+ b\/src\/new-name.ts/);
    assert.match(staged.rawDiff, /state = 'staged'/);
    assert.match(unstaged.rawDiff, /state = 'unstaged'/);
    assert.match(untracked.rawDiff, /new file mode/);
    assert.deepEqual(await captureWorkspaceDiffs(root, join(root, 'src/partial.ts')), [
      { path: 'src/partial.ts', bucket: 'staged', ...staged },
      { path: 'src/partial.ts', bucket: 'unstaged', ...unstaged },
    ]);
    assert.deepEqual(await captureWorkspaceDiffs(root, 'src/untracked.ts'), [
      { path: 'src/untracked.ts', bucket: 'untracked', ...untracked },
    ]);
    assert.deepEqual(await captureWorkspaceDiffs(root, 'absent.txt'), []);
  });

  test('selects literal glob, pathspec-magic, dash and control-character filenames only', async (t) => {
    const names = ['*.txt', 'file[ab].txt', 'file?.txt', ':(glob)*.txt', '-dash.txt', 'tab\tline\n.txt'];
    const root = await createGitWorkspace(t, Object.fromEntries(
      [...names, 'filea.txt', 'sibling.txt'].map((name) => [name, 'base\n']),
    ));
    for (const [index, name] of [...names, 'filea.txt', 'sibling.txt'].entries()) {
      await writeFile(join(root, name), `staged-${index}\n`);
    }
    git(root, 'add', '.');
    for (const [index, name] of [...names, 'filea.txt', 'sibling.txt'].entries()) {
      await writeFile(join(root, name), `unstaged-${index}\n`);
    }
    for (const [index, name] of names.entries()) {
      const captures = await captureWorkspaceDiffs(root, name);
      assert.deepEqual(captures.map(({ path, bucket }) => ({ path, bucket })), [
        { path: name, bucket: 'staged' }, { path: name, bucket: 'unstaged' },
      ]);
      for (const capture of captures) {
        assert.equal(capture.truncated, false);
        assert(capture.rawDiff.includes(`+${capture.bucket}-${index}\n`), name);
        assert.equal((capture.rawDiff.match(/^diff --git /gm) ?? []).length, 1, name);
        assert(!capture.rawDiff.includes('staged-6\n'), name);
        assert(!capture.rawDiff.includes('staged-7\n'), name);
      }
    }
    const untrackedName = ':(glob)untracked*.txt';
    await writeFile(join(root, untrackedName), 'literal untracked\n');
    assert.match((await getWorkspaceDiff(root, untrackedName, 'untracked')).rawDiff, /\+literal untracked/);
  });

  test('returns an inspectable conflict diff', async (t) => {
    const root = await createGitWorkspace(t, { 'conflict.txt': 'base\n' });
    git(root, 'checkout', '-b', 'conflicting-change');
    await writeFile(join(root, 'conflict.txt'), 'branch\n');
    await commit(root, 'change on branch');
    git(root, 'checkout', 'main');
    await writeFile(join(root, 'conflict.txt'), 'main\n');
    await commit(root, 'change on main');
    assert.throws(() => git(root, 'merge', 'conflicting-change'));
    assert.deepEqual((await getWorkspaceStatus(root)).files, [
      { path: 'conflict.txt', fromPath: undefined, status: 'U', bucket: 'conflicted' },
    ]);
    const diff = await getWorkspaceDiff(root, 'conflict.txt', 'conflicted');
    assert.match(diff.rawDiff, /diff --cc conflict.txt/);
    assert.match(diff.rawDiff, /<<<<<<< HEAD/);
    assert.deepEqual(await captureWorkspaceDiffs(root, 'conflict.txt'), [
      { path: 'conflict.txt', bucket: 'conflicted', ...diff },
    ]);
  });

  test('returns Git binary patches without treating them as text hunks', async (t) => {
    const root = await createGitWorkspace(t, { 'image.bin': new Uint8Array([1, 0, 2, 3]) });
    await writeFile(join(root, 'image.bin'), new Uint8Array([4, 0, 5, 6]));
    const diff = await getWorkspaceDiff(root, 'image.bin', 'unstaged');
    assert.equal(diff.truncated, false);
    assert.match(diff.rawDiff, /GIT binary patch/);
    assert(!diff.rawDiff.includes('@@'));
  });

  test('caps oversized text diffs at two MiB', async (t) => {
    const root = await createGitWorkspace(t, { 'large.txt': 'a\n'.repeat(600_000) });
    await writeFile(join(root, 'large.txt'), 'b\n'.repeat(600_000));
    const diff = await getWorkspaceDiff(root, 'large.txt', 'unstaged');
    assert.equal(diff.truncated, true);
    assert.equal(Buffer.byteLength(diff.rawDiff), 2 * 1024 * 1024);
    assert.match(diff.rawDiff, /diff --git a\/large.txt b\/large.txt/);
  });

  test('handles unborn, detached and non-Git workspaces', async (t) => {
    const root = await repository(t);
    const unborn = await getWorkspaceStatus(root);
    assert.equal(unborn.isGit, true);
    assert.equal(unborn.head, undefined);
    await writeFile(join(root, 'file.txt'), 'base\n');
    const head = await commit(root, 'initial');
    git(root, 'checkout', '--detach', head);
    assert.equal((await getWorkspaceStatus(root)).branch, 'detached');
    // Removing metadata affects only this disposable fixture, not the checkout.
    await rm(join(root, '.git'), { recursive: true });
    assert.deepEqual(await getWorkspaceStatus(root), { isGit: false, branch: '', files: [] });
  });
});

describe('workspace file browsing', () => {
  test('lists directories first and omits compatibility/dependency directories', async (t) => {
    const root = await repository(t);
    await Promise.all([
      mkdir(join(root, 'src')), mkdir(join(root, '.pi-webui')), mkdir(join(root, 'node_modules')),
      writeFile(join(root, 'README.md'), 'hello'),
    ]);
    const entries = await listWorkspaceDirectory(root, '');
    assert.deepEqual(entries.map(({ name, type }) => ({ name, type })), [
      { name: 'src', type: 'directory' }, { name: 'README.md', type: 'file' },
    ]);
    // Exclusion is a listing filter, not a protected store or access rule.
    await writeFile(join(root, '.pi-webui', 'synthetic.txt'), 'fixture only');
    assert.equal((await getWorkspaceFilePreview(root, '.pi-webui/synthetic.txt')).content, 'fixture only');
    await symlink(join(root, 'README.md'), join(root, 'readme-link'));
    assert.equal((await listWorkspaceDirectory(root, '.')).find(({ name }) => name === 'readme-link').type, 'symlink');
  });

  test('caps returned directory metadata at 500 entries', async (t) => {
    const root = await repository(t);
    await Promise.all(Array.from({ length: 501 }, (_, index) => writeFile(join(root, `file-${String(index).padStart(3, '0')}`), '')));
    const entries = await listWorkspaceDirectory(root, '.');
    assert.equal(entries.length, 500);
    assert.equal(entries[0].name, 'file-000');
    assert.equal(entries.at(-1).name, 'file-499');
  });

  test('keeps small directory results sorted with metadata and existing exclusions', async (t) => {
    const root = await repository(t);
    for (const [name, files, expected] of [
      ['empty', [], []],
      ['mixed', [['z-dir', null], ['a-dir', null], ['z.txt', 'zz'], ['a.txt', 'a']], [
        ['a-dir', 'directory'], ['z-dir', 'directory'], ['a.txt', 'file', 1], ['z.txt', 'file', 2],
      ]],
      // Exclusions apply to directories, not identically named regular files.
      ['names', [['.git', 'g'], ['node_modules', null], ['.pi-webui', null]], [['.git', 'file', 1]]],
    ]) {
      const directory = join(root, name);
      await mkdir(directory);
      for (const [entry, content] of files) {
        if (content === null) await mkdir(join(directory, entry));
        else await writeFile(join(directory, entry), content);
      }
      const entries = await listWorkspaceDirectory(root, name);
      assert.deepEqual(entries.map(({ name, type, size }) => (
        type === 'directory' ? [name, type] : [name, type, size]
      )), expected);
      assert(entries.every(({ size }) => Number.isInteger(size) && size >= 0));
    }
  });

  test('bounds scanning and concurrent metadata work, counting excluded entries too', async (t) => {
    const root = await repository(t);
    const directory = join(root, 'large-directory');
    await mkdir(directory);
    for (const name of ['.git', '.pi-webui', 'node_modules']) await mkdir(join(directory, name));
    // 4,997 files + 3 excluded directories = exactly 5,000 scanned entries.
    // Reverse creation order so enumeration order is not the result oracle.
    for (let start = 4_996; start >= 0; start -= 16) {
      await Promise.all(Array.from({ length: Math.min(16, start + 1) }, (_, offset) => (
        writeFile(join(directory, `file-${String(start - offset).padStart(4, '0')}`), '')
      )));
    }

    // Observe real Node filesystem requests; no patched APIs or production hooks.
    // FSREQPROMISE includes the directory stat and the result-window lstats.
    async function observeFilesystemWork(operation) {
      const active = new Set();
      let started = 0;
      let peak = 0;
      const hook = createHook({
        init(id, type) {
          if (type !== 'FSREQPROMISE') return;
          active.add(id);
          started++;
          peak = Math.max(peak, active.size);
        },
        before(id) { active.delete(id); },
        destroy(id) { active.delete(id); },
      });
      hook.enable();
      try {
        const value = await operation();
        return { value, started, peak, pending: active.size };
      } finally {
        hook.disable();
      }
    }

    const accepted = await observeFilesystemWork(() => listWorkspaceDirectory(root, 'large-directory'));
    assert.deepEqual(accepted.value.map(({ name, type, size }) => [name, type, size]),
      Array.from({ length: 500 }, (_, index) => [`file-${String(index).padStart(4, '0')}`, 'file', 0]));
    assert(accepted.started >= 500 && accepted.started <= 503, `filesystem requests: ${accepted.started}`);
    assert(accepted.peak > 1 && accepted.peak <= 8, `peak filesystem requests: ${accepted.peak}`);
    assert.equal(accepted.pending, 0);

    await writeFile(join(directory, 'one-too-many'), '');
    const refused = await observeFilesystemWork(() => assert.rejects(
      listWorkspaceDirectory(root, 'large-directory'), /Workspace directory scan limit exceeded \(5000 entries\)/,
    ));
    assert(refused.started <= 3, `refusal must precede result metadata reads: ${refused.started}`);
    assert.equal(refused.pending, 0);
    // A subsequent within-budget call still works after the iterator refused.
    await rm(join(directory, 'one-too-many'));
    assert.deepEqual(await listWorkspaceDirectory(root, 'large-directory'), accepted.value);
  });

  test('returns capped text and explicit binary previews', async (t) => {
    const root = await repository(t);
    await writeFile(join(root, 'large.ts'), 'a'.repeat(256 * 1024 + 1));
    await writeFile(join(root, 'image.bin'), new Uint8Array([1, 0, 2]));
    const text = await getWorkspaceFilePreview(root, join(root, 'large.ts'));
    assert.equal(text.path, 'large.ts');
    assert.equal(text.content.length, 256 * 1024);
    assert.equal(text.size, 256 * 1024 + 1);
    assert.equal(text.truncated, true);
    assert.equal(text.binary, false);
    assert.equal(text.language, 'ts');
    assert.deepEqual(await getWorkspaceFilePreview(root, 'image.bin'), {
      path: 'image.bin', content: '', size: 3, binary: true, truncated: false, language: 'bin',
    });
  });

  test('handles cut UTF-8 suffixes, invalid interiors and exact preview boundaries', async (t) => {
    const root = await repository(t);
    const limit = 256 * 1024;
    await writeFile(join(root, 'cut.txt'), 'a'.repeat(limit - 1) + '🙂');
    await writeFile(join(root, 'exact.txt'), 'a'.repeat(limit));
    await writeFile(join(root, 'invalid.txt'), Buffer.from([0x61, 0xff, 0x62]));
    await writeFile(join(root, 'incomplete.txt'), Buffer.from([0xf0, 0x9f]));
    const cut = await getWorkspaceFilePreview(root, 'cut.txt');
    assert.equal(cut.content, 'a'.repeat(limit - 1));
    assert.equal(cut.binary, false);
    assert.equal(cut.truncated, true);
    assert.equal((await getWorkspaceFilePreview(root, 'exact.txt')).truncated, false);
    assert.equal((await getWorkspaceFilePreview(root, 'invalid.txt')).binary, true);
    assert.equal((await getWorkspaceFilePreview(root, 'incomplete.txt')).binary, true);
  });

  test('rejects traversal and symlinks that leave the workspace', async (t) => {
    const base = await repository(t);
    const root = join(base, 'workspace');
    await mkdir(root);
    await mkdir(join(base, 'workspace-sibling'));
    await writeFile(join(base, 'outside.txt'), 'synthetic outside fixture');
    await symlink(join(base, 'outside.txt'), join(root, 'leak.txt'));
    await symlink(join(base, 'workspace-sibling'), join(root, 'outside-dir'));
    await assert.rejects(getWorkspaceFilePreview(root, '../outside.txt'), /outside the workspace/);
    await assert.rejects(getWorkspaceFilePreview(root, join(base, 'outside.txt')), /outside the workspace/);
    await assert.rejects(getWorkspaceFilePreview(root, 'leak.txt'), /outside the workspace/);
    await assert.rejects(listWorkspaceDirectory(root, 'outside-dir'), /outside the workspace/);
    await assert.rejects(listWorkspaceDirectory(root, '../workspace-sibling'), /outside the workspace/);
    await assert.rejects(captureWorkspaceDiffs(root, '../outside.txt'), /outside the workspace/);
    await assert.rejects(getWorkspaceDiff(root, '../outside.txt', 'unstaged'), /outside the workspace/);
    await assert.rejects(getWorkspaceDiff(root, join(root, 'file.txt'), 'staged'), /Invalid workspace path/);
    await assert.rejects(getWorkspaceFilePreview(root, 'nul\0.txt'), /Invalid workspace path/);
    await assert.rejects(getWorkspaceFilePreview(root, '.'), /not a file/);
    await assert.rejects(listWorkspaceDirectory(base, 'outside.txt'), /not a directory/);
  });
});

test('refuses truncated status metadata rather than publishing a partial file inventory', async (t) => {
  const root = await fakeGit(t, `process.stdout.write('x'.repeat(8 * 1024 * 1024 + 1));`);
  await assert.rejects(getWorkspaceStatus(root), /Git metadata output limit exceeded/);
});
