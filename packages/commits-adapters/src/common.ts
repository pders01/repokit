import type { ChangedFile, CommitEntry } from "@jpahd/commits-core/contracts";
import {
  fullCommit, READER_LIMITS, RepositoryReadError,
  type CommitsProvider, type ReadResult, type ReadingRef, type ReadingScope,
} from "@jpahd/commits-core/contracts";

export class ReadingAdapterError extends RepositoryReadError {
  constructor(code: "invalid" | "timeout" | "unavailable" | "incompatible") {
    super(code);
    this.message = code === "invalid" ? "Invalid reading binding, query, or response."
      : code === "timeout" ? "Repository read timed out."
      : code === "incompatible" ? "Bounded repository reads are not supported by this connection." : "Repository read unavailable.";
    this.name = "ReadingAdapterError";
  }
}
export function invalidRead(): never { throw new ReadingAdapterError("invalid"); }
export function boundedText(value: unknown, maximum = 16_384): string {
  if (typeof value !== "string" || value.length > maximum) invalidRead();
  return value;
}
export function objectId(value: unknown): string {
  try { return fullCommit(boundedText(value, 64)); } catch { return invalidRead(); }
}
export function opaqueKey(value: unknown): string {
  const key = boundedText(value, 256);
  if (!key || /[\0\r\n]/.test(key)) invalidRead();
  return key;
}
export function captureScope(value: ReadingScope): ReadingScope {
  if (!value) invalidRead();
  const label = boundedText(value.label, 1024);
  if (!label) invalidRead();
  return Object.freeze({ key: opaqueKey(value.key), repositoryKey: opaqueKey(value.repositoryKey),
    ...(value.worktreeKey !== undefined ? { worktreeKey: opaqueKey(value.worktreeKey) } : {}), label });
}
export function requestedRef(value: unknown): string {
  const ref = boundedText(value, 1024);
  if (!ref || ref.startsWith("-") || ref.startsWith("^") || ref.includes("..") || /\^[!@]/.test(ref) || /[\0\r\n]/.test(ref)) invalidRead();
  return ref;
}
/** Both APIs return short names. A literal name beginning "refs/" must not be peeled. */
export function readingRef(nameValue: unknown, kind: "branch" | "tag"): ReadingRef {
  const name = boundedText(nameValue, 1024);
  if (!name || /[\x00-\x20\x7f~^:?*\[\\]/.test(name) || name.includes("..") || name.includes("@{") ||
      name.endsWith(".") || name.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))) invalidRead();
  const prefix = kind === "branch" ? "refs/heads/" : "refs/tags/";
  return Object.freeze({ name, kind, selector: requestedRef(`${prefix}${name}`) });
}

/** Reject inputs that either backend would normalize into a different exact path. */
export function exactPath(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const path = boundedText(value, 4096);
  // Native Git log interprets pathspec magic/globs; neither current API promises literal mode.
  // Fail explicitly for such filenames instead of claiming an expanded match was exact history.
  if (path.includes("\0") || path.includes("\\") || path.startsWith("/") || path.startsWith(":") || /[*?\[\]]/.test(path) ||
      (path !== "" && path.split("/").some((part) => part === ".." || part === "." || part === ""))) invalidRead();
  return path;
}
export function listQuery(query: Parameters<CommitsProvider["list"]>[0]) {
  if (!query || !query.revision || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > READER_LIMITS.page ||
      !Number.isSafeInteger(query.offset) || query.offset < 0 || query.offset > READER_LIMITS.offset) invalidRead();
  return Object.freeze({ revision: Object.freeze({ requestedRef: requestedRef(query.revision.requestedRef),
    commit: objectId(query.revision.commit) }), path: exactPath(query.path), limit: query.limit, offset: query.offset });
}
export function diffQuery(query: Parameters<CommitsProvider["diff"]>[0]) {
  if (!query || query.base !== "first-parent") invalidRead();
  return Object.freeze({ commit: objectId(query.commit), path: exactPath(query.path), base: "first-parent" as const });
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalidRead();
  return value;
}
/** Explicit field copy drops protobuf bookkeeping and cannot retain a mutable wire object. */
export function commitValue(value: CommitEntry): CommitEntry {
  if (!value || !Array.isArray(value.parentShas) || value.parentShas.length > 64 ||
      typeof value.authorTime !== "bigint" || value.authorTime < 0n || value.authorTime > 8_640_000_000_000n) invalidRead();
  return Object.freeze({ sha: objectId(value.sha), shortSha: boundedText(value.shortSha, 64),
    message: boundedText(value.message), body: boundedText(value.body, 65_536),
    authorName: boundedText(value.authorName), authorEmail: boundedText(value.authorEmail), authorTime: value.authorTime,
    parentShas: Object.freeze(value.parentShas.map(objectId)) as unknown as string[],
    filesChanged: count(value.filesChanged), additions: count(value.additions), deletions: count(value.deletions) });
}
export function pageValue(value: { commits: readonly CommitEntry[]; hasMore: boolean }, limit: number) {
  if (!value || !Array.isArray(value.commits) || value.commits.length > limit || typeof value.hasMore !== "boolean" ||
      (value.hasMore && !value.commits.length)) invalidRead();
  const commits = Object.freeze(value.commits.map(commitValue));
  if (new Set(commits.map((commit) => commit.sha)).size !== commits.length) invalidRead();
  return Object.freeze({ commits, hasMore: value.hasMore });
}
export function patchText(value: unknown): string {
  const text = boundedText(value, READER_LIMITS.patchBytes);
  if (new TextEncoder().encode(text).byteLength > READER_LIMITS.patchBytes) invalidRead();
  return text;
}
export function changedFiles(value: readonly ChangedFile[]): readonly ChangedFile[] {
  if (!Array.isArray(value) || value.length > 2_000) invalidRead();
  return Object.freeze(value.map((file) => {
    if (!file) invalidRead();
    return Object.freeze({ path: boundedText(file.path, 4096), fromPath: boundedText(file.fromPath, 4096),
      status: boundedText(file.status, 128), additions: count(file.additions), deletions: count(file.deletions) });
  }));
}
export function resultValue<T>(scope: ReadingScope, value: T): ReadResult<T> {
  return Object.freeze({ scopeKey: scope.key, value });
}
export function readTimeout(value: number = READER_LIMITS.requestMs): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > READER_LIMITS.requestMs) invalidRead();
  return value;
}
/** A finite local wait even with an injected transport that ignores cancellation. */
export async function readOperation<T>(parent: AbortSignal, timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  parent.throwIfAborted();
  const controller = new AbortController();
  const relay = () => controller.abort(parent.reason);
  parent.addEventListener("abort", relay, { once: true });
  let rejectAbort: (reason: unknown) => void = () => {};
  const abort = () => rejectAbort(controller.signal.reason);
  const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject; });
  controller.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new ReadingAdapterError("timeout")), timeoutMs);
  try {
    const pending = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return operation(controller.signal);
    });
    const result = await Promise.race([pending, cancelled]);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof ReadingAdapterError) throw error;
    // Never carry backend paths, tokens, failures or request payloads in public errors.
    throw new ReadingAdapterError("unavailable");
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", relay);
    controller.signal.removeEventListener("abort", abort);
  }
}
