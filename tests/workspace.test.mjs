import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { loadWorkspace, root } from "../scripts/workspace.mjs";

const packages = loadWorkspace();
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory()
    ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
}

test("workspace contains only maintained headless packages with portable MIT metadata", async () => {
  assert.deepEqual(packages.map((entry) => entry.short).sort(), [
    "commits-adapters", "commits-core", "context-records", "git-chat-protocol", "repository-core", "source-annotations",
  ]);
  const seen = new Set();
  for (const entry of packages) {
    const { manifest } = entry;
    assert.equal(manifest.private, true);
    assert.equal(manifest.license, "MIT");
    assert.match(await readFile(join(entry.directory, "LICENSE"), "utf8"), /MIT License/);
    assert.equal(manifest.type, "module");
    for (const required of ["build", "check", "test"]) {
      assert(manifest.scripts[required], `${manifest.name} lacks ${required}`);
      assert.doesNotMatch(manifest.scripts[required], /\bbun\b/i, `${manifest.name} requires Bun tooling`);
    }
    for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.peerDependencies })) {
      assert(!/chatworks|commits-reader|source-annotations-ui|^lit(?:-|$)|^@lit\//.test(name), `UI dependency in ${manifest.name}: ${name}`);
      assert(!/^(?:workspace:|file:|link:)/.test(version), `Nonportable dependency in ${manifest.name}`);
      if (packages.some((candidate) => candidate.manifest.name === name)) assert(seen.has(name), `Dependency not built first: ${name}`);
    }
    seen.add(manifest.name);
  }
});

test("compiled headless import graph does not reach retired applications or browser UI", async () => {
  for (const entry of packages) {
    for (const path of await files(join(entry.directory, "dist"))) {
      if (!/\.(?:js|ts)$/.test(path)) continue;
      const content = await readFile(path, "utf8");
      for (const match of content.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g)) {
        assert.doesNotMatch(match[1], /chatworks|commits-reader|source-annotations-ui|(?:^|\/)server\/|(?:^|\/)shared\/|^lit(?:\/|$)|^@lit\//, `${path}: ${match[1]}`);
      }
      assert.doesNotMatch(content, /\bBun\.|import\.meta\.(?:main|dir)/, path);
    }
  }
});

test("root commands do not launch or install a retired application", async () => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(manifest.license, "MIT");
  assert.deepEqual(manifest.workspaces, ["packages/*"]);
  assert(!manifest.bin);
  assert(!manifest.dependencies);
  assert(!manifest.scripts.postinstall);
  for (const script of Object.values(manifest.scripts)) assert.doesNotMatch(script, /\bbun\b|\bvite\b|server\/|pui|apps\//);
});
