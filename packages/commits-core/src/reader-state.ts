import {
  fullCommit, readingLocation, READER_LIMITS, RepositoryReadError,
  type CommitEntry, type CommitDiff, type CommitsLocation, type CommitsProvider,
  type ReadResult, type ReadingRef, type ReadingScope, type Revision,
} from "./contracts.js";

export interface ReaderSnapshot {
  readonly scope?: ReadingScope;
  readonly location?: CommitsLocation;
  readonly revision?: Revision;
  readonly refs: readonly ReadingRef[];
  readonly commits: readonly CommitEntry[];
  readonly selected?: CommitEntry;
  readonly diff?: CommitDiff;
  readonly loading: boolean;
  readonly detailLoading: boolean;
  readonly hasMore: boolean;
  readonly limitNotice: string;
  readonly error: string;
  readonly detailError: string;
  readonly reloadRequired: boolean;
}
interface Operation {
  provider: CommitsProvider;
  scope: ReadingScope;
  location: CommitsLocation;
  controller: AbortController;
}
const empty = (): ReaderSnapshot => ({ refs: [], commits: [], loading: false,
  detailLoading: false, hasMore: false, limitNotice: "", error: "", detailError: "", reloadRequired: false });
class InvalidRead extends Error {}
class ReadTimeout extends Error {}
const invalid = (): never => { throw new InvalidRead(); };
const text = (value: unknown, max = 16_384): value is string =>
  typeof value === "string" && value.length <= max;
function commitCopy(commit: CommitEntry): CommitEntry {
  if (!commit || !text(commit.sha) || !text(commit.message) || !text(commit.body, 65_536) ||
      !text(commit.shortSha, 64) || !text(commit.authorName) || !text(commit.authorEmail) ||
      typeof commit.authorTime !== "bigint" || commit.authorTime < 0n || commit.authorTime > 8_640_000_000_000n ||
      !Array.isArray(commit.parentShas) || commit.parentShas.length > 64 ||
      ![commit.additions, commit.deletions, commit.filesChanged].every((n) => Number.isSafeInteger(n) && n >= 0)) invalid();
  fullCommit(commit.sha);
  commit.parentShas.forEach(fullCommit);
  return Object.freeze({ ...commit, parentShas: Object.freeze([...commit.parentShas]) as unknown as string[] });
}
function failure(error: unknown): string {
  if (error instanceof RepositoryReadError && error.code === "incompatible")
    return "This connection does not support bounded repository reads. Restart or update the server, then reload this page. No repository read was sent.";
  if (error instanceof ReadTimeout || (error instanceof RepositoryReadError && error.code === "timeout")) return "Read timed out. Retry explicitly.";
  if (error instanceof InvalidRead) return "Invalid or out-of-scope reading response. Retry explicitly.";
  // Backend messages may contain credentials/absolute paths. Hosts can log safely elsewhere.
  return "Unable to read this repository. Check access and availability, then Retry.";
}

/** Instance-local finite reads. No router, DOM, sessions, shared cache, or retries. */
export class CommitsReaderState {
  snapshot: ReaderSnapshot = Object.freeze(empty());
  private provider?: CommitsProvider;
  private location?: CommitsLocation;
  private pinned?: Revision;
  private history?: Operation;
  private detail?: Operation;
  private attached = true;
  private interrupted = false;

  constructor(private readonly changed: () => void, private readonly timeoutMs: number = READER_LIMITS.requestMs) {}

  isBoundTo(provider: CommitsProvider | undefined): boolean { return this.provider === provider; }

  private publish(patch: Partial<ReaderSnapshot>): void {
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch });
    this.changed();
  }
  private cancelHistory(): void {
    this.history?.controller.abort();
    this.detail?.controller.abort();
    this.history = this.detail = undefined;
  }
  detach(): void {
    this.interrupted = this.snapshot.loading || this.snapshot.detailLoading;
    this.attached = false;
    this.cancelHistory();
  }
  attach(): void { this.attached = true; }

  configure(provider: CommitsProvider | undefined, input: CommitsLocation | undefined): void {
    let location: CommitsLocation | undefined;
    try {
      // An omitted location keeps this binding's provider-chosen default, including on reconnect.
      location = input ? readingLocation(input) : provider === this.provider ? this.location : undefined;
      if (provider && (!provider.scope || !text(provider.scope.key, 256) || !provider.scope.key ||
          !text(provider.scope.repositoryKey, 256) || !provider.scope.repositoryKey ||
          !text(provider.scope.label, 1024) || !provider.scope.label ||
          (provider.scope.worktreeKey !== undefined && !text(provider.scope.worktreeKey, 256)))) invalid();
    } catch {
      this.cancelHistory();
      this.provider = undefined;
      this.location = undefined;
      this.pinned = undefined;
      this.snapshot = Object.freeze({ ...empty(), error: "Invalid reading binding or location." });
      this.changed();
      return;
    }
    const previous = this.location;
    const providerChanged = provider !== this.provider;
    const anchorChanged = previous?.anchor !== location?.anchor;
    // Only a defined echo of the effective pin is exempt. Removing an anchor is
    // a new symbolic lookup even while its old exact lookup has no revision yet.
    const listChanged = providerChanged || previous?.ref !== location?.ref || previous?.path !== location?.path ||
      (anchorChanged && (location?.anchor === undefined || location.anchor !== this.snapshot.revision?.commit));
    if (providerChanged || previous?.ref !== location?.ref ||
        (anchorChanged && (location?.anchor === undefined || location.anchor !== this.pinned?.commit)))
      this.pinned = undefined;
    this.provider = provider;
    this.location = location;
    if (!this.attached) { this.interrupted = true; return; }
    if (!provider) {
      this.cancelHistory();
      this.snapshot = Object.freeze(empty());
      this.changed();
      return;
    }
    if (listChanged || this.interrupted || !this.snapshot.scope) {
      this.interrupted = false;
      this.cancelHistory();
      this.snapshot = Object.freeze({ ...empty(), scope: Object.freeze({ ...provider.scope }), location });
      this.changed();
      void this.load();
    } else {
      this.publish({ location });
      if (previous?.commit !== location?.commit) void this.loadDetail(location?.commit);
    }
  }

  private operation(): Operation {
    const provider = this.provider!;
    return { provider, scope: this.snapshot.scope!,
      location: this.location ?? Object.freeze({ ref: "" }), controller: new AbortController() };
  }
  private alive(op: Operation): boolean {
    return this.attached && this.provider === op.provider && !op.controller.signal.aborted;
  }
  private ensure(op: Operation, slot: "history" | "detail"): void {
    if (!this.alive(op) || this[slot] !== op) throw new DOMException("Superseded", "AbortError");
  }
  private async read<T>(op: Operation, call: (signal: AbortSignal) => Promise<ReadResult<T>>): Promise<T> {
    const signal = op.controller.signal;
    signal.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => {};
    try {
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => op.controller.abort(new ReadTimeout()), this.timeoutMs);
      });
      const result = await Promise.race([call(signal), aborted]);
      signal.throwIfAborted();
      if (!this.alive(op)) throw new DOMException("Superseded", "AbortError");
      if (!result || result.scopeKey !== op.scope.key ||
          op.provider.scope.key !== op.scope.key || op.provider.scope.repositoryKey !== op.scope.repositoryKey ||
          op.provider.scope.worktreeKey !== op.scope.worktreeKey) invalid();
      return result.value;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async load(): Promise<void> {
    if (!this.provider || !this.attached) return;
    const op = this.operation();
    const pinned = this.pinned;
    this.history = op;
    this.publish({ loading: true, error: "", reloadRequired: false, detailError: "", selected: undefined, diff: undefined,
      detailLoading: false, commits: [], revision: undefined, hasMore: false, limitNotice: "" });
    try {
      const refs = await this.read(op, (signal) => op.provider.listRefs(signal));
      this.ensure(op, "history");
      if (!Array.isArray(refs) || refs.length > READER_LIMITS.refs) invalid();
      const selectors = new Set<string>();
      const copiedRefs = Object.freeze(refs.map((ref) => {
        if (!ref || !text(ref.name, 1024) || !text(ref.selector, 1024) || !ref.selector ||
            !["branch", "tag"].includes(ref.kind) || selectors.has(ref.selector)) invalid();
        selectors.add(ref.selector);
        return Object.freeze({ ...ref });
      }));
      let location = op.location;
      if (!location.ref) {
        const description = await this.read(op, (signal) => op.provider.describe(signal));
        this.ensure(op, "history");
        location = readingLocation({ ref: description.initialRef });
      }
      let revision: Revision;
      if (location.anchor) {
        const commit = commitCopy(await this.read(op, (signal) => op.provider.commit(location.anchor!, signal)));
        this.ensure(op, "history");
        if (commit.sha !== location.anchor) invalid();
        revision = Object.freeze({ requestedRef: location.ref, commit: commit.sha });
      } else if (pinned?.requestedRef === location.ref) {
        revision = pinned;
      } else {
        const resolved = await this.read(op, (signal) => op.provider.resolve(location.ref, signal));
        this.ensure(op, "history");
        if (!resolved || resolved.requestedRef !== location.ref) invalid();
        revision = Object.freeze({ requestedRef: location.ref, commit: fullCommit(resolved.commit) });
      }
      this.pinned = revision;
      this.publish({ revision });
      const page = await this.readPage(op, revision, location.path, 0);
      this.ensure(op, "history");
      // A commit-only route change during loading must not be overwritten by this older query.
      this.location ??= location;
      this.publish({ refs: copiedRefs, location: this.location, revision, commits: page.commits, hasMore: page.hasMore, loading: false });
      this.ensure(op, "history");
      if (this.location.commit && !this.detail) void this.loadDetail(this.location.commit);
    } catch (error) {
      if (this.history === op && this.attached && this.provider === op.provider)
        this.publish({ loading: false, error: failure(error),
          reloadRequired: error instanceof RepositoryReadError && error.code === "incompatible" });
    }
  }

  private async readPage(op: Operation, revision: Revision, path: string | undefined, offset: number) {
    const limit = Math.min(READER_LIMITS.page, READER_LIMITS.loadedRows - offset);
    const result = await this.read(op, (signal) => op.provider.list(Object.freeze({ revision, path,
      limit, offset }), signal));
    this.ensure(op, "history");
    if (!result || !Array.isArray(result.commits) || result.commits.length > limit ||
        typeof result.hasMore !== "boolean" || (result.hasMore && !result.commits.length)) invalid();
    const commits = Object.freeze(result.commits.map(commitCopy));
    if (new Set(commits.map((commit) => commit.sha)).size !== commits.length) invalid();
    return { commits, hasMore: result.hasMore };
  }

  async more(): Promise<void> {
    const { revision, commits, hasMore, loading } = this.snapshot;
    if (!this.provider || !revision || !hasMore || loading || !this.attached || this.snapshot.reloadRequired) return;
    const offset = commits.length;
    if (offset >= READER_LIMITS.loadedRows || offset > READER_LIMITS.offset) {
      this.publish({ hasMore: false, limitNotice: "Reader row/offset limit reached; this is not the entire history." });
      return;
    }
    this.history?.controller.abort();
    const op = this.operation();
    this.history = op;
    this.publish({ loading: true, error: "", reloadRequired: false });
    try {
      const page = await this.readPage(op, revision, op.location.path, offset);
      this.ensure(op, "history");
      const ids = new Set(commits.map((commit) => commit.sha));
      if (page.commits.some((commit) => ids.has(commit.sha))) invalid();
      const rows = Object.freeze([...commits, ...page.commits]);
      const limited = page.hasMore && rows.length >= READER_LIMITS.loadedRows;
      this.publish({ commits: rows, hasMore: page.hasMore && !limited, loading: false,
        limitNotice: limited ? "Reader row limit reached; this is not the entire history." : "" });
    } catch (error) {
      if (this.history === op && this.attached && this.provider === op.provider)
        this.publish({ loading: false, error: failure(error),
          reloadRequired: error instanceof RepositoryReadError && error.code === "incompatible" });
    }
  }

  private async loadDetail(sha?: string): Promise<void> {
    this.detail?.controller.abort();
    this.detail = undefined;
    this.publish({ selected: undefined, diff: undefined, detailError: "", detailLoading: false });
    if (!sha || !this.provider || !this.attached) return;
    const op = this.operation();
    this.detail = op;
    this.publish({ detailLoading: true });
    try {
      // Exact lookup deliberately carries no path filter, even outside loaded ancestry.
      const selected = commitCopy(await this.read(op, (signal) => op.provider.commit(sha, signal)));
      this.ensure(op, "detail");
      if (selected.sha !== sha) invalid();
      this.publish({ selected });
      this.ensure(op, "detail");
      const diff = await this.read(op, (signal) => op.provider.diff(Object.freeze({ commit: sha,
        path: op.location.path, base: "first-parent" }), signal));
      this.ensure(op, "detail");
      if (!diff || diff.toCommit !== sha || !diff.base ||
          (selected.parentShas.length ? diff.base.kind !== "commit" || diff.base.commit !== selected.parentShas[0]
            : diff.base.kind !== "empty-tree") ||
          !text(diff.rawDiff, READER_LIMITS.patchBytes) || new TextEncoder().encode(diff.rawDiff).length > READER_LIMITS.patchBytes ||
          !diff.completeness || !["complete", "partial", "unknown"].includes(diff.completeness.kind) ||
          (diff.completeness.kind === "partial" && !text(diff.completeness.reason, 1024)) ||
          (diff.empty !== undefined && typeof diff.empty !== "boolean") ||
          (diff.empty === true && (diff.rawDiff !== "" || (diff.files?.length ?? 0) > 0))) invalid();
      if (diff.files !== undefined && (!Array.isArray(diff.files) || diff.files.length > 2_000)) invalid();
      const files = diff.files?.map((file) => {
        if (!file || !text(file.path, 4096) || !text(file.fromPath, 4096) || !text(file.status, 128) ||
            ![file.additions, file.deletions].every((n) => Number.isSafeInteger(n) && n >= 0)) invalid();
        return Object.freeze({ ...file });
      });
      this.publish({ diff: Object.freeze({ ...diff, base: Object.freeze({ ...diff.base }),
        completeness: Object.freeze({ ...diff.completeness }), files: files && Object.freeze(files) }), detailLoading: false });
    } catch (error) {
      if (this.detail === op && this.attached && this.provider === op.provider)
        this.publish({ detailLoading: false, detailError: failure(error),
          reloadRequired: error instanceof RepositoryReadError && error.code === "incompatible" });
    }
  }

  /** Explicit retries only. Refresh alone intentionally discards the saved anchor. */
  retry(): void { if (this.snapshot.reloadRequired) return; this.cancelHistory(); void this.load(); }
  retryDetail(): void { if (!this.snapshot.reloadRequired) void this.loadDetail(this.location?.commit); }
  refresh(): void {
    if (!this.location || !this.provider || this.snapshot.reloadRequired) return;
    this.cancelHistory();
    this.location = readingLocation({ ...this.location, anchor: undefined });
    this.pinned = undefined;
    void this.load();
  }
}
