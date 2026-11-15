import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { AnnotationService } from "@jpahd/source-annotations";
import { commitFile, fixture } from "./helpers.mjs";

// Preserve the publication races from server/annotations/service.test.ts.
const input = { ref: "HEAD", path: "src.ts", startLine: 1, endLine: 1 };
const author = { kind: "human", name: "A" };

test("readers retry an active first-save initialization without accepting a partial store", async (t) => {
  const { root, base } = await fixture(t);
  await commitFile(root, "src.ts", "const value = 1;\nreturn value;\n");
  const service = new AnnotationService(base);
  let saveStarted;
  const started = new Promise((resolve) => { saveStarted = resolve; });
  let continueSave;
  const gate = new Promise((resolve) => { continueSave = resolve; });
  let paused = false;
  // As in the original regression, interpose only to hold the first empty
  // namespace publication. The real compiled save still performs every write.
  const originalSave = service.save.bind(service);
  service.save = async (context, document) => {
    if (!paused) {
      paused = true;
      saveStarted();
      await gate;
    }
    return originalSave(context, document);
  };

  const writing = service.create(root, { ...input, body: "first" }, author);
  let reading;
  try {
    // Surface a failed create instead of waiting indefinitely for its save.
    await Promise.race([started, writing.then(() => assert.fail("first save was not paused"))]);
    reading = new AnnotationService(base).export(root);
    // Observe early rejection without letting it become an unhandled rejection;
    // Promise.all below still requires the original reader promise to succeed.
    reading.catch(() => {});
    await delay(25);
  } finally {
    continueSave();
  }
  const [created, snapshot] = await Promise.all([writing, reading]);
  // An atomically published empty namespace is a valid pre-create snapshot;
  // the racing reader need not see the subsequent record write yet.
  assert.equal(snapshot.repository.id, created.repositoryId);
  assert.ok(snapshot.annotations.length <= 1);
  if (snapshot.annotations.length) assert.deepEqual(snapshot.annotations[0], created);
  assert.deepEqual((await new AnnotationService(base).export(root)).annotations, [created]);
});

test("keeps concurrent readers on complete snapshots", async (t) => {
  const { root, base } = await fixture(t);
  await commitFile(root, "src.ts", "const value = 1;\nreturn value;\n");
  const service = new AnnotationService(base);
  const annotation = await service.create(root, { ...input, body: "before" }, author);
  const reads = Promise.all(Array.from({ length: 8 }, () => service.list(root, { ref: "HEAD" })));
  const updated = service.update(root, { id: annotation.id, expectedRevision: 1, body: "after" });
  const [snapshots, result] = await Promise.all([reads, updated]);
  assert.equal(result.revision, 2);
  assert.equal(result.body, "after");
  for (const snapshot of snapshots) {
    assert.equal(snapshot.items.length, 1);
    assert.equal(snapshot.repositoryId, annotation.repositoryId);
    const observed = snapshot.items[0].annotation;
    // Neither a missing record nor a mixed revision/body is a complete snapshot.
    assert.deepEqual(observed, observed.revision === 1 ? annotation : result);
  }
  assert.deepEqual((await new AnnotationService(base).export(root)).annotations, [result]);
});
