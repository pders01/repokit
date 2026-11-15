import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { searchRepositoryFiles } from '@jpahd/repository-core';
import { commit, git, repository } from './fixtures.mjs';
import { syntheticGit } from './preservation-fixtures.mjs';

// Preserved from server/workspace/file-search.test.ts: result truncation and
// listing incompleteness are different promises, including at the exact cap.
test('ranks deterministically and caps match results at 100 without marking a complete listing incomplete', async (t) => {
  const root = await repository(t);
  await mkdir(join(root, 'a'));
  for (const path of ['app.ts', 'a/app-long.ts', 'a/my-app.ts']) {
    await writeFile(join(root, path), 'x\n');
  }
  const paths = Array.from({ length: 105 }, (_, index) => `a/match-${String(index).padStart(3, '0')}.txt`);
  for (const path of paths.slice(0, 100)) await writeFile(join(root, path), 'x\n');
  const exact = await commit(root, 'exactly 100 matching files');
  assert.deepEqual(await searchRepositoryFiles(root, 'match', exact), {
    ref: exact, paths: paths.slice(0, 100), truncated: false, incomplete: false,
  });

  for (const path of paths.slice(100)) await writeFile(join(root, path), 'x\n');
  const head = await commit(root, '105 matching files');
  assert.deepEqual(await searchRepositoryFiles(root, 'app', head), {
    ref: head, paths: ['app.ts', 'a/app-long.ts', 'a/my-app.ts'], truncated: false, incomplete: false,
  });
  assert.deepEqual(await searchRepositoryFiles(root, 'match', head), {
    ref: head, paths: paths.slice(0, 100), truncated: true, incomplete: false,
  });
});

test('reports a bounded 2 MiB listing and never invents a path from a partial record', async (t) => {
  const root = await repository(t);
  await writeFile(join(root, 'seed'), 'x\n');
  const blob = git(root, 'hash-object', '-w', 'seed');
  const paths = Array.from({ length: 10_000 }, (_, index) => `budget-${String(index).padStart(5, '0')}-${'x'.repeat(201)}.ts`);
  const records = paths.map((path) => `100644 blob ${blob}\t${path}\0`);
  const listing = Buffer.from(records.join(''));
  const limit = 2 * 1024 * 1024;
  const recordBytes = Buffer.byteLength(records[0]);
  const partialIndex = Math.floor(limit / recordBytes);
  const retainedSuffix = listing.subarray(partialIndex * recordBytes, limit);
  // Prove that this fixture crosses the bound inside a filename, after its
  // unique searchable prefix, rather than conveniently ending on a NUL.
  assert(listing.length > limit);
  assert(retainedSuffix.length > Buffer.byteLength(`100644 blob ${blob}\tbudget-${String(partialIndex).padStart(5, '0')}`));
  assert(!retainedSuffix.includes(0));
  const tree = syntheticGit(root, ['mktree', '-z'], listing);
  const head = git(root, 'commit-tree', tree, '-m', 'bounded tree');

  assert.deepEqual(await searchRepositoryFiles(root, '', head), {
    ref: head, paths: paths.slice(0, 100), truncated: true, incomplete: true,
  });
  // The last complete record is searchable; the cut record must not be
  // returned even as a shortened filename. Later records are not scanned.
  assert.deepEqual(await searchRepositoryFiles(root, `budget-${String(partialIndex - 1).padStart(5, '0')}`, head), {
    ref: head, paths: [paths[partialIndex - 1]], truncated: false, incomplete: true,
  });
  for (const index of [partialIndex, partialIndex + 1]) {
    assert.deepEqual(await searchRepositoryFiles(root, `budget-${String(index).padStart(5, '0')}`, head), {
      ref: head, paths: [], truncated: false, incomplete: true,
    });
  }
});
