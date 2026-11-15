import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  AnnotationCreate,
  AnnotationPlacement,
  GitAnnotationTarget,
} from "./contracts.js";
import { runGit, type GitResult } from "@jpahd/repository-core/git";

const MAX_BLOB_BYTES = 512 * 1024;
const MAX_COMMAND_OUTPUT = 2 * 1024 * 1024;
const MAX_SMALL_OUTPUT = 64 * 1024;

// A record-count bound alone would still retain hundreds of full source files
// and patches. Keep only a small working set per resolution request.
function cacheValue<T>(cache: Map<string, T>, key: string, value: T): void {
  if (cache.size >= 8) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
}

interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  path: string;
}

interface Lines {
  lines: string[];
}

interface PathChange {
  kind: string;
  path: string;
  newPath?: string;
}

/**
 * The fingerprint is deliberately only a text anchor. `trim-line-end` removes
 * trailing spaces and tabs from each selected line; it does not remove
 * indentation or whitespace inside a line. This makes no semantic-validity
 * guarantee about the source.
 */
export async function gitRepositoryKey(cwd: string): Promise<string> {
  const workingDirectory = await realpath(cwd);
  const result = await runGit(workingDirectory, ["rev-parse", "--git-common-dir"], MAX_SMALL_OUTPUT);
  if (!ok(result)) throw gitFailure("Could not identify the Git repository", result);
  const value = decodeUtf8(result.bytes).trim();
  if (!value || value.includes("\n") || value.includes("\0")) {
    throw new Error("Could not identify the Git repository");
  }
  return await realpath(resolve(workingDirectory, value));
}

/** Resolve a symbolic ref once. WORKTREE is the only ephemeral ref. */
export async function resolveAnnotationRef(cwd: string, ref?: string): Promise<string> {
  if (ref === "WORKTREE") return "WORKTREE";
  const requestedRef = ref ?? "HEAD";
  if (typeof requestedRef !== "string" || requestedRef.length === 0 || requestedRef.includes("\0")) {
    throw new Error("Invalid Git ref");
  }
  const workingDirectory = await realpath(cwd);
  const result = await runGit(
    workingDirectory,
    ["rev-parse", "--verify", "--end-of-options", `${requestedRef}^{commit}`],
    MAX_SMALL_OUTPUT,
  );
  if (!ok(result)) throw gitFailure("Could not resolve Git ref", result);
  const value = decodeUtf8(result.bytes).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) throw new Error("Could not resolve Git ref");
  return value;
}

export async function createGitTarget(
  cwd: string,
  input: Pick<AnnotationCreate, "ref" | "path" | "startLine" | "endLine" | "whitespace">,
): Promise<GitAnnotationTarget> {
  const ref = await resolveAnnotationRef(cwd, input.ref);
  if (ref === "WORKTREE") throw new Error("Original annotations must target an immutable Git commit");
  const whitespace = input.whitespace ?? "exact";
  if (whitespace !== "exact" && whitespace !== "trim-line-end") {
    throw new Error("Invalid annotation whitespace policy");
  }

  const root = await repositoryRoot(cwd);
  const path = validatePath(input.path);
  const entry = await treeEntry(root, ref, path);
  if (!entry || entry.type !== "blob" || !isRegularMode(entry.mode)) {
    throw new Error("Annotation path is not a regular Git file");
  }

  const text = await blobText(root, entry.oid);
  const lines = splitLines(text);
  validateRange(input.startLine, input.endLine, lines.lines.length);
  const quote = selectQuote(lines.lines, input.startLine, input.endLine);

  return {
    kind: "git",
    commit: ref,
    blob: entry.oid,
    path,
    startLine: input.startLine,
    endLine: input.endLine,
    quote: {
      exact: quote,
      prefix: contextBefore(lines.lines, input.startLine),
      suffix: contextAfter(lines.lines, input.endLine),
    },
    fingerprint: fingerprint(quote, whitespace),
    whitespace,
  };
}

export async function createGitResolver(
  cwd: string,
  ref: string,
): Promise<(target: GitAnnotationTarget) => Promise<AnnotationPlacement>> {
  const root = await repositoryRoot(cwd);
  const resolvedRef = await resolveAnnotationRef(root, ref);
  const fileCache = new Map<string, Promise<Lines | undefined>>();
  const entryCache = new Map<string, Promise<TreeEntry | undefined>>();
  const changeCache = new Map<string, Promise<PathChange[] | undefined>>();
  const patchCache = new Map<string, Promise<string | undefined>>();
  const blobCache = new Map<string, Promise<string>>();

  const getEntry = (revision: string, path: string) => {
    const key = `${revision}\0${path}`;
    let value = entryCache.get(key);
    if (!value) {
      value = treeEntry(root, revision, path);
      cacheValue(entryCache, key, value);
    }
    return value;
  };

  const getBlob = (oid: string) => {
    let value = blobCache.get(oid);
    if (!value) {
      value = blobText(root, oid);
      cacheValue(blobCache, oid, value);
    }
    return value;
  };

  const getFile = (revision: string, path: string) => {
    const key = `${revision}\0${path}`;
    let value = fileCache.get(key);
    if (!value) {
      value = revision === "WORKTREE"
        ? worktreeText(root, path)
        : getEntry(revision, path).then(async (entry) => {
            if (!entry || entry.type !== "blob" || !isRegularMode(entry.mode)) return undefined;
            try {
              return splitLines(await getBlob(entry.oid));
            } catch {
              return undefined;
            }
          });
      cacheValue(fileCache, key, value);
    }
    return value;
  };

  const getChanges = (from: string) => {
    const key = `${from}\0${resolvedRef}`;
    let value = changeCache.get(key);
    if (!value) {
      value = changedPaths(root, from, resolvedRef);
      cacheValue(changeCache, key, value);
    }
    return value;
  };

  const getPatch = (from: string, path: string, currentPath: string) => {
    const key = `${from}\0${resolvedRef}\0${path}\0${currentPath}`;
    let value = patchCache.get(key);
    if (!value) {
      value = diffPatch(root, from, resolvedRef, path, currentPath);
      cacheValue(patchCache, key, value);
    }
    return value;
  };

  return async (target: GitAnnotationTarget): Promise<AnnotationPlacement> => {
    const base = { ref: resolvedRef } as AnnotationPlacement;
    if (!isTargetShape(target)) return { ...base, status: "unplaced", reason: "Invalid annotation target" };
    const originalPath = validatePathForResolution(target.path);
    if (!originalPath || !isObjectId(target.blob) || !isObjectId(target.commit)) {
      return { ...base, status: "unplaced", reason: "Invalid annotation target" };
    }

    let original: Lines;
    try {
      const entry = await getEntry(target.commit, originalPath);
      if (!entry || entry.oid !== target.blob || entry.type !== "blob" || !isRegularMode(entry.mode)) {
        return { ...base, status: "unplaced", reason: "Original commit/blob unavailable" };
      }
      original = splitLines(await getBlob(target.blob));
    } catch {
      return { ...base, status: "unplaced", reason: "Original commit/blob unavailable" };
    }

    if (!targetRangeMatches(target, original.lines)) {
      return { ...base, status: "unplaced", reason: "Original target does not match its commit" };
    }

    let currentPath = originalPath;
    const changes = await getChanges(target.commit);
    if (!changes) return { ...base, status: "unplaced", reason: "Could not resolve Git path history" };
    const relevant = changes.find((change) => change.path === originalPath);
    if (relevant?.kind === "D") {
      return { ...base, status: "unplaced", reason: "The annotated file was deleted" };
    }
    if (relevant?.newPath) {
      const destination = validatePathForResolution(relevant.newPath);
      if (!destination) {
        return { ...base, status: "unplaced", reason: "The renamed annotation path is unsupported" };
      }
      currentPath = destination;
    }
    if (!relevant && changes.some((change) => change.newPath === originalPath)) {
      return { ...base, status: "unplaced", reason: "The annotated path was replaced" };
    }

    const current = await getFile(resolvedRef, currentPath);
    if (!current) {
      return { ...base, status: "unplaced", reason: "The annotated file is unavailable" };
    }

    // An identical complete snapshot preserves the historical coordinates even
    // when the text appears several times. Otherwise a diff's arbitrary choice
    // between identical repeated blocks is not proof of occurrence identity.
    if (current.lines.length === original.lines.length &&
        current.lines.every((line, index) => line === original.lines[index])) {
      return { ...base, status: currentPath === originalPath ? "unchanged" : "moved",
        path: currentPath, startLine: target.startLine, endLine: target.endLine };
    }

    // A changed snapshot must identify the original occurrence as well as a
    // current occurrence. In particular, a diff is not allowed to relocate an
    // annotation from a deleted copy to an indistinguishable surviving copy.
    const originalOccurrences = findCandidates(original.lines, target);
    const originalCandidate = uniqueOccurrence(original.lines, target);
    if (originalCandidate !== target.startLine - 1) {
      return { ...base, status: "unplaced", path: currentPath, reason: "Ambiguous repeated annotation context" };
    }
    const candidates = findCandidates(current.lines, target);
    const patch = await getPatch(target.commit, originalPath, currentPath);
    const projection = patch === undefined ? undefined : projectRange(patch, target.startLine, target.endLine);
    if (candidates.length === 0) {
      const deleted = patch !== undefined && rangeDeleted(patch, target.startLine, target.endLine);
      return {
        ...base,
        status: deleted ? "unplaced" : "stale",
        path: currentPath,
        reason: deleted ? "The annotated lines were removed" : "The selected text changed",
      };
    }
    if (patch === undefined || projection === undefined) {
      return { ...base, status: "unplaced", path: currentPath, reason: "Could not project the original annotation range" };
    }
    const projectedCandidate = candidates.includes(projection.start - 1) ? projection.start - 1 : undefined;
    if (originalOccurrences.length > 1) {
      const contextual = candidates.filter((index) => matchesFullContext(current.lines, index, target));
      if (contextual.length !== 1) {
        return { ...base, status: "unplaced", path: currentPath, reason: "Ambiguous repeated annotation context" };
      }
    }
    if (projection.overlap &&
        (projectedCandidate === undefined || target.whitespace !== "trim-line-end" ||
         !overlapHasStableLineCount(patch, target.startLine, target.endLine))) {
      return { ...base, status: "unplaced", path: currentPath, reason: "The original annotation range changed" };
    }

    const candidate = uniqueOccurrence(current.lines, target);
    if (candidate === undefined || candidate !== projectedCandidate) {
      return { ...base, status: "unplaced", path: currentPath, reason: "Ambiguous repeated annotation context" };
    }
    const startLine = candidate + 1;
    const endLine = candidate + lineCount(target.quote.exact);
    const status = currentPath === originalPath && startLine === target.startLine && endLine === target.endLine
      ? "unchanged"
      : "moved";
    return { ...base, status, path: currentPath, startLine, endLine };
  };
}

function isTargetShape(target: GitAnnotationTarget): boolean {
  return target?.kind === "git" && (target.whitespace === "exact" || target.whitespace === "trim-line-end") &&
    Number.isSafeInteger(target.startLine) && Number.isSafeInteger(target.endLine) &&
    target.startLine >= 1 && target.endLine >= target.startLine &&
    typeof target.path === "string" && typeof target.blob === "string" && typeof target.commit === "string" &&
    typeof target.quote?.exact === "string" && typeof target.quote?.prefix === "string" &&
    typeof target.quote?.suffix === "string" && typeof target.fingerprint === "string";
}

function validatePath(path: string): string {
  const validated = validatePathForResolution(path);
  if (!validated) throw new Error("Invalid annotation path");
  return validated;
}

function validatePathForResolution(path: string): string | undefined {
  if (typeof path !== "string" || !path || path.includes("\0") || path.includes("\\") || path.startsWith(":") ||
      path.startsWith("!") || path.startsWith("^") || /[*?\[\]]/u.test(path)) return undefined;
  if (isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/")) return undefined;
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part === ".git")) return undefined;
  const root = resolve("/", "workspace");
  const candidate = resolve(root, ...parts);
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return path;
}

function validateRange(start: number, end: number, lineCount: number): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > lineCount) {
    throw new Error("Invalid annotation line range");
  }
}

function splitLines(text: string): Lines {
  if (text.length === 0) return { lines: [] };
  const lines = text.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  if (text.endsWith("\n")) lines.pop();
  return { lines };
}

function selectQuote(lines: string[], start: number, end: number): string {
  return lines.slice(start - 1, end).join("\n");
}

function contextBefore(lines: string[], start: number): string {
  return lines.slice(Math.max(0, start - 1 - 3), start - 1).join("\n");
}

function contextAfter(lines: string[], end: number): string {
  return lines.slice(end, end + 3).join("\n");
}

function lineCount(quote: string): number {
  return quote.length === 0 ? 1 : quote.split("\n").length;
}

function normalize(text: string, whitespace: GitAnnotationTarget["whitespace"]): string {
  if (whitespace === "exact") return text;
  return text.split("\n").map((line) => line.replace(/[ \t]+$/u, "")).join("\n");
}

function fingerprint(text: string, whitespace: GitAnnotationTarget["whitespace"]): string {
  return createHash("sha256").update(normalize(text, whitespace), "utf8").digest("hex");
}

function targetRangeMatches(target: GitAnnotationTarget, lines: string[]): boolean {
  if (target.endLine > lines.length) return false;
  const quote = selectQuote(lines, target.startLine, target.endLine);
  return quote === target.quote.exact && fingerprint(quote, target.whitespace) === target.fingerprint;
}

function findCandidates(lines: string[], target: GitAnnotationTarget): number[] {
  const wanted = target.quote.exact.split("\n").map((line) => normalize(line, target.whitespace));
  const actual = lines.map((line) => normalize(line, target.whitespace));
  const prefix = kmpPrefix(wanted);
  const result: number[] = [];
  let matched = 0;
  for (let index = 0; index < actual.length; index += 1) {
    while (matched > 0 && actual[index] !== wanted[matched]) matched = prefix[matched - 1]!;
    if (actual[index] === wanted[matched]) matched += 1;
    if (matched === wanted.length) {
      result.push(index - wanted.length + 1);
      matched = prefix[matched - 1]!;
    }
  }
  return result;
}

function kmpPrefix(pattern: string[]): number[] {
  const prefix = new Array<number>(pattern.length).fill(0);
  for (let index = 1, matched = 0; index < pattern.length; index += 1) {
    while (matched > 0 && pattern[index] !== pattern[matched]) matched = prefix[matched - 1]!;
    if (pattern[index] === pattern[matched]) matched += 1;
    prefix[index] = matched;
  }
  return prefix;
}

function matchesFullContext(lines: string[], index: number, target: GitAnnotationTarget): boolean {
  const prefix = target.quote.prefix ? target.quote.prefix.split("\n") : [];
  const suffix = target.quote.suffix ? target.quote.suffix.split("\n") : [];
  if (prefix.length + suffix.length === 0) return false;
  const end = index + lineCount(target.quote.exact);
  return index >= prefix.length && end + suffix.length <= lines.length &&
    prefix.every((line, offset) => normalize(line, target.whitespace) === normalize(lines[index - prefix.length + offset]!, target.whitespace)) &&
    suffix.every((line, offset) => normalize(line, target.whitespace) === normalize(lines[end + offset]!, target.whitespace));
}

function uniqueOccurrence(lines: string[], target: GitAnnotationTarget): number | undefined {
  const candidates = findCandidates(lines, target);
  if (candidates.length === 1) return candidates[0];
  const contextual = candidates.filter((index) => matchesFullContext(lines, index, target));
  return contextual.length === 1 ? contextual[0] : undefined;
}

function isRegularMode(mode: string): boolean {
  return /^100[0-7]{3}$/.test(mode);
}

function isObjectId(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

async function repositoryRoot(cwd: string): Promise<string> {
  const workingDirectory = await realpath(cwd);
  const result = await runGit(workingDirectory, ["rev-parse", "--show-toplevel"], MAX_SMALL_OUTPUT);
  if (!ok(result)) throw gitFailure("Could not identify the Git repository", result);
  const value = decodeUtf8(result.bytes).trim();
  if (!value || value.includes("\n")) throw new Error("Could not identify the Git repository");
  return await realpath(value);
}

async function treeEntry(root: string, revision: string, path: string): Promise<TreeEntry | undefined> {
  const result = await runGit(root, ["ls-tree", "-z", "--full-tree", revision, "--", path], MAX_SMALL_OUTPUT);
  if (!ok(result) || result.truncated) return undefined;
  const output = decodeUtf8(result.bytes);
  const records = output.split("\0").filter(Boolean);
  if (records.length !== 1) return undefined;
  const tab = records[0]!.indexOf("\t");
  if (tab < 0) return undefined;
  const fields = records[0]!.slice(0, tab).split(" ");
  if (fields.length !== 3 || fields[2] === undefined || fields[1] === undefined) return undefined;
  const entry = { mode: fields[0]!, type: fields[1]!, oid: fields[2]!, path: records[0]!.slice(tab + 1) };
  return entry.path === path ? entry : undefined;
}

async function blobText(root: string, oid: string): Promise<string> {
  const result = await runGit(root, ["cat-file", "blob", oid], MAX_BLOB_BYTES + 1);
  if (!ok(result) || result.truncated || result.bytes.length > MAX_BLOB_BYTES) {
    throw new Error("Git blob is too large or truncated");
  }
  const text = decodeUtf8(result.bytes, true);
  if (!isSafeText(text)) throw new Error("Git blob is binary");
  return text;
}

async function worktreeText(root: string, path: string): Promise<Lines | undefined> {
  try {
    const absolute = await confinedRegularFile(root, path);
    const handle = await open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_BLOB_BYTES) return undefined;
      const verified = await confinedRegularFile(root, path);
      const verifiedStat = await lstat(verified);
      if (!sameFile(opened, verifiedStat)) return undefined;

      const bytes = new Uint8Array(MAX_BLOB_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        const read = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
        if (read.bytesRead === 0) break;
        bytesRead += read.bytesRead;
      }
      if (bytesRead > MAX_BLOB_BYTES) return undefined;
      const finalPath = await confinedRegularFile(root, path);
      const finalStat = await lstat(finalPath);
      if (!sameFile(opened, finalStat)) return undefined;
      const text = decodeUtf8(bytes.subarray(0, bytesRead), true);
      if (!isSafeText(text)) return undefined;
      return splitLines(text);
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function confinedRegularFile(root: string, path: string): Promise<string> {
  let current = root;
  for (const part of path.split("/")) {
    current = resolve(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error("Symlinked annotation path");
  }
  const resolved = await realpath(current);
  const canonicalRoot = await realpath(root);
  if (resolved !== canonicalRoot && !resolved.startsWith(`${canonicalRoot}${sep}`)) {
    throw new Error("Annotation path is outside the repository");
  }
  const stat = await lstat(current);
  if (!stat.isFile()) throw new Error("Annotation path is not a regular file");
  return current;
}

async function changedPaths(root: string, from: string, to: string): Promise<PathChange[] | undefined> {
  const revisions = to === "WORKTREE" ? [from] : [from, to];
  const result = await runGit(
    root,
    ["diff", "--name-status", "-z", "-M", "--find-renames=50%", "--no-ext-diff", "--no-textconv", "--end-of-options", ...revisions, "--"],
    MAX_COMMAND_OUTPUT,
  );
  if (!ok(result) || result.truncated) return undefined;
  const records = decodeUtf8(result.bytes).split("\0").filter(Boolean);
  const changes: PathChange[] = [];
  for (let index = 0; index < records.length;) {
    const kind = records[index++]!;
    if (kind.startsWith("R") || kind.startsWith("C")) {
      const oldPath = records[index++];
      const newPath = records[index++];
      if (oldPath !== undefined && newPath !== undefined) changes.push({ kind: kind[0]!, path: oldPath, newPath });
    } else {
      const changedPath = records[index++];
      if (changedPath !== undefined) changes.push({ kind: kind[0]!, path: changedPath });
    }
  }
  return changes;
}

async function diffPatch(root: string, from: string, to: string, path: string, currentPath = path): Promise<string | undefined> {
  const revisions = to === "WORKTREE" ? [from] : [from, to];
  const paths = currentPath === path ? [path] : [path, currentPath];
  const result = await runGit(
    root,
    ["diff", "--unified=0", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames=50%", "--end-of-options", ...revisions, "--", ...paths],
    MAX_COMMAND_OUTPUT,
  );
  if (!ok(result) || result.truncated) return undefined;
  return decodeUtf8(result.bytes);
}

interface RangeProjection {
  start: number;
  overlap: boolean;
}

function projectRange(patch: string, start: number, end: number): RangeProjection {
  let delta = 0;
  for (const hunk of patchHunks(patch)) {
    const oldEnd = hunk.oldStart + hunk.oldCount - 1;
    if (hunk.oldCount === 0) {
      if (hunk.oldStart < start) delta += hunk.newCount;
      else if (hunk.oldStart < end) return { start: start + delta, overlap: true };
      continue;
    }
    if (hunk.oldStart <= end && oldEnd >= start) return { start: start + delta, overlap: true };
    if (oldEnd < start) delta += hunk.newCount - hunk.oldCount;
  }
  return { start: start + delta, overlap: false };
}

function overlapHasStableLineCount(patch: string, start: number, end: number): boolean {
  return patchHunks(patch).filter((hunk) => {
    const oldEnd = hunk.oldStart + hunk.oldCount - 1;
    return hunk.oldCount > 0 && hunk.oldStart <= end && oldEnd >= start;
  }).every((hunk) => hunk.oldCount === hunk.newCount);
}

function rangeDeleted(patch: string, start: number, end: number): boolean {
  return patchHunks(patch).some((hunk) => {
    const oldEnd = hunk.oldStart + hunk.oldCount - 1;
    return hunk.newCount === 0 && hunk.oldStart <= end && oldEnd >= start;
  });
}

interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newCount: number;
}

function patchHunks(patch: string): PatchHunk[] {
  const result: PatchHunk[] = [];
  for (const line of patch.split("\n")) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    result.push({
      oldStart: Number(match[1]),
      oldCount: Number(match[2] ?? 1),
      newCount: Number(match[4] ?? 1),
    });
  }
  return result;
}

function isSafeText(text: string): boolean {
  // NUL and other C0 controls are not useful source text and commonly signal
  // a binary blob. Tabs, line endings, and ordinary Unicode whitespace remain.
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if ((code < 0x09) || (code === 0x0b) || (code === 0x0c) ||
        (code >= 0x0e && code <= 0x1f) || code === 0x7f) return false;
  }
  return true;
}

function decodeUtf8(bytes: Uint8Array, fatal = false): string {
  return new TextDecoder("utf-8", { fatal }).decode(bytes);
}

function gitFailure(message: string, result: GitResult): Error {
  if (result.timedOut) return new Error(`${message}: Git command timed out`);
  return new Error(result.stderr.trim() || message);
}

function ok(result: GitResult): boolean {
  return result.exitCode === 0 && !result.timedOut;
}
