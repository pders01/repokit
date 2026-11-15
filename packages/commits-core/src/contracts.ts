/** Plain repository data, independent of any UI, transport, or generated schema. */
export interface CommitEntry {
  sha: string;
  shortSha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  authorTime: bigint;
  filesChanged: number;
  additions: number;
  deletions: number;
  body: string;
  parentShas: string[];
}
export interface ChangedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  fromPath: string;
}

/** Experimental, feature-specific seam. No routing, execution, or mutation authority. */
export interface ReadingScope {
  readonly key: string;
  readonly repositoryKey: string;
  readonly worktreeKey?: string;
  readonly label: string;
}
export interface Revision {
  readonly requestedRef: string;
  readonly commit: string;
}
export interface ReadResult<T> {
  readonly scopeKey: string;
  readonly value: T;
}
export type Completeness =
  | { readonly kind: "complete" }
  | { readonly kind: "partial"; readonly reason: string }
  | { readonly kind: "unknown" };
export interface CommitDiff {
  readonly toCommit: string;
  readonly base: { readonly kind: "commit"; readonly commit: string }
    | { readonly kind: "empty-tree" };
  readonly rawDiff: string;
  readonly completeness: Completeness;
  readonly empty: boolean | undefined;
  readonly files?: readonly ChangedFile[];
}
export interface ReadingRef {
  readonly name: string;
  readonly selector: string;
  readonly kind: "branch" | "tag";
}
/** Safe, portable failure categories. Never render an arbitrary backend error message. */
export class RepositoryReadError extends Error {
  constructor(readonly code: "invalid" | "timeout" | "unavailable" | "incompatible") {
    super(`Repository read ${code}.`);
    this.name = "RepositoryReadError";
  }
}
export interface CommitsProvider {
  readonly scope: ReadingScope;
  describe(signal: AbortSignal): Promise<ReadResult<{ initialRef: string }>>;
  listRefs(signal: AbortSignal): Promise<ReadResult<readonly ReadingRef[]>>;
  resolve(ref: string, signal: AbortSignal): Promise<ReadResult<Revision>>;
  list(query: {
    readonly revision: Revision;
    readonly path?: string;
    readonly limit: number;
    readonly offset: number;
  }, signal: AbortSignal): Promise<ReadResult<{
    commits: readonly CommitEntry[];
    hasMore: boolean;
  }>>;
  commit(sha: string, signal: AbortSignal): Promise<ReadResult<CommitEntry>>;
  diff(query: {
    readonly commit: string;
    readonly path?: string;
    readonly base: "first-parent";
  }, signal: AbortSignal): Promise<ReadResult<CommitDiff>>;
}
export interface CommitsLocation {
  readonly ref: string;
  readonly anchor?: string;
  readonly path?: string;
  readonly commit?: string;
}
export type CommitsIntent =
  | { readonly kind: "location"; readonly location: CommitsLocation }
  | { readonly kind: "refresh" }
  | { readonly kind: "explain"; readonly commit: string; readonly subject: string }
  | { readonly kind: "return" };
export interface CommitsIntentDetail {
  readonly instanceKey: string;
  readonly scopeKey: string;
  readonly intent: CommitsIntent;
}
export type ReaderAction = "explain" | "return";

/** Reader memory/render limits, not claims about backend transport limits. */
export const READER_LIMITS = Object.freeze({
  page: 80,
  offset: 10_000,
  loadedRows: 400,
  refs: 2_000,
  patchBytes: 2 * 1024 * 1024,
  renderPatchBytes: 256 * 1024,
  renderPatchLines: 4_000,
  wordPairCells: 65_536,
  wordTotalCells: 524_288,
  requestMs: 10_000,
});
export function fullCommit(value: string): string {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value))
    throw new Error("Expected a full commit object ID.");
  return value;
}
export function readingLocation(value: CommitsLocation): CommitsLocation {
  if (typeof value.ref !== "string" || !value.ref || value.ref.length > 1024 || /[\0\r\n]/.test(value.ref))
    throw new Error("Invalid history ref.");
  if (value.path !== undefined && (value.path.length > 4096 || value.path.includes("\0")))
    throw new Error("Invalid exact-path filter.");
  return Object.freeze({ ref: value.ref, ...(value.anchor !== undefined ? { anchor: fullCommit(value.anchor) } : {}),
    ...(value.path !== undefined ? { path: value.path } : {}),
    ...(value.commit !== undefined ? { commit: fullCommit(value.commit) } : {}) });
}

/** Only the host persists locations; opaque scope keys are never URL identities. */
export function locationSearch(location: CommitsLocation): string {
  const clean = readingLocation(location);
  const params = new URLSearchParams({ ref: clean.ref });
  for (const key of ["anchor", "path", "commit"] as const)
    if (clean[key] !== undefined) params.set(key, clean[key]);
  return params.toString();
}
export function locationFromSearch(search: string): CommitsLocation {
  const params = new URLSearchParams(search);
  return readingLocation({ ref: params.get("ref") ?? "HEAD",
    ...(params.has("anchor") ? { anchor: params.get("anchor")! } : {}),
    ...(params.has("path") ? { path: params.get("path")! } : {}),
    ...(params.has("commit") ? { commit: params.get("commit")! } : {}) });
}

/** Conservative preflight for Chatworks' paired-line word LCS. Never hand unbounded work to it. */
export function structuredPatchSafe(raw: string): boolean {
  const lines = raw.split(/\r\n?|\n/);
  const isDel = (line: string) => line.startsWith("-") && !line.startsWith("---");
  const isAdd = (line: string) => line.startsWith("+") && !line.startsWith("+++");
  let total = 0;
  let i = 0;
  while (i < lines.length) {
    if (!isDel(lines[i])) { i++; continue; }
    const start = i;
    while (i < lines.length && isDel(lines[i])) i++;
    const added = i;
    while (i < lines.length && isAdd(lines[i])) i++;
    const pairs = Math.min(added - start, i - added);
    for (let pair = 0; pair < pairs; pair++) {
      const before = lines[start + pair].slice(1), after = lines[added + pair].slice(1);
      if (before === after) continue;
      const cells = (before.split(/(\s+)/).length + 1) * (after.split(/(\s+)/).length + 1);
      total += cells;
      if (cells > READER_LIMITS.wordPairCells || total > READER_LIMITS.wordTotalCells) return false;
    }
  }
  return true;
}

/** Match Chatworks' CRLF/CR/LF split, but retain literal separators in the returned slice. */
function patchPrefixEnd(raw: string, lines: number): number {
  for (const match of raw.matchAll(/\r\n?|\n/g)) {
    if (--lines === 0) return match.index;
  }
  return raw.length;
}

/** Original patch stays in state. A clipped view reserves part of the SAME budget for its ending. */
export function patchPresentation(raw: string): { text: string; clipped: boolean; tail?: string } {
  const bytes = new TextEncoder().encode(raw);
  if (bytes.length <= READER_LIMITS.renderPatchBytes && patchPrefixEnd(raw, READER_LIMITS.renderPatchLines) === raw.length)
    return { text: raw, clipped: false };
  const tailBytes = 4096, tailLines = 64;
  // Decode only to locate UTF-16 offsets, then slice the original text. This preserves
  // BOMs, literal line endings and even unpaired surrogates, without splitting UTF-8.
  const prefix = (limit: number) => {
    let end = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(0, limit), { stream: true }).length;
    if (raw[end - 1] === "\r" && raw[end] === "\n") end--;
    return raw.slice(0, end);
  };
  let start = Math.max(0, bytes.length - tailBytes);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  start = raw.length - new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(start)).length;
  if (raw[start - 1] === "\r" && raw[start] === "\n") start++;
  let tail = raw.slice(start);
  const endings = [...tail.matchAll(/\r\n?|\n/g)];
  if (endings.length >= tailLines) {
    const boundary = endings[endings.length - tailLines];
    tail = tail.slice(boundary.index + boundary[0].length);
  }
  const beginning = prefix(READER_LIMITS.renderPatchBytes - tailBytes);
  const text = beginning.slice(0, patchPrefixEnd(beginning, READER_LIMITS.renderPatchLines - tailLines));
  // The ending is separate plain text, never concatenated into synthetic diff hunks.
  // No English prose is parsed or used to infer completeness.
  return { text, tail, clipped: true };
}
