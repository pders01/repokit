import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = resolve(root, "dist");

test("compiled public entries/types/bin exist and emitted imports stay inside the package or declared dependency", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, "module");
  assert.deepEqual(Object.keys(manifest.exports).sort(), [".", "./cli", "./contracts"]);
  assert.deepEqual(manifest.dependencies, { "@jpahd/repository-core": "0.0.0" });
  for (const entry of Object.values(manifest.exports)) {
    assert.ok((await readFile(resolve(root, entry.import), "utf8")).length > 0);
    assert.ok((await readFile(resolve(root, entry.types), "utf8")).length > 0);
  }
  const bin = await readFile(resolve(root, manifest.bin["source-annotations"]), "utf8");
  assert.match(bin, /^#!\/usr\/bin\/env node\n/);
  const dependencyImports = [];
  for (const name of await readdir(dist)) {
    if (!name.endsWith(".js") && !name.endsWith(".d.ts")) continue;
    const path = resolve(dist, name);
    const text = await readFile(path, "utf8");
    assert.doesNotMatch(text, /\bBun\b|import\.meta\.(?:main|dir)/);
    for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier.startsWith(".")) {
        const target = resolve(dirname(path), specifier);
        assert.ok(!relative(dist, target).startsWith(".."), `${name} escapes dist: ${specifier}`);
        await readFile(target);
      } else if (!specifier.startsWith("node:")) {
        assert.equal(specifier, "@jpahd/repository-core/git");
        dependencyImports.push(name);
      }
    }
  }
  assert.ok(dependencyImports.includes("service.js"));
  assert.ok(dependencyImports.includes("git-target.js"));
});

test("compiled neutral contract entry is runtime-empty and exposes no host RPC routing", async () => {
  const js = await readFile(resolve(dist, "contracts.js"), "utf8");
  assert.match(js, /^export \{\};\s*$/);
  const types = await readFile(resolve(dist, "contracts.d.ts"), "utf8");
  assert.doesNotMatch(types, /\bimport\b|\bAnnotationRpcMethods\b|\bprocess\b|\bHTMLElement\b/);
  assert.match(types, /interface AnnotationClient/);
  // sessionId is preserved only as author provenance, not a request scope.
  assert.equal((types.match(/sessionId\?/g) ?? []).length, 1);
});
