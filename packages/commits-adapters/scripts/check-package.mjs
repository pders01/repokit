import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

// Package-local: no root scripts, aliases, registry installs or lifecycle hooks.
// This creates a real tarball and verifies npm's file list/module closure, not an isolated install.
const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const scratch = await mkdtemp(join(root, ".pack-check-"));
try {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const output = execFileSync(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch, "--cache", join(scratch, "cache")], {
    cwd: root, encoding: "utf8", env: { ...process.env, npm_config_update_notifier: "false" },
  });
  const [packed] = JSON.parse(output);
  assert.equal(packed.name, manifest.name);
  assert.ok(packed.filename && !/[\\/]/.test(packed.filename), "Expected a local tarball filename");
  const archive = await readFile(join(scratch, packed.filename));
  assert.equal(packed.integrity, `sha512-${createHash("sha512").update(archive).digest("base64")}`);
  assert.equal(manifest.private, true);
  assert.equal(manifest.license, "MIT");
  assert.ok(!manifest.peerDependencies["@jpahd/chatworks"], "Adapters must not depend on UI");
  assert.ok(!manifest.peerDependencies["@jpahd/commits-reader"], "Adapters depend on commits-core instead");
  assert.equal(manifest.type, "module");
  assert.equal(manifest.engines.node, ">=22");
  const files = new Set(packed.files.map((file) => file.path));
  for (const file of files)
    assert.ok(file === "package.json" || file === "README.md" || file === "LICENSE" || /^dist\/[\w-]+\.(?:js|d\.ts)$/.test(file), `Unexpected packed file: ${file}`);
  const required = new Set(["package.json", "README.md", "LICENSE"]);
  for (const [entry, conditions] of Object.entries(manifest.exports)) {
    for (const condition of ["types", "import"]) {
      assert.ok(conditions[condition]?.startsWith("./dist/"), `Non-compiled ${entry}:${condition}`);
      required.add(conditions[condition].slice(2));
    }
  }
  for (const file of required) assert.ok(files.has(file), `Missing packed entry: ${file}`);
  const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]);
  for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.peerDependencies }))
    assert.ok(!/^(?:workspace:|file:|link:)/.test(version), `Checkout-specific dependency: ${name}`);
  let modules = 0;
  for (const file of files) {
    if (!file.startsWith("dist/")) continue;
    const source = await readFile(join(root, file), "utf8");
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier.startsWith(".")) {
        assert.ok(specifier.endsWith(".js"), `Extensionless import: ${file}: ${specifier}`);
        const target = posix.normalize(posix.join(dirname(file), specifier));
        assert.ok(target.startsWith("dist/"), `Escaping import: ${file}: ${specifier}`);
        assert.ok(files.has(target), `Unpacked import: ${file}: ${specifier}`);
        if (file.endsWith(".d.ts")) assert.ok(files.has(target.replace(/\.js$/, ".d.ts")), `Missing declaration: ${target}`);
      } else {
        const packageName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
        assert.ok(declared.has(packageName), `Undeclared import: ${file}: ${specifier}`);
      }
    }
    assert.ok(!/\b(?:Bun\.|bun:|workspace:)/.test(source), `Non-Node runtime reference: ${file}`);
    if (file.endsWith(".js")) { execFileSync(process.execPath, ["--check", join(root, file)], { stdio: "pipe" }); modules++; }
  }
  console.log(`${manifest.name}: npm pack tarball/integrity verified; ${files.size} files, ${modules} Node-parseable ESM modules, all public JS/types and declared import closure.`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
