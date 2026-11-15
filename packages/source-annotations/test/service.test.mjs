import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rmdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { AnnotationService, gitRepositoryKey } from "@jpahd/source-annotations";
import { author, commitFile, createInput, fixture, git } from "./helpers.mjs";

async function storage(root, base) {
  const namespace = createHash("sha256").update(await gitRepositoryKey(root)).digest("hex");
  const directory = join(base, namespace);
  return { namespace, directory, file: join(directory, "annotations.json") };
}

test("compiled service: reads are lazy, CRUD is optimistic, exports preserve provenance without machine paths", async (t) => {
  const { root, base } = await fixture(t);
  const service = new AnnotationService(base);
  assert.match((await service.list(root)).repositoryId, /^namespace-/);
  assert.deepEqual((await service.export(root)).annotations, []);
  await assert.rejects(stat(base), { code: "ENOENT" });
  const created = await service.create(root, createInput, author);
  assert.equal(created.revision, 1);
  assert.equal(created.category, "explanation");
  assert.equal(created.state, "open");
  assert.deepEqual(created.author, author);
  assert.equal(created.target.quote.exact, "anchor 😀");
  assert.match(created.target.commit, /^[a-f0-9]{40,64}$/);
  const { directory, file } = await storage(root, base);
  assert.deepEqual(await readdir(directory), ["annotations.json"]);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const disk = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(Object.keys(disk).sort(), ["annotations", "repositoryId", "schemaVersion"]);
  assert.equal(disk.schemaVersion, 1);
  assert.equal(disk.repositoryId, created.repositoryId);
  const initial = await service.list(root, { path: "source.txt" });
  assert.equal(initial.items.length, 1);
  assert.equal(initial.items[0].placement.status, "unchanged");
  const updated = await service.update(root, { id: created.id.toUpperCase(), expectedRevision: 1, body: "Edited", category: "invariant", state: "resolved" });
  assert.equal(updated.revision, 2);
  assert.deepEqual(updated.target, created.target);
  assert.deepEqual(updated.author, author);
  assert.deepEqual((await service.list(root)).items, []);
  assert.equal((await service.list(root, { includeResolved: true })).items[0].annotation.body, "Edited");
  const second = new AnnotationService(base);
  await assert.rejects(second.update(root, { id: created.id, expectedRevision: 1, body: "stale" }), /revision conflict/);
  await assert.rejects(second.delete(root, created.id, 1), /revision conflict/);
  const exported = await second.export(root);
  assert.equal(exported.schemaVersion, 1);
  assert.deepEqual(exported.annotations[0].author, author);
  assert.ok(!JSON.stringify(exported).includes(root));
  assert.ok(!JSON.stringify(exported).includes(base));
  assert.deepEqual(await second.delete(root, created.id.toUpperCase(), 2), { deleted: true });
  assert.deepEqual((await second.list(root)).items, []);
});

test("compiled service reads existing schema-1 layout without migration and linked worktrees share identity", async (t) => {
  const { root, base, directory: temporary } = await fixture(t);
  const source = new AnnotationService(join(temporary, "source"));
  const created = await source.create(root, createInput, author);
  const { directory, file } = await storage(root, base);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const original = `${JSON.stringify({ schemaVersion: 1, repositoryId: created.repositoryId, annotations: [created] })}\n`;
  await writeFile(file, original, { mode: 0o600 });
  const service = new AnnotationService(base);
  assert.deepEqual((await service.list(root)).items[0].annotation, created);
  assert.equal(await readFile(file, "utf8"), original);
  const linked = join(temporary, "linked");
  git(root, "worktree", "add", "-qb", "linked", linked);
  assert.equal(await gitRepositoryKey(root), await gitRepositoryKey(linked));
  assert.equal((await service.list(linked)).repositoryId, created.repositoryId);
  assert.equal((await service.list(linked)).items[0].annotation.id, created.id);
});

test("compiled import verifies all anchors before storage, canonicalizes IDs, remaps identity and detects collisions", async (t) => {
  const { root, base, directory } = await fixture(t);
  const service = new AnnotationService(base);
  const created = await service.create(root, createInput, author);
  const exported = await service.export(root);
  const invalid = structuredClone(exported);
  invalid.annotations[0].target.quote.exact = "tampered";
  const invalidBase = join(directory, "invalid");
  await assert.rejects(new AnnotationService(invalidBase).import(root, invalid), /anchor verification/);
  await assert.rejects(stat(invalidBase), { code: "ENOENT" });
  const duplicate = structuredClone(exported);
  duplicate.annotations.push({ ...created, id: created.id.toUpperCase() });
  await assert.rejects(new AnnotationService(invalidBase).import(root, duplicate), /duplicate annotation ids/);
  const destination = new AnnotationService(join(directory, "destination"));
  const upper = structuredClone(exported);
  upper.repository.id = upper.repository.id.toUpperCase();
  for (const note of upper.annotations) {
    note.id = note.id.toUpperCase();
    note.repositoryId = note.repositoryId.toUpperCase();
    for (const key of ["commit", "blob", "fingerprint"]) note.target[key] = note.target[key].toUpperCase();
  }
  assert.deepEqual(await destination.import(root, upper), { imported: 1, skipped: 0 });
  assert.deepEqual(await destination.import(root, exported), { imported: 0, skipped: 1 });
  const imported = (await destination.export(root)).annotations[0];
  assert.notEqual(imported.repositoryId, created.repositoryId);
  assert.deepEqual(imported, { ...created, repositoryId: imported.repositoryId });
  const collision = structuredClone(exported);
  collision.annotations[0].body = "different";
  await assert.rejects(destination.import(root, collision), /id collision/);
  assert.equal((await destination.export(root)).annotations[0].body, created.body);
});

test("compiled list follows renames, filters projected paths, and retains immutable original targets", async (t) => {
  const { root, base } = await fixture(t);
  const service = new AnnotationService(base);
  const created = await service.create(root, createInput, author);
  await commitFile(root, "source.txt", "inserted\nbefore\nanchor 😀\nafter\n");
  git(root, "mv", "source.txt", "renamed.txt");
  git(root, "commit", "-qm", "rename");
  const listed = await service.list(root, { path: "renamed.txt" });
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].placement.status, "moved");
  assert.equal(listed.items[0].placement.startLine, 3);
  assert.deepEqual(listed.items[0].annotation.target, created.target);
  assert.deepEqual((await service.list(root, { path: "source.txt" })).items, []);
  git(root, "rm", "-q", "renamed.txt");
  git(root, "commit", "-qm", "delete");
  assert.equal((await service.list(root, { path: "source.txt" })).items[0].placement.status, "unplaced");
});

test("compiled storage safeguards: checkout ancestry, permissions, locks, temporaries, missing data and malformed records", async (t) => {
  const { root, base } = await fixture(t);
  await assert.rejects(new AnnotationService(join(root, "private")).list(root), /outside every .git/);
  const service = new AnnotationService(base);
  const note = await service.create(root, createInput, author);
  const { namespace, directory, file } = await storage(root, base);
  const original = await readFile(file, "utf8");
  await chmod(file, 0o644);
  await assert.rejects(service.export(root), /mode/);
  await chmod(file, 0o600);
  const lock = join(base, `${namespace}.lock`);
  await mkdir(lock, { mode: 0o700 });
  await assert.rejects(service.delete(root, note.id, 1), /busy/);
  await rmdir(lock);
  const temporary = join(directory, `annotations.json.${randomUUID()}.tmp`);
  await writeFile(temporary, "uncommitted", { mode: 0o600 });
  assert.equal((await service.export(root)).annotations.length, 1);
  const unknown = join(directory, "unexpected");
  await writeFile(unknown, "unknown", { mode: 0o600 });
  await assert.rejects(service.export(root), /Unknown annotation storage file/);
  await unlink(unknown);
  const duplicate = JSON.parse(original);
  duplicate.annotations.push({ ...note, id: note.id.toUpperCase() });
  await writeFile(file, JSON.stringify(duplicate));
  await assert.rejects(service.export(root), /Duplicate annotation id/);
  duplicate.annotations = [{ ...note, repositoryId: randomUUID() }];
  await writeFile(file, JSON.stringify(duplicate));
  await assert.rejects(service.export(root), /repository id mismatch/);
  await writeFile(file, "x".repeat(16 * 1024 * 1024 + 1));
  await assert.rejects(service.export(root), /too large/);
  await unlink(file);
  await assert.rejects(service.export(root), /missing/);
  await writeFile(file, original, { mode: 0o600 });
  assert.equal((await service.export(root)).annotations.length, 1);
});

test("compiled storage rejects symlinks and canonical ancestor replacement", async (t) => {
  const { root, directory } = await fixture(t);
  const container = join(directory, "container");
  const service = new AnnotationService(join(container, "store"));
  await service.create(root, createInput, author);
  const { file } = await storage(root, join(container, "store"));
  await unlink(file);
  const outside = join(directory, "outside.json");
  await writeFile(outside, "{}", { mode: 0o600 });
  await symlink(outside, file);
  await assert.rejects(service.export(root));
  await rename(container, `${container}-saved`);
  await symlink(`${container}-saved`, container);
  await assert.rejects(service.export(root), /symlink/);
});

test("compiled service bounds requests and mutations without initializing invalid data", async (t) => {
  const { root, base } = await fixture(t);
  const service = new AnnotationService(base);
  for (const input of [
    { ...createInput, body: " " },
    { ...createInput, body: "x".repeat(64 * 1024 + 1) },
    { ...createInput, unexpected: true },
    { ...createInput, ref: "WORKTREE" },
  ]) await assert.rejects(service.create(root, input, author));
  await assert.rejects(stat(base), { code: "ENOENT" });
  const context = service.context.bind(service);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  service.context = async (cwd) => { await gate; return context(cwd); };
  const operations = Array.from({ length: 8 }, () => service.export(root));
  try { await assert.rejects(service.export(root), /service is busy/); }
  finally { release(); }
  await Promise.all(operations);
  assert.deepEqual((await service.export(root)).annotations, []);
});
