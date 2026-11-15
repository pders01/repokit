import assert from "node:assert/strict";
import { test } from "node:test";
import {
  captureScope,
  changedFiles,
  exactPath,
  listQuery,
  objectId,
  readingRef,
  readOperation,
  readTimeout,
  ReadingAdapterError,
} from "@jpahd/commits-adapters/common";

const sha = "a".repeat(40);
test("captures only bounded scope fields, never a caller's root/endpoint extras", () => {
  const source = {
    key: "provider:repo",
    repositoryKey: "repo",
    worktreeKey: "worktree",
    label: "Display name",
    root: "unused",
  };
  const scope = captureScope(source);
  source.key = "replacement";
  assert.deepStrictEqual(scope, {
    key: "provider:repo",
    repositoryKey: "repo",
    worktreeKey: "worktree",
    label: "Display name",
  });
  assert.strictEqual(Object.isFrozen(scope), true);
  for (const key of ["", "bad\0key", "x".repeat(257)])
    assert.throws(() => captureScope({ ...source, key }));
});

test("full IDs never use regex coercion or abbreviated identity", () => {
  assert.strictEqual(objectId(sha), sha);
  assert.strictEqual(objectId("a".repeat(64)), "a".repeat(64));
  for (const value of [null, 1, "abc1234", { toString: () => sha }])
    assert.throws(() => objectId(value));
});

test("literal ref-name prefixes are retained when the backend guarantees namespace-relative names", () => {
  assert.deepStrictEqual(readingRef("refs/heads/topic", "branch"), {
    name: "refs/heads/topic",
    kind: "branch",
    selector: "refs/heads/refs/heads/topic",
  });
  assert.strictEqual(readingRef("refs/tags/topic", "tag").selector, "refs/tags/refs/tags/topic");
  for (const name of ["bad name", "trailing/", ".hidden", "a..b", "a.lock", "a/.b", "a@{b", "a?b"])
    assert.throws(() => readingRef(name, "branch"));
});

test("literal common paths keep whitespace and newlines but refuse aliases and Git pathspecs", () => {
  assert.strictEqual(exactPath(" spaced\nname.ts "), " spaced\nname.ts ");
  assert.strictEqual(exactPath(""), "");
  assert.strictEqual(exactPath(undefined), undefined);
  for (const path of [
    "a//b",
    "a/./b",
    "./a",
    "a/..",
    "../b",
    "a/",
    "a\\b",
    ":(glob)*",
    "a?b",
    "a[b]",
  ])
    assert.throws(() => exactPath(path));
});

test("common query snapshots reject offset overflow instead of allowing server clamping", () => {
  const input = {
    revision: { requestedRef: "HEAD", commit: sha },
    path: "a",
    limit: 80,
    offset: 10_000,
  };
  const query = listQuery(input);
  input.revision.commit = "b".repeat(40);
  input.path = "new";
  assert.strictEqual(query.revision.commit, sha);
  assert.strictEqual(query.path, "a");
  assert.strictEqual(Object.isFrozen(query.revision), true);
  assert.throws(() => listQuery({ ...input, offset: 10_001 }));
});

test("changed-file evidence is cloned and bounded without losing synthetic omission rows", () => {
  const input = [
    {
      path: "... and 10 more files",
      status: "truncated",
      fromPath: "",
      additions: 0,
      deletions: 0,
    },
  ];
  const files = changedFiles(input);
  input[0].status = "changed";
  assert.strictEqual(files[0].status, "truncated");
  assert.strictEqual(Object.isFrozen(files[0]), true);
  assert.throws(() => changedFiles(Array(2001).fill(files[0])));
});

test("read deadlines can only be shortened, not silently weakened", () => {
  assert.strictEqual(readTimeout(), 10_000);
  assert.strictEqual(readTimeout(1), 1);
  for (const value of [0, -1, 10_001, Infinity, NaN, 1.5]) assert.throws(() => readTimeout(value));
});

test("aborting before the operation's initial continuation issues no work", async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = readOperation(controller.signal, 100, async () => {
    calls++;
  });
  controller.abort();
  await assert.rejects(pending);
  assert.strictEqual(calls, 0);
});

test("synchronous abort-and-throw does not leave an unhandled cancellation promise", async () => {
  const controller = new AbortController();
  await assert.rejects(
    readOperation(controller.signal, 100, () => {
      controller.abort(new DOMException("Fixture abort", "AbortError"));
      throw new Error("discarded fixture error");
    }),
    { message: "Fixture abort" },
  );
  await Promise.resolve();
});

test("successful reads remove parent abort listeners and sanitize unknown failures", async () => {
  const controller = new AbortController();
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  let added = 0,
    removed = 0;
  controller.signal.addEventListener = (...args: Parameters<typeof add>) => {
    added++;
    add(...args);
  };
  controller.signal.removeEventListener = (...args: Parameters<typeof remove>) => {
    removed++;
    remove(...args);
  };
  assert.strictEqual(await readOperation(controller.signal, 100, async () => "result"), "result");
  let error: unknown;
  try {
    await readOperation(controller.signal, 100, async () => {
      throw new Error("secret backend details");
    });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof ReadingAdapterError);
  assert.ok(!String(error).includes("secret"));
  assert.strictEqual((error as Error).cause, undefined);
  assert.strictEqual(added, removed);
});
