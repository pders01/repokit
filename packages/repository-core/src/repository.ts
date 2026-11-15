import { extname } from "node:path";
import type {
  KnowledgeDocument,
  RepositoryBlameLine,
  RepositoryChangedFile,
  RepositoryCommit,
  RepositoryComparison,
  RepositoryFile,
  RepositoryInfo,
  RepositoryRef,
  RepositoryTreeEntry,
  RepositoryDiff,
  RepositoryMarkdownDocument,
} from "./contracts.js";
import { runGit } from "./git.js";
import { resolveCommit } from "./commit.js";
import { parseRepositoryLog, REPOSITORY_LOG_FORMAT } from "./repository-log.js";
import { decodeTextPreview } from "./text-preview.js";

const MAX_FILE_BYTES = 512 * 1024;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_TREE_ENTRIES = 2_000;
const MAX_COMPARE_FILES = 2_000;

export async function getRepositoryInfo(cwd: string): Promise<RepositoryInfo> {
  const [head, branch, remoteDefault] = await Promise.all([
    gitRequired(cwd, ["rev-parse", "--verify", "HEAD"]),
    gitRequired(cwd, ["branch", "--show-current"]),
    git(cwd, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]),
  ]);
  const branchName = branch.stdout.trim() || "detached";
  const defaultBranch =
    remoteDefault.exitCode === 0
      ? remoteDefault.stdout.trim().replace(/^origin\//, "")
      : branchName;
  const sha = head.stdout.trim();
  return {
    root: cwd,
    branch: branchName,
    defaultBranch,
    head: sha,
    shortHead: sha.slice(0, 8),
  };
}

export async function listRepositoryRefs(
  cwd: string,
): Promise<RepositoryRef[]> {
  const result = await gitRequired(cwd, [
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname)%00%(objectname)%00%(committerdate:unix)%00%(subject)",
    "refs/heads",
    "refs/tags",
  ]);
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .flatMap((line): RepositoryRef[] => {
      const [fullName = "", commit = "", timestamp = "0", subject = ""] =
        line.split("\0");
      const kind = fullName.startsWith("refs/heads/") ? "branch" : "tag";
      const prefix = kind === "branch" ? "refs/heads/" : "refs/tags/";
      const name = fullName.slice(prefix.length);
      return name && commit
        ? [{ name, kind, commit, committedAt: Number(timestamp) || 0, subject }]
        : [];
    });
}

export async function listRepositoryTree(
  cwd: string,
  ref = "HEAD",
  path = "",
): Promise<RepositoryTreeEntry[]> {
  const safeRef = await resolveCommit(cwd, ref);
  const safePath = repositoryPath(path, true);
  const target = safePath ? `${safeRef}:${safePath}` : safeRef;
  const result = await gitRequired(cwd, ["ls-tree", "-z", "-l", target]);
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .slice(0, MAX_TREE_ENTRIES)
    .flatMap((entry): RepositoryTreeEntry[] => {
      const tab = entry.indexOf("\t");
      if (tab < 0) return [];
      const [mode = "", objectType = "", objectId = "", rawSize = "-"] = entry
        .slice(0, tab)
        .split(/\s+/);
      const name = entry.slice(tab + 1);
      const type = treeEntryType(mode, objectType);
      return [
        {
          name,
          path: safePath ? `${safePath}/${name}` : name,
          type,
          size: Number(rawSize) || 0,
          objectId,
        },
      ];
    })
    .sort(
      (left, right) =>
        Number(right.type === "directory") -
          Number(left.type === "directory") ||
        left.name.localeCompare(right.name),
    );
}

export async function getRepositoryFile(
  cwd: string,
  path: string,
  ref = "HEAD",
): Promise<RepositoryFile> {
  const safePath = repositoryPath(path);
  const safeRef = await resolveCommit(cwd, ref);
  const object = `${safeRef}:${safePath}`;
  const [sizeResult, objectResult, contentResult] = await Promise.all([
    gitRequired(cwd, ["cat-file", "-s", object]),
    gitRequired(cwd, ["rev-parse", object]),
    gitRequired(cwd, ["cat-file", "blob", object], MAX_FILE_BYTES + 1),
  ]);
  const size = Number(sizeResult.stdout.trim()) || 0;
  const bytes = contentResult.bytes;
  const truncated = size > MAX_FILE_BYTES || bytes.byteLength > MAX_FILE_BYTES;
  const visible = truncated ? bytes.subarray(0, MAX_FILE_BYTES) : bytes;
  const content = decodeTextPreview(visible, truncated);
  const binary = content === undefined;
  return {
    path: safePath,
    ref: safeRef,
    content: content ?? "",
    size,
    binary,
    truncated,
    objectId: objectResult.stdout.trim(),
    language: extname(safePath).slice(1).toLowerCase() || undefined,
  };
}

export async function listRepositoryCommits(
  cwd: string,
  options: { ref?: string; path?: string; limit?: number; offset?: number },
): Promise<{ commits: RepositoryCommit[]; hasMore: boolean }> {
  await assertFullHistory(cwd);
  const ref = await resolveCommit(cwd, options.ref || "HEAD");
  const path = repositoryPath(options.path || "", true);
  const limit = boundedInteger(options.limit, 50, 1, 200);
  const offset = boundedInteger(options.offset, 0, 0, 100_000);
  const args = [
    "log",
    ref,
    `--max-count=${limit + 1}`,
    `--skip=${offset}`,
    "--date-order",
    "--no-color",
    "--no-show-signature",
    "--no-notes",
    "--encoding=UTF-8",
    `--format=${REPOSITORY_LOG_FORMAT}`,
    "--shortstat",
  ];
  if (path) args.push("--", `:(literal)${path}`);
  const result = await gitRequired(cwd, args);
  const commits = parseRepositoryLog(result.bytes);
  return { commits: commits.slice(0, limit), hasMore: commits.length > limit };
}

export async function getRepositoryDiff(
  cwd: string,
  options: { fromRef?: string; toRef?: string; path?: string },
): Promise<RepositoryDiff> {
  await assertFullHistory(cwd);
  const toRef = await resolveCommit(cwd, options.toRef || "HEAD");
  let fromRef: string;
  if (options.fromRef) {
    fromRef = await resolveCommit(cwd, options.fromRef);
  } else {
    const parent = await git(cwd, ["rev-parse", "--verify", `${toRef}^`]);
    fromRef =
      parent.exitCode === 0
        ? parent.stdout.trim()
        : (
            await gitRequired(cwd, ["hash-object", "-t", "tree", "/dev/null"])
          ).stdout.trim();
  }
  const args = ["diff", "--no-ext-diff", "--no-textconv", "--binary", fromRef, toRef];
  const path = repositoryPath(options.path || "", true);
  if (path) args.push("--", `:(literal)${path}`);
  const result = await gitRequired(cwd, args, MAX_DIFF_BYTES + 1);
  const truncated = result.bytes.byteLength > MAX_DIFF_BYTES;
  const bytes = truncated
    ? result.bytes.subarray(0, MAX_DIFF_BYTES)
    : result.bytes;
  const rawDiff = decodeTextPreview(bytes, truncated);
  if (rawDiff === undefined) throw new Error("Git diff could not be decoded as UTF-8 without loss");
  return { rawDiff, truncated };
}

export async function compareRepositoryRefs(
  cwd: string,
  baseRef: string,
  headRef: string,
): Promise<RepositoryComparison> {
  const [base, head] = await Promise.all([
    resolveCommit(cwd, baseRef),
    resolveCommit(cwd, headRef),
  ]);
  const [statusResult, statsResult] = await Promise.all([
    gitRequired(cwd, [
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
      base,
      head,
    ]),
    gitRequired(cwd, ["diff", "--numstat", "-z", "--find-renames", base, head]),
  ]);
  const files = parseChangedFiles(statusResult.stdout).slice(
    0,
    MAX_COMPARE_FILES,
  );
  const stats = parseNumstat(statsResult.stdout);
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    const value =
      stats.get(file.path) ??
      (file.fromPath ? stats.get(file.fromPath) : undefined);
    file.additions = value?.additions ?? 0;
    file.deletions = value?.deletions ?? 0;
    additions += file.additions;
    deletions += file.deletions;
  }
  return { baseRef: base, headRef: head, files, additions, deletions };
}

export async function getRepositoryBlame(
  cwd: string,
  path: string,
  ref = "HEAD",
): Promise<RepositoryBlameLine[]> {
  const safePath = repositoryPath(path);
  const args = ["blame", "--no-textconv", "--line-porcelain", await resolveCommit(cwd, ref)];
  args.push("--", safePath);
  const result = await gitRequired(cwd, args);
  return parseRepositoryBlame(result.stdout);
}

/** Discover regular Markdown blobs in a single pinned commit, never the worktree. */
export async function listKnowledgeDocuments(
  cwd: string,
  ref = "HEAD",
): Promise<RepositoryMarkdownDocument[]> {
  const commit = await resolveCommit(cwd, ref);
  const tracked = await gitRequired(cwd, ["ls-tree", "-r", "-z", "--full-tree", commit]);
  const paths = tracked.stdout.split("\0").filter((entry) =>
    /^100(?:644|755) blob [0-9a-f]+\t/.test(entry),
  ).map((entry) => entry.slice(entry.indexOf("\t") + 1))
    .filter((path) => /\.(?:md|mdx)$/.test(path)).slice(0, 250);
  const documents: RepositoryMarkdownDocument[] = [];
  for (const path of paths) {
    const file = await getRepositoryFile(cwd, path, commit);
    if (!file.binary) documents.push({
      ...describeKnowledgeDocument(path, file.content, file.objectId, false),
      ref: commit,
    });
  }
  return documents;
}

/** Shared presentation metadata; authority and mutable reads remain host-owned. */
export function describeKnowledgeDocument(path: string, content: string, objectId: string, modified: boolean): KnowledgeDocument {
  const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || path;
  const body = content.replace(/^#\s+.+$/m, "").replace(/\s+/g, " ").trim();
  return { authority: "canonical", path, title, preview: body.slice(0, 240), objectId, modified };
}

function parseChangedFiles(raw: string): RepositoryChangedFile[] {
  const values = raw.split("\0").filter(Boolean);
  const files: RepositoryChangedFile[] = [];
  for (let index = 0; index < values.length;) {
    const code = values[index++] || "";
    const status = statusName(code[0] || "");
    if (code.startsWith("R") || code.startsWith("C")) {
      const fromPath = values[index++] || "";
      const path = values[index++] || "";
      if (path)
        files.push({ path, fromPath, status, additions: 0, deletions: 0 });
    } else {
      const path = values[index++] || "";
      if (path) files.push({ path, status, additions: 0, deletions: 0 });
    }
  }
  return files;
}

function parseNumstat(
  raw: string,
): Map<string, { additions: number; deletions: number }> {
  const values = raw.split("\0");
  const result = new Map<string, { additions: number; deletions: number }>();
  for (let index = 0; index < values.length;) {
    const record = values[index++] || "";
    if (!record) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) throw new Error("Invalid Git numstat record");
    const added = record.slice(0, firstTab);
    const deleted = record.slice(firstTab + 1, secondTab);
    const path = record.slice(secondTab + 1);
    const value = {
      additions: Number(added) || 0,
      deletions: Number(deleted) || 0,
    };
    if (path) {
      result.set(path, value);
    } else {
      const fromPath = values[index++] || "";
      const toPath = values[index++] || "";
      if (fromPath) result.set(fromPath, value);
      if (toPath) result.set(toPath, value);
    }
  }
  return result;
}

export function parseRepositoryBlame(raw: string): RepositoryBlameLine[] {
  const lines = raw.split("\n");
  const metadata = new Map<
    string,
    Omit<RepositoryBlameLine, "line" | "text">
  >();
  const output: RepositoryBlameLine[] = [];
  let commit = "";
  let line = 0;
  let current = { authorName: "", authorEmail: "", authoredAt: 0, summary: "" };
  for (const value of lines) {
    const header = value.match(/^([0-9a-f]{40}|[0-9a-f]{64}) \d+ (\d+)(?: \d+)?$/);
    if (header) {
      commit = header[1] || "";
      line = Number(header[2]) || output.length + 1;
      const cached = metadata.get(commit);
      current = cached
        ? { ...cached }
        : { authorName: "", authorEmail: "", authoredAt: 0, summary: "" };
    } else if (value.startsWith("author ")) current.authorName = value.slice(7);
    else if (value.startsWith("author-mail "))
      current.authorEmail = value.slice(12).replace(/[<>]/g, "");
    else if (value.startsWith("author-time "))
      current.authoredAt = Number(value.slice(12)) || 0;
    else if (value.startsWith("summary ")) current.summary = value.slice(8);
    else if (value.startsWith("\t")) {
      const shared = { commit, ...current };
      metadata.set(commit, shared);
      output.push({ line, text: value.slice(1), ...shared });
    }
  }
  return output;
}

function treeEntryType(
  mode: string,
  objectType: string,
): RepositoryTreeEntry["type"] {
  if (mode === "120000") return "symlink";
  if (mode === "160000" || objectType === "commit") return "submodule";
  return objectType === "tree" ? "directory" : "file";
}

function statusName(code: string): RepositoryChangedFile["status"] {
  switch (code) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type-changed";
    default:
      return "unknown";
  }
}

export function repositoryPath(path: string, allowEmpty = false): string {
  // Git object paths are POSIX names, not host filesystem paths. A literal
  // backslash must never silently retarget an immutable read to another blob.
  const normalized = path.replace(/^\.\//, "");
  if (
    (!normalized && !allowEmpty) ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error("Invalid repository path");
  }
  return normalized;
}

async function assertFullHistory(cwd: string): Promise<void> {
  // Pretty-format %P and traversal hide parents at a shallow boundary. Without
  // a partial-history contract, never label that boundary an actual root/end.
  const result = await gitRequired(cwd, ["rev-parse", "--is-shallow-repository"]);
  if (result.stdout.trim() !== "false") throw new Error("Repository history is shallow or cannot be verified as complete");
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  return Number.isSafeInteger(value)
    ? Math.max(min, Math.min(max, value!))
    : fallback;
}

async function gitRequired(cwd: string, args: string[], maxBytes?: number) {
  const result = await git(cwd, args, maxBytes);
  if (result.timedOut)
    throw new Error("Git command timed out");
  if (result.exitCode !== 0)
    throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result;
}

async function git(cwd: string, args: string[], maxBytes?: number) {
  const result = await runGit(cwd, args, maxBytes);
  if (maxBytes === undefined) {
    if (result.stdoutTruncated) throw new Error("Git metadata output limit exceeded");
    try { result.stdout = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes); }
    catch { throw new Error("Git metadata could not be decoded as UTF-8 without loss"); }
  }
  return result;
}
