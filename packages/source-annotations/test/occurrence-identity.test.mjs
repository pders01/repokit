import assert from "node:assert/strict";
import test from "node:test";
import { createGitResolver, createGitTarget } from "@jpahd/source-annotations";
import { commitFile, fixture, git } from "./helpers.mjs";

// Preserve the exact occurrence/context fixtures from
// server/annotations/git-target.test.ts, not just generic duplicate refusal.
test("rejects indistinguishable duplication but projects distinct-context insertions", async (t) => {
  const { root } = await fixture(t);
  await commitFile(root, "source.txt", "before\nrepeat\nafter\n");
  const target = await createGitTarget(root, {
    ref: "HEAD", path: "source.txt", startLine: 2, endLine: 2,
  });
  await commitFile(root, "source.txt", "before\nrepeat\nafter\nbefore\nrepeat\nafter\n");
  let resolver = await createGitResolver(root, "HEAD");
  assert.equal((await resolver(target)).status, "unplaced");

  await commitFile(root, "before.txt", "before\nrepeat\nafter\n");
  const beforeTarget = await createGitTarget(root, {
    ref: "HEAD", path: "before.txt", startLine: 2, endLine: 2,
  });
  await commitFile(root, "before.txt", "inserted\nrepeat\nbefore\nrepeat\nafter\n");
  resolver = await createGitResolver(root, "HEAD");
  const placement = await resolver(beforeTarget);
  assert.equal(placement.status, "moved");
  assert.equal(placement.startLine, 4);
  assert.equal(placement.endLine, 4);
  assert.equal(placement.path, "before.txt");
});

test("does not relocate an edited or deleted occurrence to its duplicate", async (t) => {
  const { root } = await fixture(t);
  await commitFile(root, "edit.txt", "before\nrepeat\nafter\nbefore\nrepeat\nafter\n");
  const editTarget = await createGitTarget(root, {
    ref: "HEAD", path: "edit.txt", startLine: 2, endLine: 2,
  });
  const original = await createGitResolver(root, editTarget.commit);
  const originalPlacement = await original(editTarget);
  assert.equal(originalPlacement.status, "unchanged");
  assert.equal(originalPlacement.startLine, 2);
  await commitFile(root, "edit.txt", "before\nchanged\nafter\nbefore\nrepeat\nafter\n");
  let resolver = await createGitResolver(root, "HEAD");
  assert.equal((await resolver(editTarget)).status, "unplaced");

  await commitFile(root, "delete.txt", "before\nrepeat\nafter\nbefore\nrepeat\nafter\n");
  const deleteTarget = await createGitTarget(root, {
    ref: "HEAD", path: "delete.txt", startLine: 5, endLine: 5,
  });
  await commitFile(root, "delete.txt", "before\nrepeat\nafter\n");
  resolver = await createGitResolver(root, "HEAD");
  assert.equal((await resolver(deleteTarget)).status, "unplaced");
});

test("rejects an unsupported rename destination path", async (t) => {
  const { root } = await fixture(t);
  await commitFile(root, "old.txt", "before\nanchor\nafter\n");
  const target = await createGitTarget(root, {
    ref: "HEAD", path: "old.txt", startLine: 2, endLine: 2,
  });
  git(root, "mv", "old.txt", "renamed\\file.txt");
  assert.equal((await (await createGitResolver(root, "WORKTREE"))(target)).status, "unplaced");
});
