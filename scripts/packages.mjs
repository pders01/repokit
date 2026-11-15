#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { loadWorkspace, root } from "./workspace.mjs";

const command = process.argv[2] ?? "build";
if (!["build", "check", "test", "verify"].includes(command)) {
  console.error("Usage: node scripts/packages.mjs build|check|test|verify");
  process.exit(2);
}
const packages = loadWorkspace();
function run(executable, args, cwd = root) {
  const result = spawnSync(executable, args, { cwd, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
function script(entry, name) {
  if (!entry.manifest.scripts?.[name]) throw new Error(`${entry.manifest.name} has no ${name} script`);
  console.log(`\n${entry.manifest.name}: ${name}`);
  run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", name], entry.directory);
}

// Dependencies always emit first; no source aliases or runtime TypeScript loader.
for (const entry of packages) script(entry, "build");
if (command === "check" || command === "verify") {
  for (const entry of packages) {
    script(entry, "check");
    if (entry.manifest.scripts?.["check:contracts"]) script(entry, "check:contracts");
  }
}
if (command === "test" || command === "verify") {
  for (const entry of packages) script(entry, "test");
  run(process.execPath, ["--test", "tests/workspace.test.mjs"]);
}
if (command === "verify") run(process.execPath, ["scripts/test-extracted-packages.mjs"]);
