import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { format } from "node:util";
import { create, toJson } from "@bufbuild/protobuf";
import { BranchSchema, CommitEntrySchema, RepoService } from "@jpahd/git-chat-protocol/repo";
import type { CommitsProvider } from "@jpahd/commits-core/contracts";
import { CommitsReaderState } from "@jpahd/commits-core/state";
import { createGitChatCommitsProvider, gitChatReadMethods } from "@jpahd/commits-adapters/git-chat";
import { createGitChatReadingTransport } from "@jpahd/commits-adapters/git-chat-transport";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const HEAD = sha(250),
  PARENT = sha(249),
  ROOT = sha(1);
const scope = () => ({ key: "endpoint-a:repo-a", repositoryKey: "repo-a", label: "Repository A" });
const wireCommit = (id = HEAD, parents = [PARENT]) =>
  toJson(
    CommitEntrySchema,
    create(CommitEntrySchema, {
      sha: id,
      shortSha: id.slice(-7),
      message: "Subject <plain>",
      body: "Full body\n<not-markup>",
      authorName: "Ada",
      authorEmail: "ada@example.invalid",
      authorTime: 1_700_000_000n,
      parentShas: parents,
      filesChanged: 2,
      additions: 4,
      deletions: 1,
    }),
  );
const diff = (to = HEAD, from = PARENT) => ({
  toCommit: to,
  fromCommit: from,
  unifiedDiff: "diff --git a/a b/a\n-old\n+new\n",
  empty: false,
  files: [{ path: "a", status: "modified", additions: 1, deletions: 1, fromPath: "" }],
});
type Call = { method: string; body: Record<string, unknown>; signal: AbortSignal };
function fixture(timeoutMs?: number) {
  const calls: Call[] = [];
  let handler = (call: Call): unknown => {
    if (call.method === "ListBranches")
      return {
        branches: [{ name: "main", commit: HEAD }],
        tags: [{ name: "main", commit: sha(999) }],
      };
    if (call.method === "ListCommits")
      return {
        commits: [
          wireCommit(call.body.ref === ROOT ? ROOT : HEAD, call.body.ref === ROOT ? [] : [PARENT]),
        ],
        hasMore: false,
      };
    if (call.method === "GetDiff")
      return diff(String(call.body.toRef), String(call.body.fromRef ?? ""));
    throw new Error("Unexpected RPC");
  };
  const options = {
    scope: scope(),
    repoId: "registered-repo-a",
    initialRef: "refs/heads/main",
    timeoutMs,
    transport: createGitChatReadingTransport({
      baseUrl: "http://fixture.invalid/api",
      timeoutMs,
      fetch: async (_input, init) => {
        const body =
          typeof init!.body === "string"
            ? init!.body
            : new TextDecoder().decode(init!.body as Uint8Array);
        const call = {
          method: String(_input).split("/").at(-1)!,
          body: JSON.parse(body),
          signal: init!.signal!,
        };
        calls.push(call);
        const value = await handler(call);
        return value instanceof Response ? value : Response.json(value);
      },
    }),
  };
  return {
    calls,
    options,
    provider: createGitChatCommitsProvider(options),
    setHandler(value: typeof handler) {
      handler = value;
    },
  };
}
const signal = () => new AbortController().signal;
const list = (revision = HEAD) => ({
  revision: { requestedRef: "refs/heads/main", commit: revision },
  offset: 0,
  limit: 80,
});

async function rejects(call: () => unknown) {
  await assert.rejects(Promise.resolve().then(call));
}

describe("git-chat Commits adapter — serialized Connect fixtures, no network", () => {
  test("captures exact binding, transport and explicit initial policy without catalog/auth/config calls", async () => {
    const f = fixture();
    f.options.repoId = "new-repo";
    f.options.scope.key = "new-scope";
    f.options.initialRef = "new-policy";
    f.options.transport.unary = () => {
      throw new Error("replaced transport");
    };
    assert.strictEqual((await f.provider.describe(signal())).value.initialRef, "refs/heads/main");
    const result = await f.provider.list(list(), signal());
    assert.strictEqual(result.scopeKey, "endpoint-a:repo-a");
    assert.deepStrictEqual(
      f.calls.map((call) => call.body.repoId),
      ["registered-repo-a"],
    );
    assert.strictEqual(Object.isFrozen(f.provider), true);
    assert.strictEqual(Object.isFrozen(f.provider.scope), true);
    assert.strictEqual(Object.isFrozen(result.value.commits[0].parentShas), true);
    assert.ok(!Object.keys(result.value.commits[0]).includes("$typeName"));
  });

  test("qualifies fallback short branch/tag names and resolves the tag by unfiltered log, not catalog ID", async () => {
    const f = fixture();
    assert.deepStrictEqual((await f.provider.listRefs(signal())).value, [
      { kind: "branch", name: "main", selector: "refs/heads/main" },
      { kind: "tag", name: "main", selector: "refs/tags/main" },
    ]);
    assert.deepStrictEqual((await f.provider.resolve("refs/tags/main", signal())).value, {
      requestedRef: "refs/tags/main",
      commit: HEAD,
    });
    assert.deepStrictEqual(f.calls.at(-1)!.body, {
      repoId: "registered-repo-a",
      ref: "refs/tags/main",
      limit: 1,
    });
  });

  test("canonical full refs distinguish native collisions and literal namespace prefixes", async () => {
    const f = fixture();
    const refs = {
      branches: [
        { name: "heads/main", fullRef: "refs/heads/main", commit: HEAD },
        { name: "heads/heads/main", fullRef: "refs/heads/heads/main", commit: ROOT },
        { name: "refs/heads/topic", fullRef: "refs/heads/refs/heads/topic", commit: PARENT },
      ],
      tags: [{ name: "tags/main", fullRef: "refs/tags/main", commit: sha(999) }],
    };
    f.setHandler((call) =>
      call.method === "ListBranches"
        ? refs
        : {
            commits: [
              wireCommit(
                call.body.ref === "refs/heads/heads/main"
                  ? ROOT
                  : call.body.ref === "refs/tags/main"
                    ? sha(200)
                    : HEAD,
              ),
            ],
          },
    );
    assert.deepStrictEqual((await f.provider.listRefs(signal())).value, [
      { name: "main", kind: "branch", selector: "refs/heads/main" },
      { name: "heads/main", kind: "branch", selector: "refs/heads/heads/main" },
      { name: "refs/heads/topic", kind: "branch", selector: "refs/heads/refs/heads/topic" },
      { name: "main", kind: "tag", selector: "refs/tags/main" },
    ]);
    assert.strictEqual(
      (await f.provider.resolve("refs/heads/heads/main", signal())).value.commit,
      ROOT,
    );
    assert.strictEqual(
      (await f.provider.resolve("refs/tags/main", signal())).value.commit,
      sha(200),
    );
    assert.deepStrictEqual(
      f.calls.slice(1).map((call) => call.body.ref),
      ["refs/heads/heads/main", "refs/tags/main"],
    );
  });

  for (const fullRef of [
    "main",
    "refs/tags/main",
    "refs/remotes/origin/main",
    "refs/heads/",
    "refs/heads/main~1",
    "refs/heads/../main",
    "refs/heads/a b",
  ]) {
    test(
      format("rejects invalid canonical branch selector %j without legacy fallback", fullRef),
      async () => {
        const f = fixture();
        f.setHandler(() => ({ branches: [{ name: "main", fullRef }] }));
        await rejects(() => f.provider.listRefs(signal()));
        assert.strictEqual(f.calls.length, 1);
      },
    );
  }

  test("rejects duplicate canonical selectors even if legacy labels differ", async () => {
    const f = fixture();
    f.setHandler(() => ({
      branches: [
        { name: "heads/main", fullRef: "refs/heads/main" },
        { name: "main", fullRef: "refs/heads/main" },
      ],
    }));
    await rejects(() => f.provider.listRefs(signal()));
    assert.strictEqual(f.calls.length, 1);
  });

  test("rejects ambiguous legacy native short names instead of guessing another fully qualified ref", async () => {
    const f = fixture();
    // Actual native %(refname:short) output for branch/tag main collisions.
    f.setHandler(() => ({
      branches: [{ name: "heads/main", commit: HEAD }],
      tags: [{ name: "tags/main", commit: HEAD }],
    }));
    await rejects(() => f.provider.listRefs(signal()));
    assert.deepStrictEqual(
      f.calls.map((call) => call.method),
      ["ListBranches"],
    );
    // The same wire text can also be a literal fallback branch name; no invented selector.
    f.setHandler(() => ({ branches: [{ name: "heads/main", commit: HEAD }] }));
    await rejects(() => f.provider.listRefs(signal()));
  });

  test("paginates only at a captured full revision and preserves exact whitespace in paths", async () => {
    const f = fixture();
    const query = { ...list(), path: " source file.ts ", offset: 80 };
    const pending = f.provider.list(query, signal());
    query.revision.commit = sha(999);
    query.path = "changed";
    query.offset = 160;
    await pending;
    assert.deepStrictEqual(f.calls[0].body, {
      repoId: "registered-repo-a",
      ref: HEAD,
      limit: 80,
      offset: 80,
      path: " source file.ts ",
    });
  });

  test("normalizes protobuf bigint times, complete metadata and literal bodies without wire fields", async () => {
    const f = fixture();
    const value = (await f.provider.commit(HEAD, signal())).value;
    assert.strictEqual(value.authorTime, 1_700_000_000n);
    assert.strictEqual(value.message, "Subject <plain>");
    assert.strictEqual(value.body, "Full body\n<not-markup>");
    assert.deepStrictEqual(value.parentShas, [PARENT]);
    assert.deepStrictEqual(
      { filesChanged: value.filesChanged, additions: value.additions, deletions: value.deletions },
      { filesChanged: 2, additions: 4, deletions: 1 },
    );
    assert.deepStrictEqual(f.calls[0].body, { repoId: "registered-repo-a", ref: HEAD, limit: 1 });
  });

  test("full-ID resolution and exact detail reject an unrelated returned ancestor", async () => {
    const f = fixture();
    f.setHandler(() => ({ commits: [wireCommit(PARENT)], hasMore: true }));
    await rejects(() => f.provider.commit(HEAD, signal()));
    await rejects(() => f.provider.resolve(HEAD, signal()));
  });

  test("diff validates exact immutable endpoints and keeps first-parent semantics for merges", async () => {
    const f = fixture();
    f.setHandler((call) =>
      call.method === "ListCommits" ? { commits: [wireCommit(HEAD, [PARENT, ROOT])] } : diff(),
    );
    const result = (
      await f.provider.diff({ commit: HEAD, base: "first-parent", path: "a" }, signal())
    ).value;
    assert.deepStrictEqual(result.base, { kind: "commit", commit: PARENT });
    assert.strictEqual(result.toCommit, HEAD);
    assert.deepStrictEqual(result.completeness, { kind: "unknown" });
    assert.deepStrictEqual(f.calls[1].body, {
      repoId: "registered-repo-a",
      toRef: HEAD,
      fromRef: PARENT,
      path: "a",
    });
    assert.strictEqual(Object.hasOwn(f.calls[1].body, "fullRange"), false);
    assert.strictEqual(Object.hasOwn(f.calls[1].body, "filesOnly"), false);
  });

  test("root sends no manufactured parent hash and requires an empty resolved from endpoint", async () => {
    const f = fixture();
    const result = (await f.provider.diff({ commit: ROOT, base: "first-parent" }, signal())).value;
    assert.deepStrictEqual(result.base, { kind: "empty-tree" });
    assert.deepStrictEqual(f.calls[1].body, { repoId: "registered-repo-a", toRef: ROOT });
  });

  for (const [_label, override] of [
    ["wrong target", { toCommit: PARENT }],
    ["wrong parent", { fromCommit: ROOT }],
    ["empty contradicting patch", { empty: true }],
    ["negative changed-file stats", { files: [{ path: "a", status: "modified", additions: -1 }] }],
  ] as const) {
    test(format("rejects %s", _label), async () => {
      const f = fixture();
      f.setHandler((call) =>
        call.method === "ListCommits" ? { commits: [wireCommit()] } : { ...diff(), ...override },
      );
      await rejects(() => f.provider.diff({ commit: HEAD, base: "first-parent" }, signal()));
    });
  }

  test("root rejects a nonempty returned from endpoint", async () => {
    const f = fixture();
    f.setHandler((call) =>
      call.method === "ListCommits" ? { commits: [wireCommit(ROOT, [])] } : diff(ROOT, PARENT),
    );
    await rejects(() => f.provider.diff({ commit: ROOT, base: "first-parent" }, signal()));
  });

  test("preserves structured omissions, raw notices, binary placeholders, rename and file evidence", async () => {
    const f = fixture();
    const raw = "diff --git a/a b/a\nBinary files differ\n… (4 more file(s) truncated)\n";
    const files = [
      { path: "new.ts", fromPath: "old.ts", status: "renamed", additions: 2, deletions: 1 },
      { path: "... and 4 more files", status: "truncated" },
    ] as const;
    f.setHandler((call) =>
      call.method === "ListCommits"
        ? { commits: [wireCommit()] }
        : { ...diff(), unifiedDiff: raw, files },
    );
    const value = (await f.provider.diff({ commit: HEAD, base: "first-parent" }, signal())).value;
    assert.strictEqual(value.rawDiff, raw);
    assert.strictEqual(value.completeness.kind, "partial");
    assert.deepStrictEqual(value.files, [
      { ...files[0] },
      { ...files[1], fromPath: "", additions: 0, deletions: 0 },
    ]);
    assert.strictEqual(value.empty, false);
  });

  for (const raw of [
    "",
    "nothing omitted",
    "… (4 more file(s) truncated)\n",
    "Binary file changed; no source hunks.",
  ]) {
    test(format("never certifies prose/empty/placeholder text complete (%j)", raw), async () => {
      const f = fixture();
      f.setHandler((call) =>
        call.method === "ListCommits"
          ? { commits: [wireCommit()] }
          : { ...diff(), unifiedDiff: raw, files: [] },
      );
      const value = (await f.provider.diff({ commit: HEAD, base: "first-parent" }, signal())).value;
      assert.deepStrictEqual(value.completeness, { kind: "unknown" });
      assert.strictEqual(value.empty, false);
      assert.strictEqual(value.rawDiff, raw);
      assert.strictEqual(value.files, undefined);
    });
  }

  test("retains mode-only changed-file evidence despite the backend's empty=true patch flag", async () => {
    const f = fixture();
    const files = [
      { path: "executable.sh", status: "modified", additions: 0, deletions: 0, fromPath: "" },
    ];
    f.setHandler((call) =>
      call.method === "ListCommits"
        ? { commits: [wireCommit()] }
        : { ...diff(), unifiedDiff: "", files, empty: true },
    );
    const value = (await f.provider.diff({ commit: HEAD, base: "first-parent" }, signal())).value;
    assert.strictEqual(value.rawDiff, "");
    assert.deepStrictEqual(value.files, files);
    assert.strictEqual(value.empty, undefined);
    assert.deepStrictEqual(value.completeness, { kind: "unknown" });
  });

  test("an explicit backend empty response stays distinct from absence of patch text", async () => {
    const f = fixture();
    f.setHandler((call) =>
      call.method === "ListCommits"
        ? { commits: [wireCommit()] }
        : { ...diff(), unifiedDiff: "", files: [], empty: true },
    );
    const value = (await f.provider.diff({ commit: HEAD, base: "first-parent" }, signal())).value;
    assert.strictEqual(value.empty, true);
    assert.deepStrictEqual(value.files, []);
    assert.deepStrictEqual(value.completeness, { kind: "unknown" });
  });

  for (const repoId of ["", "a\0b", "x".repeat(257)]) {
    test(format("rejects missing/invalid exact registry ID %j", repoId), () => {
      const f = fixture();
      assert.throws(() => createGitChatCommitsProvider({ ...f.options, repoId }));
      assert.deepStrictEqual(f.calls, []);
    });
  }

  for (const path of [
    "../escape",
    "./normalized",
    "a//b",
    "a/./b",
    "/absolute",
    "a\\b",
    "a/",
    "a\0b",
    "src/*.ts",
    "a?b",
    "a[b]",
    ":(exclude)a",
  ]) {
    test(format("rejects nonliteral/unsafe common exact path %j", path), async () => {
      const f = fixture();
      await rejects(() => f.provider.list({ ...list(), path }, signal()));
      assert.deepStrictEqual(f.calls, []);
    });
  }

  for (const override of [
    { limit: 0 },
    { limit: 81 },
    { limit: 1.5 },
    { offset: -1 },
    { offset: 10_001 },
    { offset: 1.5 },
  ]) {
    test(
      format("rejects query outside common pagination bounds %j instead of clamping", override),
      async () => {
        const f = fixture();
        await rejects(() => f.provider.list({ ...list(), ...override }, signal()));
        assert.deepStrictEqual(f.calls, []);
      },
    );
  }

  for (const ref of ["-all", "^main", "main..topic", "HEAD^!", "HEAD^@", ""]) {
    test(format("rejects non-single-ref resolution %j", ref), async () => {
      const f = fixture();
      await rejects(() => f.provider.resolve(ref, signal()));
      assert.deepStrictEqual(f.calls, []);
    });
  }

  for (const [_label, value] of [
    ["duplicate refs", { branches: [{ name: "main" }, { name: "main" }] }],
    [
      "excessive refs",
      { branches: Array.from({ length: 2001 }, (_, index) => ({ name: `branch-${index}` })) },
    ],
    ["empty refs", { branches: [{ name: "" }] }],
  ]) {
    test(format("rejects %s", _label), async () => {
      const f = fixture();
      f.setHandler(() => value);
      await rejects(() => f.provider.listRefs(signal()));
      assert.strictEqual(f.calls.length, 1);
    });
  }

  for (const [_label, value] of [
    ["empty lookup", { commits: [] }],
    ["duplicate rows", { commits: [wireCommit(), wireCommit()] }],
    ["empty page claims more", { commits: [], hasMore: true }],
    ["short commit id", { commits: [{ ...(wireCommit() as object), sha: "short" }] }],
    ["negative author time", { commits: [{ ...(wireCommit() as object), authorTime: "-1" }] }],
    ["oversized body", { commits: [{ ...(wireCommit() as object), body: "x".repeat(65_537) }] }],
  ]) {
    test(format("rejects malformed metadata: %s", _label), async () => {
      const f = fixture();
      f.setHandler(() => value);
      await rejects(() => f.provider.commit(HEAD, signal()));
      assert.strictEqual(f.calls.length, 1);
    });
  }

  test("rejects oversized patch bytes without silently clipping or fetching full_range", async () => {
    const f = fixture();
    f.setHandler((call) =>
      call.method === "ListCommits"
        ? { commits: [wireCommit()] }
        : { ...diff(), unifiedDiff: "é".repeat(1024 * 1024 + 1) },
    );
    await rejects(() => f.provider.diff({ commit: HEAD, base: "first-parent" }, signal()));
    assert.strictEqual(f.calls.length, 2);
    assert.strictEqual(f.calls[1].body.fullRange, undefined);
  });

  test("never falls back after unauthenticated/missing-repo error and redacts public failure details", async () => {
    const f = fixture();
    f.setHandler(() =>
      Response.json(
        { code: "unauthenticated", message: "secret-token /private/backend/path" },
        { status: 401 },
      ),
    );
    let failure: unknown;
    try {
      await f.provider.list(list(), signal());
    } catch (error) {
      failure = error;
    }
    assert.ok(String(failure).includes("Repository read unavailable"));
    assert.ok(!String(failure).includes("secret-token"));
    assert.strictEqual((failure as Error).cause, undefined);
    assert.strictEqual(f.calls.length, 1);
  });

  test("aborting during metadata prevents a follow-on diff even when fetch ignores the signal", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.setHandler(() => {
      controller.abort();
      return { commits: [wireCommit()] };
    });
    await rejects(() => f.provider.diff({ commit: HEAD, base: "first-parent" }, controller.signal));
    assert.deepStrictEqual(
      f.calls.map((call) => call.method),
      ["ListCommits"],
    );
    assert.strictEqual(f.calls[0].signal.aborted, true);
  });

  test("ignored fetch cancellation has a finite local wait and no retry", async () => {
    const f = fixture(20);
    f.setHandler(() => new Promise<never>(() => {}));
    await rejects(() => f.provider.list(list(), signal()));
    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(f.calls[0].signal.aborted, true);
  });

  test("a pre-aborted read issues no transport request", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await rejects(() => f.provider.list(list(), controller.signal));
    assert.deepStrictEqual(f.calls, []);
  });

  test("the DOM-free shared state consumes the real serialized adapter without any agent APIs", async () => {
    const f = fixture();
    const state = new CommitsReaderState(() => {});
    state.configure(f.provider, { ref: "refs/heads/main", path: "a", commit: HEAD });
    for (let i = 0; i < 20 && !state.snapshot.diff; i++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.strictEqual(state.snapshot.diff?.toCommit, HEAD);
    assert.strictEqual(state.snapshot.selected?.message, "Subject <plain>");
    assert.strictEqual(
      f.calls.every((call) => (gitChatReadMethods as readonly string[]).includes(call.method)),
      true,
    );
    state.detach();
  });
});

test("generated read descriptors preserve the baseline and add canonical Branch.full_ref at field 5", () => {
  assert.deepStrictEqual(
    BranchSchema.fields.map((field) => [field.name, field.number, field.scalar]),
    [
      ["name", 1, 9],
      ["commit", 2, 9],
      ["committer_time", 3, 3],
      ["subject", 4, 9],
      ["full_ref", 5, 9],
    ],
  );
  const fields = (method: "listBranches" | "listCommits" | "getDiff", side: "input" | "output") =>
    RepoService.method[method][side].fields.map((field) => [
      field.name,
      field.number,
      field.scalar ?? field.message?.typeName,
    ]);
  assert.deepStrictEqual(fields("listBranches", "input"), [["repo_id", 1, 9]]);
  assert.deepStrictEqual(fields("listBranches", "output"), [
    ["branches", 1, "gitchat.v1.Branch"],
    ["tags", 2, "gitchat.v1.Branch"],
  ]);
  assert.deepStrictEqual(fields("listCommits", "input"), [
    ["repo_id", 1, 9],
    ["ref", 2, 9],
    ["limit", 3, 5],
    ["offset", 4, 5],
    ["path", 5, 9],
  ]);
  assert.deepStrictEqual(fields("listCommits", "output"), [
    ["commits", 1, "gitchat.v1.CommitEntry"],
    ["has_more", 2, 8],
  ]);
  assert.deepStrictEqual(fields("getDiff", "input"), [
    ["repo_id", 1, 9],
    ["from_ref", 2, 9],
    ["to_ref", 3, 9],
    ["path", 4, 9],
    ["detect_renames", 5, 8],
    ["from_path", 6, 9],
    ["full_range", 7, 8],
    ["files_only", 8, 8],
  ]);
  assert.deepStrictEqual(fields("getDiff", "output"), [
    ["unified_diff", 1, 9],
    ["from_commit", 2, 9],
    ["to_commit", 3, 9],
    ["empty", 4, 8],
    ["files", 5, "gitchat.v1.ChangedFile"],
  ]);
});

// Compile-time boundary: callers consume only the feature's provider contract.
const providerContract: (
  value: ReturnType<typeof createGitChatCommitsProvider>,
) => CommitsProvider = (value) => value;
void providerContract;
