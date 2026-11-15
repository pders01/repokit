import type { RepositoryFileSearch } from "./contracts.js";
import { runGit } from "./git.js";
import { resolveCommit } from "./commit.js";

const MAX_QUERY_LENGTH = 128;
const MAX_RESULTS = 100;
const MAX_LISTING_BYTES = 2 * 1024 * 1024;
const MAX_SCANNED_ENTRIES = 50_000;

/** Search regular files in one immutable commit, without consulting the worktree. */
export async function searchRepositoryFiles(
  cwd: string,
  query: string,
  ref?: string,
): Promise<RepositoryFileSearch> {
  validateQuery(query);
  const commit = await resolveCommit(cwd, ref);
  const listing = await runGit(
    cwd,
    ["ls-tree", "--full-tree", "-r", "-z", commit],
    MAX_LISTING_BYTES + 1,
  );
  if (listing.timedOut) throw new Error("Git command timed out");
  if (listing.exitCode !== 0) throw gitFailure("ls-tree", listing.stderr);

  // Keep one extra byte only to detect that the byte bound was crossed. Never
  // parse a record without its terminating NUL.
  const parsed = parseListing(
    listing.bytes.subarray(0, MAX_LISTING_BYTES),
  );
  const incomplete =
    listing.stdoutTruncated ||
    listing.bytes.byteLength > MAX_LISTING_BYTES ||
    parsed.partialRecord ||
    parsed.entryLimitExceeded;
  const queryLower = query.toLowerCase();
  const matches = parsed.paths
    .map((path) => ({ path, rank: rankPath(path, queryLower) }))
    .filter((entry): entry is { path: string; rank: Rank } => entry.rank !== null)
    .sort((left, right) => compareRanks(left, right));

  return {
    ref: commit,
    paths: matches.slice(0, MAX_RESULTS).map((entry) => entry.path),
    truncated: matches.length > MAX_RESULTS,
    incomplete,
  };
}

function validateQuery(query: unknown): asserts query is string {
  if (
    typeof query !== "string" ||
    query.length > MAX_QUERY_LENGTH ||
    query.includes("\0")
  ) {
    throw new Error("Invalid repository search query");
  }
}

interface ParsedListing {
  paths: string[];
  partialRecord: boolean;
  entryLimitExceeded: boolean;
}

function parseListing(bytes: Uint8Array): ParsedListing {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const paths: string[] = [];
  let start = 0;
  let scannedEntries = 0;
  let partialRecord = false;
  let entryLimitExceeded = false;

  while (start < bytes.byteLength) {
    const nul = bytes.indexOf(0, start);
    if (nul < 0) {
      partialRecord = true;
      break;
    }
    if (scannedEntries >= MAX_SCANNED_ENTRIES) {
      entryLimitExceeded = true;
      break;
    }
    scannedEntries += 1;
    const record = bytes.subarray(start, nul);
    const tab = record.indexOf(9);
    if (tab >= 0) {
      try {
        const metadata = decoder.decode(record.subarray(0, tab)).split(/\s+/);
        const path = decoder.decode(record.subarray(tab + 1));
        if (
          (metadata[0] === "100644" || metadata[0] === "100755") &&
          metadata[1] === "blob" &&
          isSafeRepositoryPath(path)
        ) {
          paths.push(path);
        }
      } catch {
        // Invalid Git filename bytes are not safe to return as a path.
      }
    }
    start = nul + 1;
  }

  return { paths, partialRecord, entryLimitExceeded };
}

function isSafeRepositoryPath(path: string): boolean {
  if (
    !path ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:\//.test(path)
  ) {
    return false;
  }
  const segments = path.split("/");
  return segments.every(
    (segment) => segment !== "" && segment !== "." && segment !== ".." && segment !== ".git",
  );
}

interface Rank {
  category: number;
  position: number;
  span: number;
  length: number;
}

function rankPath(path: string, query: string): Rank | null {
  if (!query) return { category: 0, position: 0, span: 0, length: 0 };
  const lowerPath = path.toLowerCase();
  const basename = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const exactPath = lowerPath === query;
  const exactBasename = basename === query;
  if (exactPath) return { category: 0, position: 0, span: 0, length: path.length };
  if (exactBasename) return { category: 1, position: 0, span: 0, length: path.length };

  const basenamePrefix = basename.startsWith(query);
  if (basenamePrefix) return { category: 2, position: 0, span: query.length, length: path.length };
  const pathPrefix = lowerPath.startsWith(query);
  if (pathPrefix) return { category: 3, position: 0, span: query.length, length: path.length };

  const basenamePosition = basename.indexOf(query);
  if (basenamePosition >= 0) {
    return {
      category: 4,
      position: basenamePosition,
      span: query.length,
      length: path.length,
    };
  }
  const pathPosition = lowerPath.indexOf(query);
  if (pathPosition >= 0) {
    return {
      category: 5,
      position: pathPosition,
      span: query.length,
      length: path.length,
    };
  }

  const fuzzy = subsequenceRank(lowerPath, query);
  return fuzzy
    ? { category: 6, position: fuzzy.position, span: fuzzy.span, length: path.length }
    : null;
}

function subsequenceRank(
  value: string,
  query: string,
): { position: number; span: number } | null {
  let queryIndex = 0;
  let first = -1;
  let last = -1;
  for (let index = 0; index < value.length && queryIndex < query.length; index += 1) {
    if (value[index] !== query[queryIndex]) continue;
    if (first < 0) first = index;
    last = index;
    queryIndex += 1;
  }
  return queryIndex === query.length && first >= 0
    ? { position: first, span: last - first + 1 }
    : null;
}

function compareRanks(
  left: { path: string; rank: Rank },
  right: { path: string; rank: Rank },
): number {
  return (
    left.rank.category - right.rank.category ||
    left.rank.position - right.rank.position ||
    left.rank.span - right.rank.span ||
    left.rank.length - right.rank.length ||
    compareStrings(left.path.toLowerCase(), right.path.toLowerCase()) ||
    compareStrings(left.path, right.path)
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function gitFailure(command: string, stderr: string): Error {
  return new Error(stderr.trim() || `git ${command} failed`);
}
