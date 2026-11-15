import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { format } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  READER_LIMITS,
  RepositoryReadError,
  type CommitDiff,
  type CommitsLocation,
  type CommitsProvider,
  type ReadResult,
  type ReadingScope,
} from "@jpahd/commits-core/contracts";
import { CommitsReaderState } from "@jpahd/commits-core/state";

// All data and scheduling are local: no host, backend, DOM, or filesystem fixture.
type Entry = Awaited<ReturnType<CommitsProvider["commit"]>>["value"];
type Method = "describe" | "listRefs" | "resolve" | "list" | "commit" | "diff";
type Call = { method: Method; input: unknown; signal: AbortSignal };
const id = (n: number, length = 40) => n.toString(16).padStart(length, "0");
const HEAD = id(100),
  PARENT = id(99),
  OTHER = id(900);
const LOCATION = { ref: "refs/heads/main", path: "src/exact.ts" };
const entry = (sha = HEAD, parentShas: string[] = [PARENT]): Entry => ({
  sha,
  shortSha: sha.slice(0, 8),
  message: `Commit ${sha}`,
  body: "",
  authorName: "Reader",
  authorEmail: "reader@example.invalid",
  authorTime: 1_700_000_000n,
  parentShas,
  additions: 1,
  deletions: 0,
  filesChanged: 1,
});
const patch = (commit = HEAD, parents = [PARENT]): CommitDiff => ({
  toCommit: commit,
  base: parents.length ? { kind: "commit", commit: parents[0]! } : { kind: "empty-tree" },
  rawDiff: "diff --git a/src/exact.ts b/src/exact.ts\n+line\n",
  completeness: { kind: "complete" },
  empty: false,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Overrides may deliberately ignore cancellation to exercise the reader's own fences. */
class MemoryProvider implements CommitsProvider {
  readonly scope: ReadingScope;
  readonly calls: Call[] = [];
  tip = HEAD;
  rows: readonly Entry[] = [entry()];
  entries = new Map<string, Entry>([
    [HEAD, entry()],
    [OTHER, entry(OTHER, [])],
  ]);
  constructor(key = "memory-a") {
    this.scope = { key, repositoryKey: `repository:${key}`, label: key };
  }
  result<T>(value: T): ReadResult<T> {
    return { scopeKey: this.scope.key, value };
  }
  count(method: Method) {
    return this.calls.filter((call) => call.method === method).length;
  }
  record(method: Method, input: unknown, signal: AbortSignal) {
    this.calls.push({ method, input, signal });
  }
  describe: CommitsProvider["describe"] = async (signal) => {
    this.record("describe", undefined, signal);
    return this.result({ initialRef: LOCATION.ref });
  };
  listRefs: CommitsProvider["listRefs"] = async (signal) => {
    this.record("listRefs", undefined, signal);
    return this.result([{ name: "main", selector: LOCATION.ref, kind: "branch" }]);
  };
  resolve: CommitsProvider["resolve"] = async (ref, signal) => {
    this.record("resolve", ref, signal);
    return this.result({ requestedRef: ref, commit: this.tip });
  };
  list: CommitsProvider["list"] = async (query, signal) => {
    this.record("list", query, signal);
    return this.result({
      commits: this.rows.slice(query.offset, query.offset + query.limit),
      hasMore: query.offset + query.limit < this.rows.length,
    });
  };
  commit: CommitsProvider["commit"] = async (sha, signal) => {
    this.record("commit", sha, signal);
    const found = this.entries.get(sha);
    if (!found) throw new Error("Missing in-memory object");
    return this.result(found);
  };
  diff: CommitsProvider["diff"] = async (query, signal) => {
    this.record("diff", query, signal);
    return this.result(patch(query.commit, this.entries.get(query.commit)!.parentShas));
  };
}

const states: CommitsReaderState[] = [];
afterEach(() => {
  for (const state of states.splice(0)) state.detach();
});
function reader(timeoutMs = 500, changed = () => {}) {
  const state = new CommitsReaderState(changed, timeoutMs);
  states.push(state);
  return state;
}
// Promise-only fixtures settle without wall-clock polling or an external event loop.
async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
async function start(provider = new MemoryProvider(), location: CommitsLocation = LOCATION) {
  const state = reader();
  state.configure(provider, location);
  await flush();
  return state;
}
function expectHistoryFailure(state: CommitsReaderState) {
  assert.strictEqual(state.snapshot.loading, false);
  assert.notStrictEqual(state.snapshot.error, "");
}
function expectDetailFailure(state: CommitsReaderState) {
  assert.strictEqual(state.snapshot.detailLoading, false);
  assert.notStrictEqual(state.snapshot.detailError, "");
  assert.strictEqual(state.snapshot.diff, undefined);
}

describe("continuation-boundary and pin-retention regressions", () => {
  test("removing an anchor during its held lookup resolves the same ref afresh and fences the late result", async () => {
    const provider = new MemoryProvider();
    const held = deferred<ReadResult<Entry>>();
    const original = provider.commit;
    provider.commit = (sha, signal) => {
      if (sha !== HEAD) return original(sha, signal);
      provider.record("commit", sha, signal);
      return held.promise;
    };
    provider.tip = OTHER;
    provider.rows = [entry(OTHER, [])];
    const snapshots: (typeof state.snapshot)[] = [];
    const state = reader(500, () => snapshots.push(state.snapshot));
    state.configure(provider, { ...LOCATION, anchor: HEAD, commit: OTHER });
    await flush();
    assert.strictEqual(provider.count("commit"), 1);
    assert.strictEqual(state.snapshot.revision, undefined);
    assert.strictEqual(state.snapshot.loading, true);

    const removedAt = snapshots.length;
    state.configure(provider, { ...LOCATION, commit: OTHER });
    await flush();
    assert.strictEqual(provider.count("resolve"), 1);
    assert.strictEqual(
      provider.calls.find((call) => call.method === "commit")?.signal.aborted,
      true,
    );
    assert.deepStrictEqual(state.snapshot.revision, { requestedRef: LOCATION.ref, commit: OTHER });
    assert.strictEqual(state.snapshot.location?.anchor, undefined);
    assert.strictEqual(state.snapshot.selected?.sha, OTHER);
    assert.strictEqual(state.snapshot.diff?.toCommit, OTHER);
    assert.deepStrictEqual(
      provider.calls.filter((call) => call.method === "list").map((call) => call.input),
      [
        {
          revision: { requestedRef: LOCATION.ref, commit: OTHER },
          path: LOCATION.path,
          limit: READER_LIMITS.page,
          offset: 0,
        },
      ],
    );
    const accepted = state.snapshot,
      calls = provider.calls.length;
    held.resolve(provider.result(entry()));
    await flush();
    assert.strictEqual(state.snapshot, accepted);
    assert.strictEqual(provider.calls.length, calls);
    assert.strictEqual(
      snapshots
        .slice(removedAt)
        .some(
          (snapshot) =>
            snapshot.revision?.commit === HEAD ||
            snapshot.selected?.sha === HEAD ||
            snapshot.commits.some((commit) => commit.sha === HEAD),
        ),
      false,
    );
  });

  test("a defined host echo of the effective anchor retains the pin without restarting history", async () => {
    const provider = new MemoryProvider();
    const state = await start(provider);
    provider.tip = OTHER;
    state.configure(provider, { ...LOCATION, anchor: HEAD, commit: OTHER });
    await flush();
    assert.strictEqual(state.snapshot.revision?.commit, HEAD);
    assert.strictEqual(state.snapshot.diff?.toCommit, OTHER);
    assert.strictEqual(provider.count("resolve"), 1);
    assert.strictEqual(provider.count("list"), 1);
    // Removing only the echoed selected commit must likewise leave the history alone.
    state.configure(provider, { ...LOCATION, anchor: HEAD });
    await flush();
    assert.strictEqual(state.snapshot.revision?.commit, HEAD);
    assert.strictEqual(provider.count("list"), 1);
  });

  for (const method of ["resolve", "list", "commit", "diff"] as const) {
    test(format("rebinds between inner read and outer %s continuation", method), async () => {
      const a = new MemoryProvider("a"),
        b = new MemoryProvider("b");
      b.rows = [entry(OTHER)];
      const snapshots: Array<{
        scope?: ReadingScope;
        commits: readonly Entry[];
        selected?: Entry;
      }> = [];
      const state = reader(500, () => snapshots.push(state.snapshot));
      const result = <T>(value: T): ReadResult<T> => ({
        scopeKey: a.scope.key,
        get value() {
          queueMicrotask(() => state.configure(b, { ...LOCATION, commit: OTHER }));
          return value;
        },
      });
      if (method === "resolve")
        a.resolve = async () => result({ requestedRef: LOCATION.ref, commit: HEAD });
      if (method === "list") a.list = async () => result({ commits: [entry()], hasMore: false });
      if (method === "commit") a.commit = async () => result(entry());
      if (method === "diff") a.diff = async () => result(patch());
      state.configure(a, { ...LOCATION, commit: HEAD });
      await flush();
      assert.strictEqual(state.snapshot.scope?.key, "b");
      assert.strictEqual(state.snapshot.selected?.sha, OTHER);
      assert.strictEqual(state.snapshot.diff?.toCommit, OTHER);
      assert.deepStrictEqual(
        state.snapshot.commits.map((row) => row.sha),
        [OTHER],
      );
      assert.strictEqual(
        snapshots.some(
          (snapshot) =>
            snapshot.scope?.key === "b" &&
            (snapshot.selected?.sha === HEAD || snapshot.commits.some((row) => row.sha === HEAD)),
        ),
        false,
      );
      if (method === "resolve") assert.strictEqual(a.count("list"), 0);
      if (method === "commit") assert.strictEqual(a.count("diff"), 0);
    });
  }

  test("omitted provider-default location retains its pin on reconnect", async () => {
    const provider = new MemoryProvider();
    const state = reader();
    state.configure(provider, undefined);
    await flush();
    assert.strictEqual(state.snapshot.revision?.commit, HEAD);
    state.detach();
    provider.tip = OTHER;
    state.attach();
    state.configure(provider, undefined);
    await flush();
    assert.strictEqual(state.snapshot.revision?.commit, HEAD);
    assert.strictEqual(provider.count("resolve"), 1);
  });

  test("retrying failed pagination retains the resolved pin after branch advance", async () => {
    const provider = new MemoryProvider();
    provider.rows = Array.from({ length: 81 }, (_, index) => entry(id(index + 1)));
    const state = await start(provider);
    const list = provider.list;
    provider.list = async () => {
      throw new Error("page unavailable");
    };
    await state.more();
    expectHistoryFailure(state);
    provider.tip = OTHER;
    provider.list = list;
    state.retry();
    await flush();
    assert.strictEqual(state.snapshot.revision?.commit, HEAD);
    assert.strictEqual(provider.count("resolve"), 1);
  });

  test("interrupted detail reconnect keeps an unanchored route's effective pin", async () => {
    const provider = new MemoryProvider();
    const held = deferred<ReadResult<Entry>>();
    const original = provider.commit;
    let first = true;
    provider.commit = (sha, signal) => {
      if (first) {
        first = false;
        return held.promise;
      }
      return original(sha, signal);
    };
    const state = await start(provider, { ...LOCATION, commit: HEAD });
    state.detach();
    provider.tip = OTHER;
    state.attach();
    state.configure(provider, { ...LOCATION, commit: HEAD });
    await flush();
    assert.strictEqual(state.snapshot.revision?.commit, HEAD);
    assert.strictEqual(state.snapshot.diff?.toCommit, HEAD);
    assert.strictEqual(provider.count("resolve"), 1);
    held.resolve(provider.result(entry()));
    await flush();
    assert.strictEqual(state.snapshot.revision?.commit, HEAD);
  });
});

describe("CommitsReaderState identity and exact reads", () => {
  test("pins all pagination to the full resolved SHA when the symbolic ref moves", async () => {
    const provider = new MemoryProvider();
    provider.rows = Array.from({ length: READER_LIMITS.page + 1 }, (_, n) => entry(id(n + 1)));
    const state = await start(provider);
    assert.deepStrictEqual(state.snapshot.revision, { requestedRef: LOCATION.ref, commit: HEAD });
    provider.tip = OTHER;
    await state.more();
    const queries = provider.calls
      .filter((call) => call.method === "list")
      .map((call) => call.input);
    assert.deepStrictEqual(
      queries,
      [0, READER_LIMITS.page].map((offset) => ({
        revision: { requestedRef: LOCATION.ref, commit: HEAD },
        path: LOCATION.path,
        limit: READER_LIMITS.page,
        offset,
      })),
    );
    assert.strictEqual(provider.count("resolve"), 1);
    assert.strictEqual(state.snapshot.commits.length, READER_LIMITS.page + 1);
    state.refresh();
    await flush();
    assert.strictEqual(provider.count("resolve"), 2);
    assert.strictEqual(state.snapshot.revision?.commit, OTHER);
  });

  test("restores a saved anchor by exact commit without resolving the current ref", async () => {
    const provider = new MemoryProvider();
    provider.tip = OTHER;
    const state = await start(provider, { ...LOCATION, anchor: HEAD });
    assert.strictEqual(provider.count("resolve"), 0);
    assert.deepStrictEqual(
      provider.calls.filter((call) => call.method === "commit").map((call) => call.input),
      [HEAD],
    );
    assert.deepStrictEqual(state.snapshot.revision, { requestedRef: LOCATION.ref, commit: HEAD });
    assert.strictEqual(state.snapshot.location?.anchor, HEAD);
    state.retry();
    await flush();
    assert.strictEqual(provider.count("resolve"), 0);
    state.refresh();
    await flush();
    assert.strictEqual(provider.count("resolve"), 1);
    assert.strictEqual(state.snapshot.location?.anchor, undefined);
    assert.strictEqual(state.snapshot.revision?.commit, OTHER);
  });

  test("looks up detail by SHA alone outside both loaded ancestry and exact-path history", async () => {
    const provider = new MemoryProvider();
    const state = await start(provider, { ...LOCATION, commit: OTHER });
    assert.deepStrictEqual(
      state.snapshot.commits.map((row) => row.sha),
      [HEAD],
    );
    assert.strictEqual(state.snapshot.selected?.sha, OTHER);
    assert.deepStrictEqual(
      provider.calls.filter((call) => call.method === "commit").map((call) => call.input),
      [OTHER],
    );
    assert.deepStrictEqual(provider.calls.find((call) => call.method === "diff")?.input, {
      commit: OTHER,
      path: LOCATION.path,
      base: "first-parent",
    });
    assert.deepStrictEqual(state.snapshot.diff?.base, { kind: "empty-tree" });
    assert.strictEqual(state.snapshot.error, "");
  });

  test("uses a merge's first parent, not its second parent", async () => {
    const provider = new MemoryProvider();
    provider.entries.set(HEAD, entry(HEAD, [PARENT, OTHER]));
    const state = await start(provider, { ...LOCATION, commit: HEAD });
    assert.deepStrictEqual(state.snapshot.diff?.base, { kind: "commit", commit: PARENT });
    assert.strictEqual(state.snapshot.detailError, "");
    assert.deepStrictEqual(provider.calls.find((call) => call.method === "diff")?.input, {
      commit: HEAD,
      path: LOCATION.path,
      base: "first-parent",
    });
  });

  for (const [_name, parents, base] of [
    ["root with a commit base", [], { kind: "commit", commit: PARENT }],
    ["non-root with empty tree", [PARENT], { kind: "empty-tree" }],
    ["merge with second parent", [PARENT, OTHER], { kind: "commit", commit: OTHER }],
  ] as const) {
    test(format("rejects %s", _name), async () => {
      const provider = new MemoryProvider();
      provider.entries.set(HEAD, entry(HEAD, [...parents]));
      provider.diff = async () => provider.result({ ...patch(), base });
      expectDetailFailure(await start(provider, { ...LOCATION, commit: HEAD }));
    });
  }
});

describe("CommitsReaderState cancellation and isolation", () => {
  test("a stale A resolve cannot issue an A list or a B follow-on", async () => {
    const a = new MemoryProvider("a"),
      b = new MemoryProvider("b");
    const gate = deferred<Awaited<ReturnType<CommitsProvider["resolve"]>>>();
    a.resolve = (ref, signal) => {
      a.record("resolve", ref, signal);
      return gate.promise;
    };
    b.tip = OTHER;
    const state = await start(a);
    assert.strictEqual(a.count("resolve"), 1);
    state.configure(b, { ...LOCATION, ref: "refs/heads/other" });
    await flush();
    const accepted = state.snapshot,
      bCalls = b.calls.length;
    gate.resolve(a.result({ requestedRef: LOCATION.ref, commit: HEAD }));
    await flush();
    assert.strictEqual(a.count("list"), 0);
    assert.strictEqual(b.calls.length, bCalls);
    assert.strictEqual(b.count("list"), 1);
    assert.strictEqual(state.snapshot, accepted);
    assert.strictEqual(state.snapshot.scope?.key, "b");
    assert.strictEqual(state.snapshot.revision?.commit, OTHER);
    assert.strictEqual(a.calls.find((call) => call.method === "resolve")?.signal.aborted, true);
  });

  for (const outcome of ["success", "error"] as const) {
    test(format("ignores late list %s after rebinding", outcome), async () => {
      const a = new MemoryProvider("a"),
        b = new MemoryProvider("b");
      const gate = deferred<Awaited<ReturnType<CommitsProvider["list"]>>>();
      a.list = (query, signal) => {
        a.record("list", query, signal);
        return gate.promise;
      };
      const state = await start(a);
      state.configure(b, LOCATION);
      await flush();
      const accepted = state.snapshot;
      if (outcome === "success")
        gate.resolve(a.result({ commits: [entry(OTHER)], hasMore: false }));
      else gate.reject(new Error("stale sensitive backend error"));
      await flush();
      assert.strictEqual(state.snapshot, accepted);
      assert.strictEqual(state.snapshot.scope?.key, "b");
      assert.strictEqual(state.snapshot.error, "");
    });
  }

  for (const method of ["commit", "diff"] as const) {
    test(format("ignores late detail %s after selecting a new commit", method), async () => {
      const provider = new MemoryProvider();
      const gate = deferred<ReadResult<any>>();
      if (method === "commit") {
        const original = provider.commit;
        provider.commit = (sha, signal) =>
          sha === HEAD
            ? (provider.record("commit", sha, signal), gate.promise)
            : original(sha, signal);
      } else {
        const original = provider.diff;
        provider.diff = (query, signal) =>
          query.commit === HEAD
            ? (provider.record("diff", query, signal), gate.promise)
            : original(query, signal);
      }
      const state = await start(provider, { ...LOCATION, commit: HEAD });
      state.configure(provider, { ...LOCATION, commit: OTHER });
      await flush();
      const accepted = state.snapshot;
      gate.resolve(provider.result(method === "commit" ? entry() : patch()));
      await flush();
      assert.strictEqual(state.snapshot, accepted);
      assert.strictEqual(state.snapshot.selected?.sha, OTHER);
      assert.strictEqual(state.snapshot.diff?.toCommit, OTHER);
      if (method === "commit")
        assert.deepStrictEqual(
          provider.calls.filter((call) => call.method === "diff").map((call) => call.input),
          [{ commit: OTHER, path: LOCATION.path, base: "first-parent" }],
        );
    });
  }

  test("ignores late detail rejection after provider replacement", async () => {
    const a = new MemoryProvider("a"),
      b = new MemoryProvider("b");
    const gate = deferred<Awaited<ReturnType<CommitsProvider["diff"]>>>();
    a.diff = () => gate.promise;
    const state = await start(a, { ...LOCATION, commit: HEAD });
    state.configure(b, { ...LOCATION, commit: OTHER });
    await flush();
    const accepted = state.snapshot;
    gate.reject(new Error("old backend credentials must not leak"));
    await flush();
    assert.strictEqual(state.snapshot, accepted);
    assert.strictEqual(state.snapshot.detailError, "");
  });

  for (const kind of ["history", "detail"] as const) {
    test(
      format("detach aborts %s and prevents late publication or continuations", kind),
      async () => {
        const provider = new MemoryProvider();
        const gate = deferred<ReadResult<any>>();
        let notifications = 0;
        if (kind === "history")
          provider.resolve = (ref, signal) => {
            provider.record("resolve", ref, signal);
            return gate.promise;
          };
        else
          provider.commit = (sha, signal) => {
            provider.record("commit", sha, signal);
            return gate.promise;
          };
        const state = reader(500, () => {
          notifications++;
        });
        state.configure(provider, { ...LOCATION, commit: HEAD });
        await flush();
        const accepted = state.snapshot,
          count = notifications,
          calls = provider.calls.length;
        state.detach();
        assert.strictEqual(provider.calls.at(-1)?.signal.aborted, true);
        gate.resolve(
          provider.result(
            kind === "history" ? { requestedRef: LOCATION.ref, commit: HEAD } : entry(),
          ),
        );
        await flush();
        assert.strictEqual(state.snapshot, accepted);
        assert.strictEqual(notifications, count);
        assert.strictEqual(provider.calls.length, calls);
      },
    );
  }

  for (const kind of ["history", "detail"] as const) {
    test(
      format("bounds ignored cancellation with a finite %s timeout and no automatic retry", kind),
      async () => {
        const provider = new MemoryProvider();
        const gate = deferred<ReadResult<any>>();
        if (kind === "history")
          provider.resolve = (ref, signal) => {
            provider.record("resolve", ref, signal);
            return gate.promise;
          };
        else
          provider.diff = (query, signal) => {
            provider.record("diff", query, signal);
            return gate.promise;
          };
        const state = reader(15);
        state.configure(provider, { ...LOCATION, commit: HEAD });
        const deadline = Date.now() + 1000;
        while (!(kind === "history" ? state.snapshot.error : state.snapshot.detailError)) {
          if (Date.now() > deadline) throw new Error("Reader did not finish its finite timeout");
          await delay(1);
        }
        assert.ok(
          (kind === "history" ? state.snapshot.error : state.snapshot.detailError).includes(
            "timed out",
          ),
        );
        assert.strictEqual(provider.calls.at(-1)?.signal.aborted, true);
        const accepted = state.snapshot,
          count = provider.calls.length;
        gate.resolve(
          provider.result(
            kind === "history" ? { requestedRef: LOCATION.ref, commit: HEAD } : patch(),
          ),
        );
        await flush();
        await delay(25);
        assert.strictEqual(provider.calls.length, count);
        assert.strictEqual(state.snapshot, accepted);
      },
    );
  }

  test("a commit-only location change while history is pending survives the late list", async () => {
    const provider = new MemoryProvider();
    const gate = deferred<Awaited<ReturnType<CommitsProvider["list"]>>>();
    provider.list = (query, signal) => {
      provider.record("list", query, signal);
      return gate.promise;
    };
    const state = await start(provider);
    state.configure(provider, { ...LOCATION, commit: OTHER });
    await flush();
    assert.strictEqual(state.snapshot.selected?.sha, OTHER);
    gate.resolve(provider.result({ commits: [entry()], hasMore: false }));
    await flush();
    assert.strictEqual(state.snapshot.location?.commit, OTHER);
    assert.strictEqual(state.snapshot.selected?.sha, OTHER);
    assert.strictEqual(provider.count("commit"), 1);
    assert.strictEqual(provider.count("diff"), 1);
  });

  test("two instances sharing a provider keep independent selections, pages, and lifecycle", async () => {
    const provider = new MemoryProvider();
    provider.rows = Array.from({ length: 81 }, (_, n) => entry(id(n + 1)));
    const a = await start(provider, { ...LOCATION, commit: HEAD });
    const b = await start(provider, { ref: "refs/tags/v1", commit: OTHER });
    const bSnapshot = b.snapshot;
    await a.more();
    a.detach();
    assert.strictEqual(b.snapshot, bSnapshot);
    assert.strictEqual(a.snapshot.commits.length, 81);
    assert.strictEqual(b.snapshot.commits.length, 80);
    assert.strictEqual(b.snapshot.selected?.sha, OTHER);
    assert.deepStrictEqual(b.snapshot.location, { ref: "refs/tags/v1", commit: OTHER });
    await b.more();
    assert.strictEqual(b.snapshot.commits.length, 81);
    assert.strictEqual(b.snapshot.error, "");
  });
});

describe("CommitsReaderState response validation and budgets", () => {
  test("uses the provider's initial ref only when no location was supplied", async () => {
    const provider = new MemoryProvider();
    const state = reader();
    state.configure(provider, undefined);
    await flush();
    assert.strictEqual(provider.count("describe"), 1);
    assert.deepStrictEqual(state.snapshot.location, { ref: LOCATION.ref });
    assert.strictEqual(state.snapshot.revision?.requestedRef, LOCATION.ref);
    assert.strictEqual(state.snapshot.error, "");
  });

  test("rejects an out-of-scope description before resolution or listing", async () => {
    const provider = new MemoryProvider();
    provider.describe = async () => ({
      scopeKey: "another-scope",
      value: { initialRef: LOCATION.ref },
    });
    const state = reader();
    state.configure(provider, undefined);
    await flush();
    expectHistoryFailure(state);
    assert.strictEqual(provider.count("resolve"), 0);
    assert.strictEqual(provider.count("list"), 0);
  });

  for (const method of ["listRefs", "resolve", "list", "commit", "diff"] as const) {
    test(format("rejects out-of-scope %s responses", method), async () => {
      const provider = new MemoryProvider();
      const original = provider[method];
      // Deliberately adversarial envelope; retain each method's ordinary payload.
      (provider as any)[method] = async (...args: any[]) => ({
        ...(await (original as any)(...args)),
        scopeKey: "another-scope",
      });
      const state = await start(provider, { ...LOCATION, commit: HEAD });
      if (method === "commit" || method === "diff") expectDetailFailure(state);
      else expectHistoryFailure(state);
      assert.strictEqual(state.snapshot.diff, undefined);
    });
  }

  for (const [_name, setup] of [
    [
      "duplicate refs",
      (p: MemoryProvider) => {
        p.listRefs = async () =>
          p.result([
            { name: "main", selector: "same", kind: "branch" },
            { name: "also", selector: "same", kind: "tag" },
          ]);
      },
    ],
    [
      "too many refs",
      (p: MemoryProvider) => {
        p.listRefs = async () =>
          p.result(
            Array.from({ length: READER_LIMITS.refs + 1 }, (_, n) => ({
              name: `${n}`,
              selector: `${n}`,
              kind: "branch" as const,
            })),
          );
      },
    ],
    [
      "wrong resolved ref",
      (p: MemoryProvider) => {
        p.resolve = async () => p.result({ requestedRef: "other", commit: HEAD });
      },
    ],
    [
      "abbreviated resolved SHA",
      (p: MemoryProvider) => {
        p.tip = "abc1234";
      },
    ],
    [
      "duplicate page rows",
      (p: MemoryProvider) => {
        p.rows = [entry(), entry()];
      },
    ],
    [
      "oversized page",
      (p: MemoryProvider) => {
        p.list = async () =>
          p.result({
            commits: Array.from({ length: READER_LIMITS.page + 1 }, (_, n) => entry(id(n))),
            hasMore: false,
          });
      },
    ],
    [
      "empty page claiming more",
      (p: MemoryProvider) => {
        p.list = async () => p.result({ commits: [], hasMore: true });
      },
    ],
    [
      "non-boolean hasMore",
      (p: MemoryProvider) => {
        p.list = async () => p.result({ commits: [entry()], hasMore: "yes" as never });
      },
    ],
    [
      "malformed row SHA",
      (p: MemoryProvider) => {
        p.rows = [entry("short")];
      },
    ],
    [
      "malformed parent",
      (p: MemoryProvider) => {
        p.rows = [entry(HEAD, ["short"])];
      },
    ],
    [
      "negative count",
      (p: MemoryProvider) => {
        p.rows = [{ ...entry(), additions: -1 }];
      },
    ],
    [
      "non-bigint author time",
      (p: MemoryProvider) => {
        p.rows = [{ ...entry(), authorTime: 100 as never }];
      },
    ],
    [
      "missing body",
      (p: MemoryProvider) => {
        p.rows = [{ ...entry(), body: undefined as never }];
      },
    ],
  ] as const) {
    test(format("rejects %s without automatic retry", _name), async () => {
      const provider = new MemoryProvider();
      setup(provider);
      const state = await start(provider);
      expectHistoryFailure(state);
      assert.deepStrictEqual(state.snapshot.commits, []);
      const count = provider.calls.length;
      await flush();
      assert.strictEqual(provider.calls.length, count);
    });
  }

  test("rejects duplicates across pages while retaining the last accepted rows", async () => {
    const provider = new MemoryProvider();
    provider.list = async (query, signal) => {
      provider.record("list", query, signal);
      return provider.result({ commits: [entry()], hasMore: true });
    };
    const state = await start(provider);
    await state.more();
    expectHistoryFailure(state);
    assert.deepStrictEqual(
      state.snapshot.commits.map((row) => row.sha),
      [HEAD],
    );
    assert.strictEqual(provider.count("list"), 2);
  });

  test("rejects an anchor lookup returning a different object without resolving or listing", async () => {
    const provider = new MemoryProvider();
    provider.commit = async () => provider.result(entry(OTHER));
    const state = await start(provider, { ...LOCATION, anchor: HEAD });
    expectHistoryFailure(state);
    assert.strictEqual(provider.count("resolve"), 0);
    assert.strictEqual(provider.count("list"), 0);
  });

  test("rejects detail lookup returning a different object before diff", async () => {
    const provider = new MemoryProvider();
    provider.commit = async () => provider.result(entry(OTHER));
    const state = await start(provider, { ...LOCATION, commit: HEAD });
    expectDetailFailure(state);
    assert.strictEqual(state.snapshot.selected, undefined);
    assert.strictEqual(provider.count("diff"), 0);
  });

  for (const [_name, override] of [
    ["wrong target", { toCommit: OTHER }],
    ["oversized ASCII patch", { rawDiff: "x".repeat(READER_LIMITS.patchBytes + 1) }],
    ["oversized UTF-8 patch", { rawDiff: "é".repeat(READER_LIMITS.patchBytes / 2 + 1) }],
    ["invalid completeness", { completeness: { kind: "invented" } }],
    ["missing partial reason", { completeness: { kind: "partial" } }],
    ["non-boolean empty", { empty: "yes" }],
    ["empty contradicting patch", { empty: true }],
    ["malformed files", { files: [{ path: "x" }] }],
  ] as const) {
    test(format("rejects %s", _name), async () => {
      const provider = new MemoryProvider();
      provider.diff = async () => provider.result({ ...patch(), ...override } as CommitDiff);
      expectDetailFailure(await start(provider, { ...LOCATION, commit: HEAD }));
    });
  }

  test("accepts the patch byte boundary and retains raw text beyond presentation limits", async () => {
    const provider = new MemoryProvider();
    const rawDiff = "é".repeat(READER_LIMITS.patchBytes / 2);
    provider.diff = async () => provider.result({ ...patch(), rawDiff });
    const state = await start(provider, { ...LOCATION, commit: HEAD });
    assert.strictEqual(state.snapshot.detailError, "");
    assert.strictEqual(state.snapshot.diff?.rawDiff, rawDiff);
  });

  for (const [_name, completeness, empty] of [
    ["unknown", { kind: "unknown" }, undefined],
    ["partial", { kind: "partial", reason: "Backend truncated the patch" }, undefined],
    ["explicitly empty", { kind: "complete" }, true],
    ["complete but empty unspecified", { kind: "complete" }, undefined],
    ["explicitly nonempty", { kind: "complete" }, false],
  ] as const) {
    test(format("preserves %s without inferring emptiness from blank text", _name), async () => {
      const provider = new MemoryProvider();
      const value: CommitDiff = { ...patch(), rawDiff: "", completeness, empty };
      provider.diff = async () => provider.result(value);
      const state = await start(provider, { ...LOCATION, commit: HEAD });
      assert.strictEqual(state.snapshot.detailError, "");
      assert.deepStrictEqual(state.snapshot.diff?.completeness, completeness);
      assert.strictEqual(state.snapshot.diff?.empty, empty);
    });
  }

  test("stops at the loaded row budget and explicitly distinguishes truncation from exhaustion", async () => {
    const provider = new MemoryProvider();
    provider.rows = Array.from({ length: READER_LIMITS.loadedRows + READER_LIMITS.page }, (_, n) =>
      entry(id(n + 1)),
    );
    const state = await start(provider);
    while (state.snapshot.hasMore) await state.more();
    assert.strictEqual(state.snapshot.commits.length, READER_LIMITS.loadedRows);
    assert.ok(state.snapshot.limitNotice.includes("not the entire history"));
    assert.strictEqual(state.snapshot.error, "");
    const calls = provider.count("list");
    await state.more();
    assert.strictEqual(provider.count("list"), calls);
  });

  test("never exceeds the row budget when the backend returns short nonterminal pages", async () => {
    const provider = new MemoryProvider();
    provider.list = async (query, signal) => {
      provider.record("list", query, signal);
      const size = query.offset === 0 ? READER_LIMITS.page - 1 : query.limit;
      return provider.result({
        commits: Array.from({ length: size }, (_, n) => entry(id(query.offset + n + 1))),
        hasMore: true,
      });
    };
    const state = await start(provider);
    for (let n = 0; n < 6 && state.snapshot.hasMore; n++) await state.more();
    assert.ok(state.snapshot.commits.length <= READER_LIMITS.loadedRows);
    assert.strictEqual(state.snapshot.hasMore, false);
    assert.notStrictEqual(state.snapshot.limitNotice, "");
  });

  test("empty history is successful, not an error or a row-limit notice", async () => {
    const provider = new MemoryProvider();
    provider.rows = [];
    const state = await start(provider);
    assert.deepStrictEqual(state.snapshot.commits, []);
    assert.strictEqual(state.snapshot.hasMore, false);
    assert.strictEqual(state.snapshot.error, "");
    assert.strictEqual(state.snapshot.limitNotice, "");
  });

  test("compatibility failures require a reload rather than offering ineffective retries", async () => {
    const provider = new MemoryProvider();
    provider.listRefs = async (signal) => {
      provider.record("listRefs", undefined, signal);
      throw new RepositoryReadError("incompatible");
    };
    const state = await start(provider);
    assert.strictEqual(state.snapshot.reloadRequired, true);
    assert.ok(state.snapshot.error.includes("Restart or update the server"));
    assert.ok(state.snapshot.error.includes("No repository read was sent"));
    state.retry();
    state.retryDetail();
    state.refresh();
    await flush();
    assert.strictEqual(provider.count("listRefs"), 1);
    state.configure(new MemoryProvider("supported"), LOCATION);
    await flush();
    assert.strictEqual(state.snapshot.error, "");
    assert.strictEqual(state.snapshot.reloadRequired, false);
    assert.strictEqual(state.snapshot.commits.length, 1);
  });

  test("safe adapter timeouts are useful without rendering arbitrary backend errors", async () => {
    const provider = new MemoryProvider();
    provider.listRefs = async () => {
      throw new RepositoryReadError("timeout");
    };
    const state = await start(provider);
    assert.ok(state.snapshot.error.includes("timed out"));
    assert.strictEqual(state.snapshot.reloadRequired, false);
  });

  test("history and detail errors retry only on explicit request and sanitize backend messages", async () => {
    const provider = new MemoryProvider();
    provider.resolve = async (ref, signal) => {
      provider.record("resolve", ref, signal);
      throw new Error("secret-token in backend path");
    };
    const state = await start(provider);
    expectHistoryFailure(state);
    assert.ok(!state.snapshot.error.includes("secret-token"));
    await flush();
    assert.strictEqual(provider.count("resolve"), 1);
    state.retry();
    await flush();
    assert.strictEqual(provider.count("resolve"), 2);

    const good = new MemoryProvider();
    good.diff = async (query, signal) => {
      good.record("diff", query, signal);
      throw new Error("secret-token");
    };
    state.configure(good, { ...LOCATION, commit: HEAD });
    await flush();
    expectDetailFailure(state);
    assert.ok(!state.snapshot.detailError.includes("secret-token"));
    assert.strictEqual(state.snapshot.error, "");
    await flush();
    assert.strictEqual(good.count("diff"), 1);
    state.retryDetail();
    await flush();
    assert.strictEqual(good.count("diff"), 2);
    assert.strictEqual(good.count("list"), 1);
  });
});
