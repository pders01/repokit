import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parseAnnotationArgs } from "@jpahd/source-annotations/cli";
import { author, cli, createInput, fixture } from "./helpers.mjs";

function success(result) {
  assert.equal(result.stderr, "");
  assert.equal(result.code, 0);
  return JSON.parse(result.stdout);
}
function failure(result, expected) {
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.match(JSON.parse(result.stderr).error, expected);
}

test("compiled CLI exports import without execution; Node bin help/argument errors do not touch storage", async (t) => {
  const { directory, base, root } = await fixture(t);
  assert.deepEqual(parseAnnotationArgs(["--cwd", root, "list", "--ref=HEAD", "--include-resolved"]), {
    cwd: root, command: "list", help: false, ref: "HEAD", includeResolved: true,
  });
  const options = { home: directory, env: { PI_WEBUI_ANNOTATIONS_DIR: base } };
  const help = await cli(["--help"], undefined, options);
  assert.equal(help.code, 0);
  assert.equal(help.stderr, "");
  assert.match(help.stdout, /^Usage: source-annotations /);
  for (const [args, error] of [
    [["wat"], /Unknown command/],
    [["list", "--include-resolved=false"], /does not accept a value/],
    [["list", "--wat"], /Unknown option/],
    [["--ref", "HEAD", "list"], /requires a command/],
    [["delete", "--expected-revision", "0"], /positive integer/],
  ]) failure(await cli(args, undefined, options), error);
  await assert.rejects(stat(base), { code: "ENOENT" });
});

test("compiled CLI Node CRUD/export/import honors author binding, option overrides and optimistic checks", async (t) => {
  const { root, base, directory } = await fixture(t);
  const args = ["--cwd", root, "--data-dir", base];
  const options = { home: directory };
  const run = (command, input, extra = []) => cli([...args, command, ...extra], input === undefined ? undefined : JSON.stringify(input), options);
  const created = success(await run("create", { ...createInput, author }, ["--author-kind", "human", "--author-name", "CLI Fixture"]));
  assert.deepEqual(created.author, { ...author, kind: "human", name: "CLI Fixture" });
  assert.equal(created.revision, 1);
  assert.equal(success(await run("list", undefined, ["--path", "source.txt"])).items.length, 1);
  const updated = success(await run("update", { id: randomUUID(), expectedRevision: 999, body: "Updated" }, ["--id", created.id, "--expected-revision", "1"]));
  assert.equal(updated.id, created.id);
  assert.equal(updated.revision, 2);
  failure(await run("update", { id: created.id, expectedRevision: 1, body: "stale" }), /revision conflict/);
  failure(await run("delete", { id: created.id, expectedRevision: 1 }), /revision conflict/);
  failure(await run("delete", { id: created.id, expectedRevision: 2, body: "unknown" }), /Unknown annotation delete field/);
  const exported = await cli([...args, "export"], undefined, options);
  const document = success(exported);
  assert.equal(document.annotations.length, 1);
  assert.equal(document.schemaVersion, 1);
  assert.ok(!exported.stdout.includes(root));
  assert.ok(!exported.stdout.includes(base));
  assert.deepEqual(success(await run("delete", {}, ["--id", created.id, "--expected-revision", "2"])), { deleted: true });
  assert.equal(success(await run("list")).items.length, 0);
  assert.deepEqual(success(await run("import", document)), { imported: 1, skipped: 0 });
  assert.deepEqual(success(await run("import", document)), { imported: 0, skipped: 1 });
  success(await run("update", { id: created.id, expectedRevision: 2, state: "resolved" }));
  assert.equal(success(await run("list")).items.length, 0);
  assert.equal(success(await run("list", undefined, ["--include-resolved"])).items.length, 1);
  const defaultAuthor = success(await run("create", createInput));
  assert.deepEqual(defaultAuthor.author, { kind: "agent", name: "local-agent" });
});

test("compiled CLI environment keeps the existing storage variable and explicit --data-dir takes precedence", async (t) => {
  const { root, base, directory } = await fixture(t);
  const overridden = join(directory, "override");
  const options = { home: directory, env: { PI_WEBUI_ANNOTATIONS_DIR: base } };
  success(await cli(["--cwd", root, "create"], JSON.stringify(createInput), options));
  assert.equal(success(await cli(["--cwd", root, "list"], undefined, options)).items.length, 1);
  assert.equal(success(await cli(["--cwd", root, "--data-dir", overridden, "list"], undefined, options)).items.length, 0);
  await assert.rejects(stat(overridden), { code: "ENOENT" });
});

test("compiled CLI retains the legacy default location under a disposable HOME", async (t) => {
  const { root, directory } = await fixture(t);
  const defaultBase = join(directory, ".local", "share", "pi-webui", "annotations");
  const options = { home: directory };
  const created = success(await cli(["--cwd", root, "create"], JSON.stringify(createInput), options));
  assert.ok((await stat(defaultBase)).isDirectory());
  const listed = success(await cli(["--cwd", root, "--data-dir", defaultBase, "list"], undefined, options));
  assert.equal(listed.items[0].annotation.id, created.id);
});

test("compiled CLI malformed, non-UTF8 and oversized stdin fail without storage effects", async (t) => {
  const { root, base, directory } = await fixture(t);
  const args = ["--cwd", root, "--data-dir", base, "create"];
  const options = { home: directory };
  for (const [input, error] of [
    [undefined, /JSON input is required/],
    ["{", /not valid JSON/],
    ["[]", /must be a JSON object/],
    [Buffer.from([0xff]), /not valid UTF-8/],
    [" ".repeat(1024 * 1024 + 1), /stdin exceeds/],
  ]) failure(await cli(args, input, options), error);
  failure(await cli(["--cwd", root, "--data-dir", base, "import"], " ".repeat(17 * 1024 * 1024 + 1), options), /stdin exceeds/);
  await assert.rejects(stat(base), { code: "ENOENT" });
});

test("compiled CLI accepts service exports larger than the ordinary 1 MiB mutation limit", async (t) => {
  const { root, base, directory } = await fixture(t);
  const options = { home: directory };
  const args = ["--cwd", root, "--data-dir", base];
  success(await cli([...args, "create"], JSON.stringify(createInput), options));
  const exported = success(await cli([...args, "export"], undefined, options));
  exported.annotations = Array.from({ length: 20 }, () => ({
    ...exported.annotations[0], id: randomUUID(), body: "x".repeat(60 * 1024),
  }));
  assert.ok(Buffer.byteLength(JSON.stringify(exported)) > 1024 * 1024);
  assert.deepEqual(success(await cli([...args, "import"], JSON.stringify(exported), options)), { imported: 20, skipped: 0 });
  const large = await cli([...args, "export"], undefined, options);
  assert.ok(Buffer.byteLength(large.stdout) > 1024 * 1024);
  assert.deepEqual(success(await cli([...args, "import"], large.stdout, options)), { imported: 0, skipped: 21 });
});

test("compiled CLI Git reads ignore inherited repository redirection", async (t) => {
  const { root, base, directory } = await fixture(t);
  const options = { home: directory, env: {
    GIT_DIR: join(directory, "nonexistent.git"),
    GIT_WORK_TREE: directory,
    GIT_INDEX_FILE: join(directory, "nonexistent-index"),
  } };
  const created = success(await cli(["--cwd", root, "--data-dir", base, "create"], JSON.stringify(createInput), options));
  const list = success(await cli(["--cwd", root, "--data-dir", base, "list"], undefined, options));
  assert.equal(list.items[0].annotation.id, created.id);
  assert.equal(list.items[0].placement.status, "unchanged");
});
