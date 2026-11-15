import { runGit } from "./git.js";

/** Resolve once to an immutable commit; never pass unchecked output as a tree-ish. */
export async function resolveCommit(cwd: string, ref: string | undefined): Promise<string> {
  if (ref !== undefined && (
    typeof ref !== "string" ||
    ref.length === 0 ||
    ref.length > 1_024 ||
    ref.trim() !== ref ||
    ref.startsWith("-") ||
    ref === "WORKTREE" ||
    /[\u0000-\u001f\u007f]/.test(ref)
  )) throw new Error("Invalid repository ref");
  const result = await runGit(cwd, [
    "rev-parse", "--verify", "--end-of-options", `${ref ?? "HEAD"}^{commit}`,
  ], 256);
  if (result.timedOut) throw new Error("Git command timed out");
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "git rev-parse failed");
  const commit = result.stdout.trim();
  if (result.stdoutTruncated || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit)) {
    throw new Error("Could not resolve repository ref to a commit");
  }
  return commit;
}
