import assert from "node:assert/strict";
import { mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createGitResolver, createGitTarget, resolveAnnotationRef } from "@jpahd/source-annotations";
import { withGitBudget } from "@jpahd/repository-core/git";
import { commitFile, fixture, git } from "./helpers.mjs";

const targetInput = { ref: "HEAD", path: "source.txt", startLine: 2, endLine: 2 };

test("compiled resolver uses the shared repository-core Git budget, including caught fallback errors", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(withGitBudget(() => createGitTarget(root, targetInput), { timeoutMs: 20_000, commands: 1 }), /Git work budget exceeded/);
  const target = await createGitTarget(root, targetInput);
  const resolver = await createGitResolver(root, "HEAD");
  // Resolver conservatively catches unavailable-object errors; budget exhaustion
  // must still fail the operation instead of returning a partial placement.
  await assert.rejects(withGitBudget(() => resolver(target), { timeoutMs: 20_000, commands: 0 }), /Git work budget exceeded/);
  assert.equal((await (await createGitResolver(root, "HEAD"))(target)).status, "unchanged");
});

test("compiled resolver: immutable refs, insertion shifts, tracked rename, edits and deletion", async (t) => {
  const { root } = await fixture(t);
  const target = await createGitTarget(root, targetInput);
  assert.equal(target.quote.exact, "anchor 😀");
  assert.equal(target.quote.prefix, "before");
  assert.equal(target.quote.suffix, "after");
  assert.equal(target.commit, await resolveAnnotationRef(root, "main"));
  assert.deepEqual(await (await createGitResolver(root, target.commit))(target), {
    ref: target.commit, status: "unchanged", path: "source.txt", startLine: 2, endLine: 2,
  });
  await commitFile(root, "source.txt", "inserted\nbefore\nanchor 😀\nafter\n");
  const moved = await (await createGitResolver(root, "HEAD"))(target);
  assert.equal(moved.status, "moved");
  assert.equal(moved.startLine, 3);
  git(root, "mv", "source.txt", "renamed.txt");
  assert.equal((await (await createGitResolver(root, "WORKTREE"))(target)).path, "renamed.txt");
  git(root, "commit", "-qm", "rename");
  assert.equal((await (await createGitResolver(root, "HEAD"))(target)).status, "moved");
  // Test changed text independently of Git's similarity threshold: on this tiny
  // file, combining the earlier rename with another edit can legitimately make
  // the original path unplaced rather than identify a tracked rename.
  const renamedTarget = await createGitTarget(root, { ref: "HEAD", path: "renamed.txt", startLine: 3, endLine: 3 });
  await writeFile(join(root, "renamed.txt"), "inserted\nbefore\nchanged\nafter\n");
  assert.equal((await (await createGitResolver(root, "WORKTREE"))(renamedTarget)).status, "stale");
  git(root, "rm", "-qf", "renamed.txt");
  git(root, "commit", "-qm", "delete");
  assert.equal((await (await createGitResolver(root, "HEAD"))(target)).status, "unplaced");
});

test("compiled resolver: only explicit trailing whitespace normalization is allowed", async (t) => {
  const { root } = await fixture(t);
  await commitFile(root, "source.txt", "  indented  value  \nnext\n");
  const input = { ...targetInput, startLine: 1, endLine: 1 };
  const exact = await createGitTarget(root, input);
  const trimmed = await createGitTarget(root, { ...input, whitespace: "trim-line-end" });
  await writeFile(join(root, "source.txt"), "  indented  value\nnext\n");
  const resolver = await createGitResolver(root, "WORKTREE");
  assert.equal((await resolver(exact)).status, "stale");
  assert.equal((await resolver(trimmed)).status, "unchanged");
  assert.equal(trimmed.quote.exact, "  indented  value  ");
  await writeFile(join(root, "source.txt"), "indented value\nnext\n");
  assert.equal((await (await createGitResolver(root, "WORKTREE"))(trimmed)).status, "stale");
});

test("compiled resolver refuses ambiguous repeated blocks rather than trusting arbitrary diff alignment", async (t) => {
  const { root } = await fixture(t);
  const block = "p1\np2\np3\nanchor\ns1\ns2\ns3\n";
  await commitFile(root, "source.txt", block + block);
  const target = await createGitTarget(root, { ...targetInput, startLine: 4, endLine: 4 });
  assert.equal((await (await createGitResolver(root, target.commit))(target)).status, "unchanged");
  await commitFile(root, "source.txt", block);
  assert.equal((await (await createGitResolver(root, "HEAD"))(target)).status, "unplaced");
  const single = await createGitTarget(root, { ...targetInput, startLine: 4, endLine: 4 });
  await commitFile(root, "source.txt", block + block);
  assert.equal((await (await createGitResolver(root, "HEAD"))(single)).status, "unplaced");
});

test("compiled target creation rejects unsafe paths, ephemeral refs, ranges, binary and oversized source", async (t) => {
  const { root } = await fixture(t);
  for (const path of ["../source.txt", ".git/config", ":(top)source.txt", "a/../source.txt", "a\\b", "/source.txt", "*.txt"]) {
    await assert.rejects(createGitTarget(root, { ...targetInput, path }));
  }
  await assert.rejects(createGitTarget(root, { ...targetInput, ref: "WORKTREE" }), /immutable/);
  await assert.rejects(createGitTarget(root, { ...targetInput, startLine: 0 }), /line range/);
  await assert.rejects(createGitTarget(root, { ...targetInput, endLine: 999 }), /line range/);
  await assert.rejects(resolveAnnotationRef(root, "not-a-ref"));
  await commitFile(root, "binary.bin", Buffer.from([0, 1, 2, 3]));
  await assert.rejects(createGitTarget(root, { ...targetInput, path: "binary.bin", startLine: 1, endLine: 1 }), /binary/);
  await commitFile(root, "invalid.txt", Buffer.from([0xff, 0xfe]));
  await assert.rejects(createGitTarget(root, { ...targetInput, path: "invalid.txt", startLine: 1, endLine: 1 }));
  await commitFile(root, "large.txt", "x".repeat(512 * 1024 + 1));
  await assert.rejects(createGitTarget(root, { ...targetInput, path: "large.txt", startLine: 1, endLine: 1 }), /too large|truncated/);
  await symlink("source.txt", join(root, "link.txt"));
  git(root, "add", "link.txt");
  git(root, "commit", "-qm", "symlink");
  await assert.rejects(createGitTarget(root, { ...targetInput, path: "link.txt" }), /regular/);
});

test("compiled resolver never follows worktree symlinks", async (t) => {
  const { root, directory } = await fixture(t);
  const target = await createGitTarget(root, targetInput);
  await unlink(join(root, "source.txt"));
  await writeFile(join(directory, "outside.txt"), "before\nanchor 😀\nafter\n");
  await symlink(join(directory, "outside.txt"), join(root, "source.txt"));
  assert.equal((await (await createGitResolver(root, "WORKTREE"))(target)).status, "unplaced");
  await unlink(join(root, "source.txt"));
  await mkdir(join(root, "source.txt"));
  assert.equal((await (await createGitResolver(root, "WORKTREE"))(target)).status, "unplaced");
  assert.equal((await (await createGitResolver(root, target.commit))({ ...target, fingerprint: "a".repeat(64) })).status, "unplaced");
});
