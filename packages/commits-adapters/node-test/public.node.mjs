import assert from "node:assert/strict";
import { test } from "node:test";

for (const name of ["window", "document", "HTMLElement", "customElements"])
  Object.defineProperty(globalThis, name, { configurable: true, get() { throw new Error(`Unexpected DOM access: ${name}`); } });
const { captureScope, exactPath, listQuery, objectId, readingRef, readOperation, readTimeout,
  ReadingAdapterError } = await import("@jpahd/commits-adapters/common");
const { createGitChatCommitsProvider, gitChatReadMethods } = await import("@jpahd/commits-adapters/git-chat");
const { createGitChatReadingTransport, GIT_CHAT_RESPONSE_BYTES } = await import("@jpahd/commits-adapters/git-chat-transport");
const { RepositoryReadError } = await import("@jpahd/commits-core/contracts");
const { CommitsReaderState } = await import("@jpahd/commits-core/state");
const { createClient, Code, ConnectError } = await import("@connectrpc/connect");
const { RepoService } = await import("@jpahd/git-chat-protocol/repo");

const HEAD = "a".repeat(40), PARENT = "b".repeat(40), ROOT = "c".repeat(64);
const signal = () => new AbortController().signal;
const list = () => ({ revision: { requestedRef: "refs/heads/main", commit: HEAD }, limit: 80, offset: 0 });
const wireCommit = (sha = HEAD, parentShas = [PARENT]) => ({ sha, shortSha: sha.slice(0, 8),
  message: "Subject <literal>", body: "Body\n<literal>", authorName: "Reader", authorEmail: "reader@example.invalid",
  authorTime: "1700000000", parentShas, additions: 1, deletions: 0, filesChanged: 1 });
const diff = () => ({ toCommit: HEAD, fromCommit: PARENT, unifiedDiff: "-old\n+new\n", empty: false,
  files: [{ path: "new.ts", fromPath: "old.ts", status: "renamed", additions: 1, deletions: 1 }] });
function fixture(timeoutMs = 500) {
  const calls = [];
  let handler = (call) => {
    if (call.method === "ListBranches") return { branches: [{ name: "heads/main", fullRef: "refs/heads/main" }], tags: [{ name: "tags/main", fullRef: "refs/tags/main", commit: PARENT }] };
    if (call.method === "ListCommits") return { commits: [wireCommit(call.body.ref === ROOT ? ROOT : HEAD, call.body.ref === ROOT ? [] : [PARENT])] };
    if (call.method === "GetDiff") return { ...diff(), toCommit: call.body.toRef, fromCommit: call.body.fromRef ?? "" };
    assert.fail(`Unexpected RPC ${call.method}`);
  };
  const options = { baseUrl: "http://fixture.invalid/api", timeoutMs, fetch: async (input, init) => {
    const text = typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body);
    const call = { method: String(input).split("/").at(-1), body: JSON.parse(text), init };
    calls.push(call);
    const value = await handler(call);
    return value instanceof Response ? value : Response.json(value);
  } };
  const transport = createGitChatReadingTransport(options);
  const binding = { transport, repoId: "registered-repo", scope: { key: "endpoint:repo", repositoryKey: "repo", label: "Repository" },
    initialRef: "refs/heads/main", timeoutMs };
  return { provider: createGitChatCommitsProvider(binding), calls, transport, options, binding,
    setHandler(value) { handler = value; } };
}

test("compiled common entry snapshots bindings and shares safe error identity", () => {
  const source = { key: "key", repositoryKey: "repo", label: "Label", root: "not-copied" };
  const captured = captureScope(source); source.key = "changed";
  assert.deepEqual(captured, { key: "key", repositoryKey: "repo", label: "Label" });
  assert.ok(Object.isFrozen(captured));
  assert.ok(new ReadingAdapterError("invalid") instanceof RepositoryReadError);
  assert.equal(objectId(ROOT), ROOT);
  for (const value of [null, "short", { toString: () => HEAD }]) assert.throws(() => objectId(value));
  assert.equal(exactPath(" spaced\nfile.ts "), " spaced\nfile.ts ");
  for (const path of ["./a", "a/../b", "a//b", "a\\b", "a/", "a?b", ":(glob)*"]) assert.throws(() => exactPath(path));
  assert.equal(readingRef("refs/heads/topic", "branch").selector, "refs/heads/refs/heads/topic");
  const input = list(), query = listQuery(input); input.revision.commit = PARENT;
  assert.equal(query.revision.commit, HEAD);
  assert.throws(() => listQuery({ ...list(), offset: 10_001 }));
  for (const timeout of [0, -1, 10_001, Infinity, 1.5]) assert.throws(() => readTimeout(timeout));
});

test("read operations sanitize failures and fence pre-aborted continuations", async () => {
  await assert.rejects(readOperation(signal(), 100, async () => { throw new Error("fixture-sensitive-text"); }),
    (error) => error instanceof ReadingAdapterError && error.code === "unavailable" && !String(error).includes("sensitive") && error.cause === undefined);
  const controller = new AbortController(); let calls = 0;
  const pending = readOperation(controller.signal, 100, async () => { calls++; }); controller.abort();
  await assert.rejects(pending);
  assert.equal(calls, 0);
  await assert.rejects(readOperation(signal(), 10, () => new Promise(() => {})), (error) => error.code === "timeout");
});

test("Node22 fetch primitives consume serialized Connect JSON without network/Bun/DOM", async () => {
  const f = fixture();
  f.binding.repoId = "changed"; f.binding.scope.key = "changed";
  f.options.fetch = async () => { assert.fail("mutable options must not replace captured fetch"); };
  assert.equal((await f.provider.describe(signal())).value.initialRef, "refs/heads/main");
  assert.deepEqual((await f.provider.listRefs(signal())).value, [
    { name: "main", selector: "refs/heads/main", kind: "branch" }, { name: "main", selector: "refs/tags/main", kind: "tag" }]);
  assert.equal((await f.provider.resolve("refs/tags/main", signal())).value.commit, HEAD);
  const value = (await f.provider.commit(HEAD, signal())).value;
  assert.equal(value.authorTime, 1_700_000_000n);
  assert.equal(value.body, "Body\n<literal>");
  assert.ok(!("$typeName" in value));
  assert.ok(Object.isFrozen(value.parentShas));
  await f.provider.list({ ...list(), offset: 80, path: " exact\nname " }, signal());
  assert.deepEqual(f.calls.at(-1).body, { repoId: "registered-repo", ref: HEAD, limit: 80, offset: 80, path: " exact\nname " });
  assert.ok(f.calls.every((call) => gitChatReadMethods.includes(call.method) && call.body.repoId === "registered-repo"));
});

test("first-parent and root diffs keep immutable endpoints and unknown completeness", async () => {
  const f = fixture();
  const value = (await f.provider.diff({ commit: HEAD, base: "first-parent", path: "new.ts" }, signal())).value;
  assert.deepEqual(value.base, { kind: "commit", commit: PARENT });
  assert.deepEqual(value.completeness, { kind: "unknown" });
  assert.equal(value.files[0].fromPath, "old.ts");
  assert.deepEqual(f.calls.at(-1).body, { repoId: "registered-repo", toRef: HEAD, fromRef: PARENT, path: "new.ts" });
  assert.deepEqual((await f.provider.diff({ commit: ROOT, base: "first-parent" }, signal())).value.base, { kind: "empty-tree" });
  assert.deepEqual(f.calls.at(-1).body, { repoId: "registered-repo", toRef: ROOT });
});

for (const [name, override, expected] of [
  ["mode-only", { unifiedDiff: "", empty: true }, { kind: "unknown", empty: undefined }],
  ["explicit empty", { unifiedDiff: "", empty: true, files: [] }, { kind: "unknown", empty: true }],
  ["prose omission", { unifiedDiff: "… (4 more file(s) truncated)\n", files: [] }, { kind: "unknown", empty: false }],
  ["structured omission", { files: [{ path: "omitted", status: "truncated" }] }, { kind: "partial", empty: false }],
]) test(`preserves ${name} evidence, never upgrades completeness`, async () => {
  const f = fixture();
  f.setHandler((call) => call.method === "ListCommits" ? { commits: [wireCommit()] } : { ...diff(), ...override });
  const value = (await f.provider.diff({ commit: HEAD, base: "first-parent" }, signal())).value;
  assert.equal(value.completeness.kind, expected.kind);
  assert.equal(value.empty, expected.empty);
  assert.equal(value.rawDiff, override.unifiedDiff ?? diff().unifiedDiff);
});

for (const [name, response] of [
  ["wrong target", { ...diff(), toCommit: PARENT }],
  ["wrong base", { ...diff(), fromCommit: ROOT }],
  ["contradictory empty", { ...diff(), empty: true }],
  ["oversized UTF-8 patch", { ...diff(), unifiedDiff: "é".repeat(1024 * 1024 + 1) }],
]) test(`refuses ${name} without retries or full-range fallback`, async () => {
  const f = fixture();
  f.setHandler((call) => call.method === "ListCommits" ? { commits: [wireCommit()] } : response);
  await assert.rejects(f.provider.diff({ commit: HEAD, base: "first-parent" }, signal()));
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].body.fullRange, undefined);
});

test("unsafe queries refuse locally and ambiguous refs never trigger fallback", async () => {
  const f = fixture();
  for (const path of ["../escape", "a//b", "src/*.ts", ":(exclude)a"])
    await assert.rejects(f.provider.list({ ...list(), path }, signal()));
  for (const ref of ["-all", "^main", "main..topic", "HEAD^!", ""])
    await assert.rejects(f.provider.resolve(ref, signal()));
  assert.equal(f.calls.length, 0);
  f.setHandler(() => ({ branches: [{ name: "heads/main" }] }));
  await assert.rejects(f.provider.listRefs(signal()));
  assert.equal(f.calls.length, 1);
});

for (const baseUrl of ["/relative", "ftp://fixture.invalid", "http://user:password@fixture.invalid", "http://fixture.invalid/?", "http://fixture.invalid/#"]) test(`transport refuses unsafe URL ${baseUrl}`, () => {
  assert.throws(() => createGitChatReadingTransport({ baseUrl, fetch: async () => Response.json({}) }));
});

test("transport forwards only POST read RPCs, preserves auth headers/cookies and protocol errors", async () => {
  const f = fixture(), client = createClient(RepoService, f.transport);
  await assert.rejects(client.listRepos({})); await assert.rejects(client.getConfig({}));
  assert.equal(f.calls.length, 0);
  f.setHandler(() => Response.json({}, { headers: { "set-cookie": "fixture=opaque; HttpOnly" } }));
  let cookie;
  await client.listBranches({ repoId: "registered-repo" }, { headers: { "x-fixture-auth": "opaque" }, onHeader: (headers) => { cookie = headers.get("set-cookie"); } });
  assert.equal(f.calls[0].init.method, "POST");
  assert.equal(f.calls[0].init.redirect, "error");
  assert.equal(new Headers(f.calls[0].init.headers).get("x-fixture-auth"), "opaque");
  assert.match(cookie, /fixture=opaque/);
  f.setHandler(() => Response.json({ code: "unauthenticated", message: "fixture-sensitive-text" }, { status: 401 }));
  await assert.rejects(client.listBranches({}), (error) => error instanceof ConnectError && error.code === Code.Unauthenticated);
  await assert.rejects(f.provider.list(list(), signal()), (error) => error.code === "unavailable" && !String(error).includes("sensitive"));
  assert.equal(f.calls.length, 3);
});

for (const declared of [undefined, "1", String(GIT_CHAT_RESPONSE_BYTES + 1)]) test(`response byte cap cancels streams (length=${declared})`, async () => {
  let cancelled = false, pulls = 0;
  const f = fixture();
  f.setHandler(() => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024 * 1024).fill(32)); },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "application/json", ...(declared ? { "content-length": declared } : {}) } }));
  await assert.rejects(f.provider.listRefs(signal()));
  assert.equal(cancelled, true);
  assert.ok(pulls <= (declared === String(GIT_CHAT_RESPONSE_BYTES + 1) ? 1 : 11));
  assert.equal(f.calls.length, 1);
});

test("exact response byte boundary succeeds without clipping", async () => {
  const f = fixture();
  const wrapper = JSON.stringify({ branches: [{ name: "main" }], padding: "" });
  const body = JSON.stringify({ branches: [{ name: "main" }], padding: "x".repeat(GIT_CHAT_RESPONSE_BYTES - wrapper.length) });
  assert.equal(Buffer.byteLength(body), GIT_CHAT_RESPONSE_BYTES);
  f.setHandler(() => new Response(body, { headers: { "content-type": "application/json" } }));
  assert.equal((await f.provider.listRefs(signal())).value[0].selector, "refs/heads/main");
});

test("caller abort prevents follow-on diff even when fetch ignores cancellation", async () => {
  const f = fixture(), controller = new AbortController();
  f.setHandler(() => { controller.abort(); return { commits: [wireCommit()] }; });
  await assert.rejects(f.provider.diff({ commit: HEAD, base: "first-parent" }, controller.signal));
  assert.deepEqual(f.calls.map((call) => call.method), ["ListCommits"]);
  assert.equal(f.calls[0].init.signal.aborted, true);
});

test("late fetch bodies are canceled after caller abort settles", async () => {
  let release, started, cancelled = false;
  const fetching = new Promise((resolve) => { started = resolve; });
  const transport = createGitChatReadingTransport({ baseUrl: "http://fixture.invalid", fetch: async () => {
    started(); return new Promise((resolve) => { release = resolve; });
  } });
  const controller = new AbortController();
  const pending = createClient(RepoService, transport).listBranches({}, { signal: controller.signal });
  await fetching; controller.abort(); await assert.rejects(pending);
  release(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(cancelled, true);
});

test("stalled response body has a finite deadline and cancellation", async () => {
  const f = fixture(15); let cancelled = false;
  f.setHandler(() => new Response(new ReadableStream({ pull() {}, cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } }));
  await assert.rejects(f.provider.listRefs(signal()));
  assert.equal(cancelled, true);
  assert.equal(f.calls.length, 1);
});

test("compiled reader state consumes the serialized Node adapter", async () => {
  const f = fixture();
  let complete;
  const done = new Promise((resolve) => { complete = resolve; });
  const state = new CommitsReaderState(() => { if (state.snapshot.diff || state.snapshot.error || state.snapshot.detailError) complete(); });
  try {
    state.configure(f.provider, { ref: "refs/heads/main", commit: HEAD, path: "new.ts" });
    await done;
    assert.equal(state.snapshot.error, ""); assert.equal(state.snapshot.detailError, "");
    assert.equal(state.snapshot.selected.sha, HEAD);
    assert.equal(state.snapshot.diff.toCommit, HEAD);
    assert.deepEqual(state.snapshot.diff.completeness, { kind: "unknown" });
  } finally { state.detach(); }
});
