import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

// Fail even on attempted DOM access, before loading the compiled public entries.
for (const name of ["window", "document", "HTMLElement", "customElements"])
  Object.defineProperty(globalThis, name, { configurable: true, get() { throw new Error(`Unexpected DOM access: ${name}`); } });
const { fullCommit, readingLocation, locationSearch, locationFromSearch, patchPresentation,
  structuredPatchSafe, READER_LIMITS, RepositoryReadError } = await import("@jpahd/commits-core/contracts");
const { CommitsReaderState } = await import("@jpahd/commits-core/state");

const id = (n, length = 40) => n.toString(16).padStart(length, "0");
const HEAD = id(100), PARENT = id(99), OTHER = id(900);
const location = { ref: "refs/heads/main", path: "exact file.ts" };
const entry = (sha = HEAD, parentShas = [PARENT]) => ({ sha, shortSha: sha.slice(0, 8),
  message: "Subject <literal>", body: "Full body", authorName: "Reader", authorEmail: "reader@example.invalid",
  authorTime: 1_700_000_000n, parentShas, additions: 1, deletions: 0, filesChanged: 1 });
function fixture(key = "memory") {
  const calls = [], scope = { key, repositoryKey: `repo:${key}`, label: key };
  const result = (value) => ({ scopeKey: key, value });
  const provider = { scope,
    describe: async () => result({ initialRef: location.ref }),
    listRefs: async () => result([{ name: "main", selector: location.ref, kind: "branch" }]),
    resolve: async (ref) => result({ requestedRef: ref, commit: HEAD }),
    list: async (query) => { calls.push(query); return result({ commits: [entry()], hasMore: false }); },
    commit: async (sha) => result(entry(sha, sha === OTHER ? [] : [PARENT])),
    diff: async (query) => result({ toCommit: query.commit,
      base: query.commit === OTHER ? { kind: "empty-tree" } : { kind: "commit", commit: PARENT },
      rawDiff: "", completeness: { kind: "unknown" }, empty: undefined }),
  };
  return { provider, calls, result };
}
const states = [];
afterEach(() => { for (const state of states.splice(0)) state.detach(); });
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
async function start(provider, input = location, timeout = 500) {
  const state = new CommitsReaderState(() => {}, timeout);
  states.push(state);
  state.configure(provider, input);
  await flush();
  return state;
}

test("compiled contracts/state load without a DOM or Bun", () => {
  assert.equal(typeof CommitsReaderState, "function");
  assert.ok(Object.isFrozen(READER_LIMITS));
  assert.deepEqual(locationFromSearch(""), { ref: "HEAD" });
});

test("locations round-trip full IDs and literal paths, never scope identity", () => {
  const input = { ref: "refs/heads/café + &", anchor: HEAD, path: "a?#%\nfile", commit: id(3, 64) };
  assert.deepEqual(locationFromSearch(locationSearch(input)), input);
  assert.ok(Object.isFrozen(readingLocation(input)));
  assert.deepEqual(locationFromSearch("ref=HEAD&path="), { ref: "HEAD", path: "" });
  for (const value of ["", "abc1234", "A".repeat(40), "g".repeat(40), "a".repeat(63)])
    assert.throws(() => fullCommit(value));
  assert.equal(fullCommit(id(1, 64)), id(1, 64));
  for (const ref of ["", "a\0b", "a\nb", "a".repeat(1025)]) assert.throws(() => readingLocation({ ref }));
});

for (const ending of ["\n", "\r", "\r\n"]) test(`presentation bounds preserve literal UTF-8 and ${JSON.stringify(ending)}`, () => {
  const raw = (`+é🙂${ending}`).repeat(80_000) + "<ending>";
  const shown = patchPresentation(raw);
  assert.equal(shown.clipped, true);
  assert.ok(raw.startsWith(shown.text));
  assert.ok(raw.endsWith(shown.tail));
  assert.ok(Buffer.byteLength(shown.text + shown.tail) <= READER_LIMITS.renderPatchBytes);
  assert.ok(shown.text.split(/\r\n?|\n/).length + shown.tail.split(/\r\n?|\n/).length <= READER_LIMITS.renderPatchLines);
  assert.ok(!shown.text.includes("�") && !shown.tail.includes("�"));
  assert.equal(structuredPatchSafe(`-${"old ".repeat(200)}${ending}+${"new ".repeat(200)}`), false);
  assert.equal(structuredPatchSafe(`-old${ending}+new`), true);
});

test("compiled state pins pagination, retains exact detail and explicitly refreshes", async () => {
  const f = fixture();
  const rows = Array.from({ length: READER_LIMITS.page + 1 }, (_, n) => entry(id(n + 1)));
  f.provider.list = async (query) => { f.calls.push(query); return f.result({
    commits: rows.slice(query.offset, query.offset + query.limit), hasMore: query.offset + query.limit < rows.length }); };
  const state = await start(f.provider, { ...location, commit: OTHER });
  assert.equal(state.snapshot.error, "");
  assert.equal(state.snapshot.selected.sha, OTHER);
  assert.deepEqual(state.snapshot.diff.base, { kind: "empty-tree" });
  assert.deepEqual(state.snapshot.diff.completeness, { kind: "unknown" });
  assert.equal(state.snapshot.diff.empty, undefined);
  f.provider.resolve = async (ref) => f.result({ requestedRef: ref, commit: OTHER });
  await state.more();
  assert.deepEqual(f.calls.map((query) => [query.revision.commit, query.offset, query.path]),
    [[HEAD, 0, location.path], [HEAD, 80, location.path]]);
  assert.equal(state.snapshot.commits.length, 81);
  assert.ok(Object.isFrozen(state.snapshot.commits[0].parentShas));
  state.refresh(); await flush();
  assert.equal(state.snapshot.revision.commit, OTHER);
});

test("instances sharing a provider retain independent selection and lifecycle", async () => {
  const f = fixture();
  const a = await start(f.provider, { ...location, commit: HEAD });
  const b = await start(f.provider, { ref: "refs/tags/independent", commit: OTHER });
  const accepted = b.snapshot;
  a.detach();
  a.configure(undefined, undefined);
  assert.equal(b.snapshot, accepted);
  assert.equal(b.snapshot.selected.sha, OTHER);
  assert.equal(b.snapshot.location.ref, "refs/tags/independent");
  assert.equal(a.snapshot.selected.sha, HEAD);
});

test("saved anchor bypasses symbolic resolution", async () => {
  const f = fixture();
  f.provider.resolve = async () => { assert.fail("must not resolve saved anchor"); };
  const state = await start(f.provider, { ...location, anchor: OTHER });
  assert.equal(state.snapshot.revision.commit, OTHER);
  assert.equal(state.snapshot.error, "");
});

test("rebind aborts old reads and prevents late follow-on work/publication", async () => {
  const a = fixture("a"), b = fixture("b");
  let release, signal;
  a.provider.resolve = (_ref, input) => { signal = input; return new Promise((resolve) => { release = resolve; }); };
  const state = await start(a.provider);
  state.configure(b.provider, location); await flush();
  const accepted = state.snapshot;
  assert.equal(signal.aborted, true);
  release(a.result({ requestedRef: location.ref, commit: OTHER })); await flush();
  assert.equal(state.snapshot, accepted);
  assert.equal(a.calls.length, 0);
  assert.equal(b.calls.length, 1);
});

for (const [name, change] of [
  ["wrong scope", (f) => { f.provider.listRefs = async () => ({ scopeKey: "other", value: [] }); }],
  ["duplicate rows", (f) => { f.provider.list = async () => f.result({ commits: [entry(), entry()], hasMore: false }); }],
  ["empty nonterminal page", (f) => { f.provider.list = async () => f.result({ commits: [], hasMore: true }); }],
]) test(`compiled state refuses ${name} without retries`, async () => {
  const f = fixture(); change(f);
  const state = await start(f.provider);
  assert.ok(state.snapshot.error);
  assert.deepEqual(state.snapshot.commits, []);
  const accepted = state.snapshot; await flush(); assert.equal(state.snapshot, accepted);
});

test("loaded-row limit is a notice, not a claim of complete history", async () => {
  const f = fixture();
  f.provider.list = async (query) => f.result({ commits: Array.from({ length: query.limit }, (_, n) => entry(id(query.offset + n + 1))), hasMore: true });
  const state = await start(f.provider);
  while (state.snapshot.hasMore) await state.more();
  assert.equal(state.snapshot.commits.length, READER_LIMITS.loadedRows);
  assert.match(state.snapshot.limitNotice, /not the entire history/);
  assert.equal(state.snapshot.error, "");
});

for (const override of [
  { toCommit: OTHER }, { base: { kind: "empty-tree" } },
  { rawDiff: "é".repeat(READER_LIMITS.patchBytes / 2 + 1) },
  { rawDiff: "+line", empty: true }, { completeness: { kind: "invented" } },
]) test(`compiled state refuses invalid detail ${Object.keys(override).join(",")}`, async () => {
  const f = fixture(), diff = f.provider.diff;
  f.provider.diff = async (query) => f.result({ ...(await diff(query)).value, ...override });
  const state = await start(f.provider, { ...location, commit: HEAD });
  assert.ok(state.snapshot.detailError);
  assert.equal(state.snapshot.diff, undefined);
});

test("incompatible failures keep explicit no-retry/reload semantics", async () => {
  const f = fixture(); let calls = 0;
  f.provider.listRefs = async () => { calls++; throw new RepositoryReadError("incompatible"); };
  const state = await start(f.provider);
  assert.equal(state.snapshot.reloadRequired, true);
  assert.match(state.snapshot.error, /No repository read was sent/);
  state.retry(); state.retryDetail(); state.refresh(); await flush();
  assert.equal(calls, 1);
});

test("ignored cancellation has a finite local timeout and no backend-text leak", async () => {
  const f = fixture(); let signal;
  f.provider.resolve = (_ref, input) => { signal = input; return new Promise(() => {}); };
  const state = await start(f.provider, location, 10);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(state.snapshot.error, /timed out/);
  assert.equal(signal.aborted, true);
  f.provider.resolve = async () => { throw new Error("fixture-sensitive-backend-text"); };
  state.retry(); await flush();
  assert.ok(state.snapshot.error);
  assert.ok(!state.snapshot.error.includes("fixture-sensitive"));
});
