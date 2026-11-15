import type { RepositoryCommit } from "./contracts.js";

// Valid Git commit text cannot contain NUL. Unlike RS/US, it cannot collide with
// ordinary repository-controlled subject/body text. Shortstat occupies the final
// field up to the next record's leading NUL (or EOF).
export const REPOSITORY_LOG_FORMAT = "%x00%H%x00%h%x00%s%x00%an%x00%ae%x00%at%x00%P%x00%b%x00";
const objectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
function invalid(): never { throw new Error("Git commit metadata could not be read without loss"); }

/** Decode a complete, bounded native Git result; never publish a partial record. */
export function parseRepositoryLog(bytes: Uint8Array): RepositoryCommit[] {
  let raw: string;
  try { raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return invalid(); }
  if (!raw) return [];
  const fields = raw.split("\0");
  if (fields[0] !== "" || (fields.length - 1) % 9 !== 0) invalid();
  const commits: RepositoryCommit[] = [];
  for (let index = 1; index < fields.length; index += 9) {
    const [sha, shortSha, subject, authorName, authorEmail, timestamp, parents, body, stats] = fields.slice(index, index + 9) as
      [string, string, string, string, string, string, string, string, string];
    const parentShas = parents ? parents.split(" ") : [];
    const authoredAt = Number(timestamp);
    if (!objectId.test(sha) || !/^[0-9a-f]{4,64}$/.test(shortSha) || !sha.startsWith(shortSha) ||
        !/^-?\d+$/.test(timestamp) || !Number.isSafeInteger(authoredAt) || parentShas.some((parent) => !objectId.test(parent))) invalid();
    commits.push({ sha, shortSha, subject, body, authorName, authorEmail, authoredAt, parentShas,
      filesChanged: Number(stats.match(/(\d+) files? changed/)?.[1]) || 0,
      additions: Number(stats.match(/(\d+) insertions?\(\+\)/)?.[1]) || 0,
      deletions: Number(stats.match(/(\d+) deletions?\(-\)/)?.[1]) || 0 });
  }
  return commits;
}
