import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));

/** Discover package manifests and put workspace dependencies before consumers. */
export function loadWorkspace() {
  const packages = readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, "packages", entry.name, "package.json")))
    .map((entry) => {
      const directory = join(root, "packages", entry.name);
      return { directory, short: entry.name, manifest: JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) };
    });
  const byName = new Map(packages.map((entry) => [entry.manifest.name, entry]));
  assert.equal(byName.size, packages.length, "Duplicate workspace package name");
  const ordered = [], visited = new Set(), visiting = new Set();
  function visit(entry) {
    const name = entry.manifest.name;
    if (visited.has(name)) return;
    assert(!visiting.has(name), `Workspace dependency cycle at ${name}`);
    visiting.add(name);
    const dependencies = { ...entry.manifest.dependencies, ...entry.manifest.peerDependencies };
    for (const dependency of Object.keys(dependencies).sort()) {
      if (byName.has(dependency)) visit(byName.get(dependency));
    }
    visiting.delete(name); visited.add(name); ordered.push(entry);
  }
  for (const entry of packages.sort((a, b) => a.short.localeCompare(b.short))) visit(entry);
  return ordered;
}
