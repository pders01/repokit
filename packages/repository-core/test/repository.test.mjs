import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  compareRepositoryRefs, getRepositoryBlame, getRepositoryDiff, getRepositoryFile,
  getRepositoryInfo, listKnowledgeDocuments, listRepositoryCommits,
  listRepositoryRefs, listRepositoryTree, searchRepositoryFiles,
} from '@jpahd/repository-core';
import { commit, git, repository } from './fixtures.mjs';

async function fixture(t) {
  const root = await repository(t);
  await mkdir(join(root, 'docs'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'README.md'), '# Repository fixture\n\nImmutable notes.\n');
  await writeFile(join(root, 'docs', 'guide.mdx'), '# Guide\n\nNested notes.\n');
  await writeFile(join(root, 'src', 'app.ts'), 'export const value = 1;\n');
  const base = await commit(root, 'initial\n\nBody with \u001e and \u001f text.\n');
  git(root, 'tag', 'v1');
  await writeFile(join(root, 'src', 'app.ts'), 'export const value = 2;\n');
  const head = await commit(root, 'change value');
  return { root, base, head };
}

test('compiled exports read repository info, refs, exact tree/file identity and pinned search', async (t) => {
  const { root, base, head } = await fixture(t);
  assert.deepEqual(await getRepositoryInfo(root), { root, branch: 'main', defaultBranch: 'main', head, shortHead: head.slice(0, 8) });
  const refs = await listRepositoryRefs(root);
  assert(refs.some((ref) => ref.name === 'main' && ref.kind === 'branch' && ref.commit === head));
  assert(refs.some((ref) => ref.name === 'v1' && ref.kind === 'tag' && ref.commit === base));
  assert.deepEqual((await listRepositoryTree(root, 'v1', 'src')).map((file) => file.path), ['src/app.ts']);
  const file = await getRepositoryFile(root, 'src/app.ts', 'v1');
  assert.equal(file.ref, base);
  assert.equal(file.content, 'export const value = 1;\n');
  assert.equal(file.objectId, git(root, 'rev-parse', `${base}:src/app.ts`));
  assert.equal(file.language, 'ts');
  const found = await searchRepositoryFiles(root, 'app', 'v1');
  assert.deepEqual(found, { ref: base, paths: ['src/app.ts'], truncated: false, incomplete: false });
});

test('immutable blame and Markdown discovery ignore edits, index renames and deleted worktree files', async (t) => {
  const { root, head } = await fixture(t);
  await writeFile(join(root, 'src', 'app.ts'), 'mutable worktree\n');
  await writeFile(join(root, 'README.md'), '# Mutable title\n');
  git(root, 'mv', 'docs/guide.mdx', 'docs/renamed.mdx');
  await rm(join(root, 'docs', 'renamed.mdx'));
  const blame = await getRepositoryBlame(root, 'src/app.ts');
  assert.equal(blame[0].text, 'export const value = 2;');
  assert.equal(blame[0].commit, head);
  const documents = await listKnowledgeDocuments(root);
  assert.deepEqual(documents.map((document) => document.path), ['README.md', 'docs/guide.mdx']);
  assert.equal(documents[0].title, 'Repository fixture');
  assert.equal(documents[0].preview, 'Immutable notes.');
  for (const document of documents) {
    assert.equal(document.ref, head);
    assert.equal(document.modified, false);
    assert.equal(document.authority, 'canonical');
    assert.equal(document.objectId, git(root, 'rev-parse', `${head}:${document.path}`));
  }
  assert.equal(await readFile(join(root, 'src', 'app.ts'), 'utf8'), 'mutable worktree\n');
});

test('history, root diff and comparison retain canonical content and resolved identities', async (t) => {
  const { root, base, head } = await fixture(t);
  const first = await listRepositoryCommits(root, { ref: 'main', limit: 1 });
  assert.equal(first.hasMore, true);
  assert.equal(first.commits[0].sha, head);
  assert.equal(first.commits[0].filesChanged, 1);
  const second = await listRepositoryCommits(root, { ref: 'main', limit: 1, offset: 1 });
  assert.equal(second.hasMore, false);
  assert.equal(second.commits[0].sha, base);
  assert.equal(second.commits[0].body, 'Body with \u001e and \u001f text.\n');
  const diff = await getRepositoryDiff(root, { fromRef: 'v1', toRef: 'main', path: 'src/app.ts' });
  assert.equal(diff.truncated, false);
  assert.match(diff.rawDiff, /\+export const value = 2;/);
  assert.match((await getRepositoryDiff(root, { toRef: base })).rawDiff, /\+Immutable notes/);
  const compared = await compareRepositoryRefs(root, 'v1', 'main');
  assert.equal(compared.baseRef, base);
  assert.equal(compared.headRef, head);
  assert.deepEqual(compared.files, [{ path: 'src/app.ts', status: 'modified', additions: 1, deletions: 1 }]);
});

test('file bounds distinguish cut UTF-8, malformed text and binary without replacements', async (t) => {
  const root = await repository(t);
  const limit = 512 * 1024;
  await writeFile(join(root, 'large.txt'), 'x'.repeat(limit - 1) + '\u{1F642}tail');
  await writeFile(join(root, 'invalid.txt'), Buffer.from([0x61, 0xff, 0x62]));
  await writeFile(join(root, 'binary.dat'), Buffer.from([0, 1, 2]));
  await writeFile(join(root, 'replacement.txt'), '\ufffd');
  await commit(root, 'preview fixtures');
  const large = await getRepositoryFile(root, 'large.txt');
  assert.equal(large.truncated, true);
  assert.equal(large.binary, false);
  assert.equal(large.content, 'x'.repeat(limit - 1));
  assert.equal((await getRepositoryFile(root, 'invalid.txt')).binary, true);
  assert.equal((await getRepositoryFile(root, 'binary.dat')).binary, true);
  assert.equal((await getRepositoryFile(root, 'replacement.txt')).content, '\ufffd');
});

test('literal search paths and rank remain reusable with spaces, tabs and newlines', async (t) => {
  const root = await repository(t);
  for (const path of ['query.txt', 'query extended.txt', 'a\ttab.txt', 'new\nline.md', 'colon:name.md']) {
    await writeFile(join(root, path), `# ${path}\n`);
  }
  const head = await commit(root, 'literal names');
  const result = await searchRepositoryFiles(root, 'query');
  assert.deepEqual(result.paths, ['query.txt', 'query extended.txt']);
  assert.equal(result.ref, head);
  const odd = await searchRepositoryFiles(root, 'new\nline.md');
  assert.deepEqual(odd.paths, ['new\nline.md']);
  assert.equal((await getRepositoryFile(root, odd.paths[0], odd.ref)).path, 'new\nline.md');
});

test('literal pathspecs and tabbed numstat names cannot retarget history or lose stats', async (t) => {
  const root = await repository(t);
  const paths = ['[literal].txt', 'l.txt', 'tab\tname.txt'];
  for (const path of paths) await writeFile(join(root, path), 'before\n');
  const base = await commit(root, 'base');
  for (const path of paths) await writeFile(join(root, path), 'after\n');
  const head = await commit(root, 'change');
  const compared = await compareRepositoryRefs(root, base, head);
  assert.equal(compared.files.find((file) => file.path === 'tab\tname.txt').additions, 1);
  assert.equal(compared.files.find((file) => file.path === 'tab\tname.txt').deletions, 1);
  const diff = await getRepositoryDiff(root, { fromRef: base, toRef: head, path: '[literal].txt' });
  assert.match(diff.rawDiff, /\[literal\]\.txt/);
  assert(!diff.rawDiff.includes('a/l.txt'));
  const history = await listRepositoryCommits(root, { path: '[literal].txt' });
  assert.equal(history.commits.length, 2);
});

test('literal backslashes never become separators when reading Git objects', { skip: process.platform === 'win32' }, async (t) => {
  const root = await repository(t);
  await mkdir(join(root, 'literal'));
  await writeFile(join(root, 'literal', 'name.md'), '# Directory source\n');
  await writeFile(join(root, 'literal\\name.md'), '# Backslash source\n');
  await commit(root, 'distinct paths');
  assert.equal((await getRepositoryFile(root, 'literal\\name.md')).content, '# Backslash source\n');
  assert.equal((await getRepositoryFile(root, 'literal/name.md')).content, '# Directory source\n');
  const documents = await listKnowledgeDocuments(root);
  assert.equal(documents.find((document) => document.path === 'literal\\name.md').title, 'Backslash source');
});

test('replacement objects cannot redirect immutable reads', async (t) => {
  const { root, head } = await fixture(t);
  const original = git(root, 'rev-parse', `${head}:src/app.ts`);
  await writeFile(join(root, 'replacement'), 'replacement content\n');
  const replacement = git(root, 'hash-object', '-w', 'replacement');
  git(root, 'replace', original, replacement);
  const file = await getRepositoryFile(root, 'src/app.ts', head);
  assert.equal(file.content, 'export const value = 2;\n');
  assert.equal(file.objectId, original);
});

test('invalid paths and option-like refs refuse without mutable fallbacks', async (t) => {
  const { root } = await fixture(t);
  for (const path of ['../escape', '/absolute', 'a/../b', '\0bad']) {
    await assert.rejects(getRepositoryFile(root, path), /Invalid repository path/);
  }
  await assert.rejects(listRepositoryTree(root, '--all'), /Invalid repository ref/);
  await assert.rejects(searchRepositoryFiles(root, 'x', 'WORKTREE'), /Invalid repository ref/);
  await assert.rejects(searchRepositoryFiles(root, '\0'), /Invalid repository search query/);
});

test('shallow history and diffs refuse rather than inventing roots or exhaustion', async (t) => {
  const { root, head } = await fixture(t);
  await writeFile(join(root, '.git', 'shallow'), `${head}\n`);
  await assert.rejects(listRepositoryCommits(root, {}), /history is shallow/);
  await assert.rejects(getRepositoryDiff(root, {}), /history is shallow/);
});

test('symlink blobs are not followed and are not Markdown discovery sources', { skip: process.platform === 'win32' }, async (t) => {
  const { root } = await fixture(t);
  await symlink('README.md', join(root, 'linked.md'));
  await commit(root, 'symlink fixture');
  assert.equal((await listRepositoryTree(root)).find((entry) => entry.name === 'linked.md').type, 'symlink');
  assert.equal((await getRepositoryFile(root, 'linked.md')).content, 'README.md');
  assert(!(await listKnowledgeDocuments(root)).some((document) => document.path === 'linked.md'));
});
