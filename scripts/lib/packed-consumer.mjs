import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, readdir, lstat, realpath, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, relative, sep, isAbsolute } from "node:path";
import { gunzipSync } from "node:zlib";

function execute(executable, args, cwd, env) {
  const result = spawnSync(executable, args, { cwd, env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${executable} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}
function inside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}
async function noLinks(directory) {
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const info = await lstat(path);
    assert(!info.isSymbolicLink(), `Symlink in package dist: ${path}`);
    if (info.isDirectory()) await noLinks(path);
    else assert(info.isFile(), `Non-regular package artifact: ${path}`);
  }
}
// Validate every archive-controlled path and file type before writing any bytes.
function archiveMembers(gzip) {
  assert(gzip.length < 64 * 1024 * 1024, "Oversized package archive");
  const tar = gunzipSync(gzip, { maxOutputLength: 64 * 1024 * 1024 });
  const members = [], seen = new Set();
  const string = (header, start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
  const octal = (header, start, length) => {
    const field = string(header, start, length).trim();
    assert(/^[0-7]+$/.test(field), "Invalid tar number");
    const number = Number.parseInt(field, 8);
    assert(Number.isSafeInteger(number), "Unsafe tar number");
    return number;
  };
  let offset = 0, ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      assert(tar.length >= offset + 1024 && tar.subarray(offset).every((byte) => byte === 0), "Invalid tar ending");
      ended = true; break;
    }
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    assert.equal(checksum, octal(header, 148, 8), "Invalid tar checksum");
    const prefix = string(header, 345, 155);
    const raw = `${prefix ? `${prefix}/` : ""}${string(header, 0, 100)}`;
    const type = header[156];
    assert(type === 0 || type === 48 || type === 53, "Links/tar extensions are not package artifacts");
    const directory = type === 53;
    const name = directory ? raw.replace(/\/$/, "") : raw;
    assert(!/[\\:\x00-\x1f\x7f]/.test(name) && !name.startsWith("/") && name.split("/").every((part) => part && part !== "." && part !== ".."), "Unsafe packed path");
    assert(name === "package" && directory || name.startsWith("package/"), "Archive escapes package");
    assert(!seen.has(name), "Duplicate packed path"); seen.add(name);
    const path = name === "package" ? "" : name.slice(8);
    assert(!path || path === "dist" && directory || path.startsWith("dist/") || path === "docs" && directory || path.startsWith("docs/") || !directory && /^(?:package.json|README(?:\.md)?|LICENSE(?:\.md)?)$/.test(path), `Unexpected packed file: ${path}`);
    assert(!/(?:^|\/)(?:src|test|tests|node_modules)(?:\/|$)|\.(?:test|spec)\./i.test(path), "Source/test/dependency leaked into tarball");
    const size = octal(header, 124, 12);
    assert(!directory || size === 0, "Directory has data");
    offset += 512;
    assert(offset + size <= tar.length, "Truncated packed file");
    members.push({ path, directory, bytes: tar.subarray(offset, offset + size) });
    offset += Math.ceil(size / 512) * 512;
  }
  assert(ended, "Missing tar end markers");
  const files = new Set(members.filter((entry) => !entry.directory).map((entry) => entry.path));
  for (const entry of members) {
    const parts = entry.path.split("/");
    for (let index = 1; index < parts.length; index++) assert(!files.has(parts.slice(0, index).join("/")), "File/directory collision");
  }
  return members;
}

/** Use real npm tarball bytes; only external dependencies use installed fixtures. */
export async function createPackedConsumer(packagePaths, fixtureRoot, { fixtures = [] } = {}) {
  const owned = await realpath(await mkdtemp(join(tmpdir(), "repository-packages-")));
  const env = Object.fromEntries(["PATH", "SystemRoot", "TMPDIR", "TEMP", "TMP"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  Object.assign(env, { HOME: join(owned, "home"), NPM_CONFIG_USERCONFIG: join(owned, "npmrc"), NPM_CONFIG_CACHE: join(owned, "cache"), NPM_CONFIG_IGNORE_SCRIPTS: "true" });
  try {
    await mkdir(env.HOME); await writeFile(env.NPM_CONFIG_USERCONFIG, "");
    const directory = join(owned, "consumer"), archives = join(owned, "archives");
    await mkdir(directory); await mkdir(archives);
    await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
    const manifests = [];
    for (const source of packagePaths) {
      await noLinks(join(source, "dist"));
      const results = JSON.parse(execute("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", archives], source, env));
      assert.equal(results.length, 1);
      const archive = join(archives, results[0].filename);
      assert(inside(archives, archive), "Archive filename escapes owned directory");
      const members = archiveMembers(await readFile(archive));
      const metadata = members.find((entry) => entry.path === "package.json");
      assert(metadata, "Missing packed manifest");
      const manifest = JSON.parse(metadata.bytes.toString("utf8"));
      assert.equal(manifest.type, "module");
      assert.equal(manifest.license, "MIT");
      assert(members.some((entry) => entry.path === "LICENSE"), "Missing MIT notice");
      for (const deps of [manifest.dependencies, manifest.peerDependencies, manifest.optionalDependencies]) {
        for (const version of Object.values(deps ?? {})) assert(!/^(?:workspace:|file:|link:)/.test(version), `Nonportable dependency in ${manifest.name}: ${version}`);
      }
      const target = join(directory, "node_modules", manifest.name);
      assert(inside(join(directory, "node_modules"), target), "Unsafe package name");
      for (const entry of members) {
        if (!entry.path) continue;
        const path = join(target, entry.path);
        assert(inside(target, path));
        if (entry.directory) await mkdir(path, { recursive: true });
        else { await mkdir(dirname(path), { recursive: true }); await writeFile(path, entry.bytes); }
      }
      function targets(value) { return typeof value === "string" ? [value] : Object.values(value).flatMap(targets); }
      for (const file of targets(manifest.exports)) assert((await lstat(join(target, file))).isFile(), `Missing export ${file}`);
      manifests.push(manifest);
      console.log(`${manifest.name}: extracted MIT npm tarball`);
    }
    const internal = new Set(manifests.map((manifest) => manifest.name));
    const peers = new Set(manifests.flatMap((manifest) => Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })));
    peers.add("@types/node");
    for (const name of fixtures) peers.add(name);
    for (const name of peers) {
      if (internal.has(name)) continue;
      const target = join(directory, "node_modules", name);
      await mkdir(dirname(target), { recursive: true });
      await symlink(await realpath(join(fixtureRoot, "node_modules", name)), target, "dir");
    }
    return { directory, manifests, owned, env,
      run: (executable, args) => execute(executable, args, directory, env),
      dispose: () => rm(owned, { recursive: true, force: true }) };
  } catch (error) {
    await rm(owned, { recursive: true, force: true });
    throw error;
  }
}
