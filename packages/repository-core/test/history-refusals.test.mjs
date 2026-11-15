import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getRepositoryDiff, listRepositoryCommits, listRepositoryRefs } from '@jpahd/repository-core';
import { commit, git, repository } from './fixtures.mjs';
import { syntheticGit } from './preservation-fixtures.mjs';

// Backend semantics preserved from server/repository-history-safety.test.ts;
// no Pi RPC/session plumbing or Bun runtime is needed for these refusals.
test('invalid UTF-8 native patches refuse instead of becoming complete replacement text', async (t) => {
  const root = await repository(t);
  await writeFile(join(root, 'source.txt'), 'before\n');
  const before = await commit(root, 'before');
  await writeFile(join(root, 'source.txt'), Buffer.from([0x61, 0xff, 0x0a]));
  const after = await commit(root, 'after');
  await assert.rejects(getRepositoryDiff(root, { fromRef: before, toRef: after }), /without loss/);

  // U+FFFD encoded as valid UTF-8 is real source, not evidence of a decoder
  // replacing the invalid bytes above. A rejected read must not poison this.
  await writeFile(join(root, 'source.txt'), 'a\uFFFD\n');
  const replacement = await commit(root, 'literal replacement character');
  const valid = await getRepositoryDiff(root, { fromRef: before, toRef: replacement });
  assert.equal(valid.truncated, false);
  assert(valid.rawDiff.includes('+a\uFFFD\n'));
});

for (const field of ['body', 'subject']) {
  test(`Git ${field} overflow is a rejected read, never false exhaustion or partial metadata`, { timeout: 20_000 }, async (t) => {
    const root = await repository(t);
    syntheticGit(root, ['commit', '-q', '--allow-empty', '--cleanup=verbatim', '-F', '-'], 'bounded root\n');
    const anchor = git(root, 'rev-parse', 'HEAD');
    // Real Git object and output, not a mocked parser or manufactured child
    // stream: exceed the public metadata cap by 1 KiB in the selected field.
    const large = 'x'.repeat(8 * 1024 * 1024 + 1024);
    syntheticGit(root, ['commit', '-q', '--allow-empty', '--cleanup=verbatim', '-F', '-'],
      field === 'body' ? `large body\n\n${large}` : `${large}\n`);
    assert.notEqual(git(root, 'rev-parse', 'HEAD'), anchor);
    await assert.rejects(listRepositoryCommits(root, { ref: 'HEAD', limit: 2 }), /Git metadata output limit exceeded/);
    if (field === 'subject') {
      await assert.rejects(listRepositoryRefs(root), /Git metadata output limit exceeded/);
    }

    // Overflow must not latch a refusal across independent requests, nor turn
    // an explicitly pinned small history read into empty/partial exhaustion.
    const bounded = await listRepositoryCommits(root, { ref: anchor, limit: 2 });
    assert.equal(bounded.hasMore, false);
    assert.deepEqual(bounded.commits.map((row) => row.sha), [anchor]);
    assert.equal(bounded.commits[0].subject, 'bounded root');
    assert.equal(bounded.commits[0].body, '');
    assert.deepEqual(bounded.commits[0].parentShas, []);
  });
}
