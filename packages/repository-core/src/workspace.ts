import type { Dirent } from "node:fs";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { runGit } from "./git.js";
import { decodeTextPreview } from "./text-preview.js";

export type ChangeBucket = "staged" | "unstaged" | "untracked" | "conflicted";

/** A live working-tree diff capture, without host/session/protocol identity. */
export interface WorkspaceCapturedDiff {
  path: string;
  bucket: ChangeBucket;
  rawDiff: string;
  truncated: boolean;
}

export interface WorkspaceFile {
  path: string;
  fromPath?: string;
  status: string;
  bucket: ChangeBucket;
  additions?: number;
  deletions?: number;
}

export interface WorkspaceStatus {
  isGit: boolean;
  branch: string;
  head?: string;
  files: WorkspaceFile[];
}

export interface WorkspaceTreeEntry {
  name: string;
  type: "file" | "directory" | "symlink";
  size: number;
}

export interface WorkspaceFilePreview {
  path: string;
  content: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  language?: string;
}

const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_DIRECTORY_SCAN_ENTRIES = 5_000;
const MAX_DIRECTORY_RESULTS = 500;
const DIRECTORY_STAT_CONCURRENCY = 8;
const EXCLUDED_DIRECTORIES = new Set([".git", ".pi-webui", "node_modules"]);

export async function getWorkspaceStatus(cwd: string): Promise<WorkspaceStatus> {
  const status = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status.exitCode !== 0) return { isGit: false, branch: "", files: [] };
  const [branchResult, headResult, stagedResult, unstagedResult] = await Promise.all([
    git(cwd, ["branch", "--show-current"]),
    git(cwd, ["rev-parse", "--verify", "HEAD"]),
    git(cwd, ["diff", "--cached", "--no-ext-diff", "--numstat", "-z"]),
    git(cwd, ["diff", "--no-ext-diff", "--numstat", "-z"]),
  ]);
  const branch = branchResult.stdout.trim() || "detached";
  const files = parsePorcelain(status.stdout);
  if (stagedResult.exitCode === 0) {
    applyLineStats(files, "staged", parseNumstat(stagedResult.stdout));
  }
  if (unstagedResult.exitCode === 0) {
    applyLineStats(files, "unstaged", parseNumstat(unstagedResult.stdout));
  }
  return {
    isGit: true,
    branch,
    ...(headResult.exitCode === 0 ? { head: headResult.stdout.trim() } : {}),
    files,
  };
}

export async function captureWorkspaceDiffs(cwd: string, path: string): Promise<WorkspaceCapturedDiff[]> {
  const safePath = workspaceRelativePath(cwd, path, true);
  const status = await getWorkspaceStatus(cwd);
  const matches = status.files.filter((file) => file.path === safePath);
  return await Promise.all(
    matches.map(async (file) => ({
      path: file.path,
      bucket: file.bucket,
      ...(await getWorkspaceDiff(cwd, file.path, file.bucket)),
    })),
  );
}

export async function getWorkspaceDiff(
  cwd: string,
  path: string,
  bucket: ChangeBucket,
): Promise<{ rawDiff: string; truncated: boolean }> {
  const safePath = workspaceRelativePath(cwd, path);
  let args: string[];
  if (bucket === "staged") {
    args = ["diff", "--cached", "--no-ext-diff", "--binary", "--", safePath];
  } else if (bucket === "untracked") {
    args = ["diff", "--no-index", "--no-ext-diff", "--binary", "--", "/dev/null", safePath];
  } else {
    args = ["diff", "--no-ext-diff", "--binary", "--", safePath];
  }
  const result = await git(cwd, args, MAX_DIFF_BYTES + 1);
  // `git diff --no-index` uses 1 to mean "different", which is the
  // successful result for an untracked file.
  if (result.exitCode !== 0 && !(bucket === "untracked" && result.exitCode === 1)) {
    throw new Error(result.stderr.trim() || "Could not read git diff");
  }
  const bytes = new TextEncoder().encode(result.stdout);
  const truncated = result.stdoutTruncated || bytes.byteLength > MAX_DIFF_BYTES;
  return {
    rawDiff: truncated
      ? new TextDecoder().decode(bytes.slice(0, MAX_DIFF_BYTES))
      : result.stdout,
    truncated,
  };
}

export async function listWorkspaceDirectory(
  cwd: string,
  path: string,
): Promise<WorkspaceTreeEntry[]> {
  const directory = await confinedExistingPath(cwd, path);
  const directoryStat = await stat(directory);
  if (!directoryStat.isDirectory()) throw new Error("Workspace path is not a directory");
  const visible: Dirent[] = [];
  let scanned = 0;
  // The iterator closes its handle on exhaustion or refusal. Count filtered
  // entries too, and observe one extra entry only to detect overflow.
  for await (const entry of await opendir(directory, { bufferSize: 32 })) {
    if (++scanned > MAX_DIRECTORY_SCAN_ENTRIES) {
      throw new Error(`Workspace directory scan limit exceeded (${MAX_DIRECTORY_SCAN_ENTRIES} entries)`);
    }
    if (!(entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name))) visible.push(entry);
  }
  const selected = visible.sort(
    (left, right) =>
      Number(right.isDirectory()) - Number(left.isDirectory()) ||
      left.name.localeCompare(right.name) ||
      (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
  ).slice(0, MAX_DIRECTORY_RESULTS);

  const results: WorkspaceTreeEntry[] = [];
  // Only stat the sorted result window, in bounded batches. Settle the whole
  // batch before propagating an error so no metadata work outlives this call.
  for (let offset = 0; offset < selected.length; offset += DIRECTORY_STAT_CONCURRENCY) {
    const batch = await Promise.allSettled(
      selected.slice(offset, offset + DIRECTORY_STAT_CONCURRENCY).map(async (entry): Promise<WorkspaceTreeEntry> => {
        const entryStat = await lstat(resolve(directory, entry.name));
        return {
          name: entry.name,
          type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
          size: entryStat.size,
        };
      }),
    );
    for (const result of batch) {
      if (result.status === "rejected") throw result.reason;
      results.push(result.value);
    }
  }
  return results;
}

export async function getWorkspaceFilePreview(
  cwd: string,
  path: string,
): Promise<WorkspaceFilePreview> {
  const filePath = await confinedExistingPath(cwd, path, true);
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) throw new Error("Workspace path is not a file");
  const bytesToRead = Math.min(fileStat.size, MAX_PREVIEW_BYTES + 1);
  const handle = await open(filePath, "r");
  let bytes: Uint8Array;
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
    bytes = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const truncated = fileStat.size > MAX_PREVIEW_BYTES;
  const previewBytes = truncated ? bytes.subarray(0, MAX_PREVIEW_BYTES) : bytes;
  const content = decodeTextPreview(previewBytes, truncated);
  const binary = content === undefined;
  return {
    path: workspaceRelativePath(cwd, path, true),
    content: content ?? "",
    size: fileStat.size,
    binary,
    truncated,
    language: languageFromPath(path),
  };
}

export function parseNumstat(raw: string): Map<string, { additions: number; deletions: number }> {
  const entries = raw.split("\0");
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry) continue;
    const firstTab = entry.indexOf("\t");
    const secondTab = entry.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const added = Number(entry.slice(0, firstTab));
    const deleted = Number(entry.slice(firstTab + 1, secondTab));
    if (!Number.isFinite(added) || !Number.isFinite(deleted)) continue;
    let path = entry.slice(secondTab + 1);
    if (!path) {
      index += 2;
      path = entries[index] ?? "";
    }
    if (path) stats.set(path, { additions: added, deletions: deleted });
  }
  return stats;
}

export function parsePorcelain(raw: string): WorkspaceFile[] {
  const entries = raw.split("\0");
  const files: WorkspaceFile[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry || entry.length < 4) continue;
    const x = entry[0] ?? " ";
    const y = entry[1] ?? " ";
    const path = entry.slice(3);
    let fromPath: string | undefined;
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      fromPath = entries[++index] || undefined;
    }

    if (x === "?" && y === "?") {
      files.push({ path, status: "?", bucket: "untracked" });
      continue;
    }
    if (isConflict(x, y)) {
      files.push({ path, fromPath, status: "U", bucket: "conflicted" });
      continue;
    }
    if (x !== " ") files.push({ path, fromPath, status: x, bucket: "staged" });
    if (y !== " ") files.push({ path, fromPath, status: y, bucket: "unstaged" });
  }
  return files;
}

function applyLineStats(
  files: WorkspaceFile[],
  bucket: ChangeBucket,
  stats: ReadonlyMap<string, { additions: number; deletions: number }>,
): void {
  for (const file of files) {
    if (file.bucket !== bucket) continue;
    const lineStats = stats.get(file.path);
    if (!lineStats) continue;
    file.additions = lineStats.additions;
    file.deletions = lineStats.deletions;
  }
}

function isConflict(x: string, y: string): boolean {
  return new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]).has(`${x}${y}`);
}

async function confinedExistingPath(
  cwd: string,
  path: string,
  allowAbsolute = false,
): Promise<string> {
  const safePath = workspaceRelativePath(cwd, path || ".", allowAbsolute);
  const [root, candidate] = await Promise.all([realpath(cwd), realpath(resolve(cwd, safePath))]);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error("Path is outside the workspace");
  }
  return candidate;
}

function workspaceRelativePath(cwd: string, path: string, allowAbsolute = false): string {
  if (!path || path.includes("\0") || (isAbsolute(path) && !allowAbsolute)) {
    throw new Error("Invalid workspace path");
  }
  const absolute = resolve(cwd, path);
  const root = resolve(cwd);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    throw new Error("Path is outside the workspace");
  }
  return relative(root, absolute);
}

function languageFromPath(path: string): string | undefined {
  const extension = extname(path).slice(1).toLowerCase();
  return extension || undefined;
}

async function git(
  cwd: string,
  args: string[],
  maxStdoutBytes?: number,
): Promise<{ stdout: string; stderr: string; exitCode: number; stdoutTruncated: boolean }> {
  // `--` ends options, not pathspec magic. A workspace filename must never
  // select sibling files through globs or :(...) pathspec expressions.
  const command = args[0] === "diff" ? ["diff", "--no-textconv", ...args.slice(1)] : args;
  const result = await runGit(cwd, ["--literal-pathspecs", ...command], maxStdoutBytes);
  if (result.timedOut) throw new Error("Git command timed out");
  if (maxStdoutBytes === undefined && result.stdoutTruncated) throw new Error("Git metadata output limit exceeded");
  return result;
}
