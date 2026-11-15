import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { readBoundedStream } from "./bounded-stream.js";

const MAX_STDERR_BYTES = 64 * 1024;
const GIT_DEADLINE_MS = 10_000;
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const budgets = new AsyncLocalStorage<{ deadline: number; remaining: number; exceeded: boolean }>();

/** Bound aggregate Git work, including loops that reuse cached objects. */
export async function withGitBudget<T>(operation: () => Promise<T>, limits = { timeoutMs: 20_000, commands: 4096 }): Promise<T> {
  if (!Number.isFinite(limits.timeoutMs) || limits.timeoutMs < 0 || !Number.isSafeInteger(limits.commands) || limits.commands < 0) {
    throw new RangeError("Invalid Git work budget");
  }
  const budget = { deadline: performance.now() + limits.timeoutMs, remaining: limits.commands, exceeded: false };
  return budgets.run(budget, async () => {
    const result = await operation();
    // A conservative resolver may catch subprocess errors; never publish its
    // fallback placements when resolution actually exhausted the work budget.
    assertGitBudget();
    return result;
  });
}

export function assertGitBudget(): void {
  const budget = budgets.getStore();
  if (budget && (budget.exceeded || performance.now() >= budget.deadline)) {
    budget.exceeded = true;
    // Keep the existing host-visible diagnostic for annotation consumers.
    throw new Error("Annotation Git work budget exceeded");
  }
}

export interface GitResult {
  bytes: Uint8Array;
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  truncated: boolean;
  timedOut: boolean;
}

/**
 * Execute native Git with bounded output, a deadline and isolated Git environment.
 * Callers must choose read-only commands; this low-level helper is not a command
 * allowlist or a security sandbox. Replacement objects and lazy fetch are off.
 */
export async function runGit(cwd: string, args: string[], maximumStdoutBytes?: number): Promise<GitResult> {
  const maximumBytes = maximumStdoutBytes ?? MAX_METADATA_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new RangeError("Invalid Git stdout byte limit");
  assertGitBudget();
  const budget = budgets.getStore();
  if (budget && --budget.remaining < 0) {
    budget.exceeded = true;
    throw new Error("Annotation Git work budget exceeded");
  }
  const deadlineMs = Math.min(GIT_DEADLINE_MS, budget ? Math.max(1, budget.deadline - performance.now()) : GIT_DEADLINE_MS);
  const child = spawn("git", ["--no-replace-objects", "-c", "core.quotepath=false", "--no-pager", ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: isolatedGitEnvironment(),
    windowsHide: true,
  });
  let spawnError: Error | undefined;
  child.once("error", (error) => { spawnError = error; });
  // close, unlike exit, includes closure of both output pipes.
  const closed = new Promise<number>((resolve) => child.once("close", (code) => resolve(code ?? 1)));
  let timedOut = false;
  async function* output(stream: AsyncIterable<Uint8Array>) {
    try { yield* stream; }
    catch (error) { if (!timedOut) throw error; }
  }
  const stdoutPromise = readBoundedStream(output(child.stdout), maximumBytes);
  const stderrPromise = readBoundedStream(output(child.stderr), MAX_STDERR_BYTES);
  const timer = setTimeout(() => {
    timedOut = true;
    if (budget && (deadlineMs < GIT_DEADLINE_MS || performance.now() >= budget.deadline)) budget.exceeded = true;
    child.kill("SIGKILL");
    // Do not let an inherited pipe keep this read alive after its deadline.
    // Already-retained bytes remain available through the collectors above.
    child.stdout.destroy();
    child.stderr.destroy();
  }, deadlineMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([stdoutPromise, stderrPromise, closed]);
    if (spawnError) throw spawnError;
    return {
      bytes: stdout.bytes,
      stdout: new TextDecoder().decode(stdout.bytes),
      stderr: new TextDecoder().decode(stderr.bytes),
      exitCode,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      truncated: stdout.truncated || stderr.truncated,
      timedOut,
    };
  } catch (error) {
    child.kill("SIGKILL");
    child.stdout.destroy();
    child.stderr.destroy();
    await Promise.allSettled([stdoutPromise, stderrPromise, closed]);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function isolatedGitEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("GIT_")) environment[key] = value;
  }
  return {
    ...environment,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    LC_ALL: "C",
  };
}
