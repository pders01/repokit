import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

export function environment(home) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: tmpdir(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

export function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd, env: environment(cwd), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "source-annotations-test-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "repo");
  const base = join(directory, "store");
  await mkdir(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Annotation Fixture");
  git(root, "config", "user.email", "annotations@example.invalid");
  await commitFile(root, "source.txt", "before\nanchor 😀\nafter\n");
  return { directory, root, base };
}

export async function commitFile(root, path, text) {
  await writeFile(join(root, path), text);
  git(root, "add", "--", path);
  git(root, "commit", "-qm", "synthetic fixture");
}

export async function cli(args, input, { home, env = {}, entry = bin } = {}) {
  const child = spawn(process.execPath, [entry, ...args], {
    env: { ...environment(home), ...env }, stdio: ["pipe", "pipe", "pipe"],
  });
  const out = [];
  const err = [];
  child.stdout.on("data", (bytes) => out.push(bytes));
  child.stderr.on("data", (bytes) => err.push(bytes));
  // A rejected argument can close stdin before a deliberately large input ends.
  child.stdin.on("error", (error) => { if (error.code !== "EPIPE") throw error; });
  const result = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) return reject(new Error(`CLI terminated by ${signal}`));
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
  });
  child.stdin.end(input);
  return result;
}

export const createInput = {
  ref: "HEAD", path: "source.txt", startLine: 2, endLine: 2, body: "Synthetic explanation",
};
export const author = { kind: "agent", name: "synthetic-worker", sessionId: "fixture-session", model: "fixture-model" };
