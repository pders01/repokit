# Optional working-tree reads

`@jpahd/repository-core/workspace` is a direct-Node, read-only helper module for
**live mutable working trees**. It is deliberately separate from the package's
immutable repository reader and is not re-exported by the root entry point.
It requires Node 22+ and native Git. [MIT](../LICENSE).

```js
import {
  getWorkspaceStatus,
  captureWorkspaceDiffs,
  getWorkspaceFilePreview,
} from '@jpahd/repository-core/workspace';

// The caller selects and authorizes the repository root and requested paths.
const cwd = '/path/to/authorized/disposable-or-user-selected-repo';
const status = await getWorkspaceStatus(cwd);
const diffs = await captureWorkspaceDiffs(cwd, 'src/example.ts');
const preview = await getWorkspaceFilePreview(cwd, 'src/example.ts');
```

## Neutral API

Use the repository root as `cwd` so Git's reported paths and helper-relative
paths agree. These functions do not discover an application workspace or grant
permission to inspect one.

- `getWorkspaceStatus(cwd): Promise<WorkspaceStatus>` returns `isGit`, `branch`,
  optional `head`, and `files`. A nonzero status-command exit returns
  `{ isGit: false, branch: '', files: [] }`; this is not a diagnostic distinction
  between all Git failures. An unborn branch has no `head`; an empty branch name
  is reported as `detached`. Timeouts and metadata overflow throw.
- `WorkspaceFile` has `path`, optional `fromPath`, porcelain `status`, `bucket`,
  and optional `additions`/`deletions`. A partially staged file produces separate
  staged and unstaged rows; an unmerged file produces one conflicted row. Binary
  numstat markers do not become invented numeric line counts. Failed secondary
  numstat commands leave counts absent.
- `ChangeBucket` is `'staged' | 'unstaged' | 'untracked' | 'conflicted'`.
- `getWorkspaceDiff(cwd, path, bucket)` returns `{ rawDiff, truncated }`. Staged
  reads compare the index, unstaged reads compare the working tree, conflicts
  use Git's normal conflict diff, and untracked reads use `git diff --no-index`
  against `/dev/null` (exit 1 means a successful difference). Git binary patches
  are retained. External diff and textconv are disabled. A rename selected only
  by its destination returns the destination/addition view, not a
  promise to return a full two-path rename patch.
- `captureWorkspaceDiffs(cwd, path): Promise<WorkspaceCapturedDiff[]>` first reads
  status and captures each matching row. An unchanged/missing status path returns
  `[]`. The exported minimal structure is:

  ```ts
  interface WorkspaceCapturedDiff {
    path: string;
    bucket: ChangeBucket;
    rawDiff: string;
    truncated: boolean;
  }
  ```

  It has no session, tool, artifact, timestamp, authorization or Pi identity.
- `listWorkspaceDirectory(cwd, path): Promise<WorkspaceTreeEntry[]>` returns
  `{ name, type: 'file' | 'directory' | 'symlink', size }`, directories first,
  then locale-sorted names (code-unit tie-break for equal collation). Within the
  scan budget, it returns the first **500** sorted entries, without continuation
  or a truncation flag. `size` is `lstat` metadata, including for symlinks.
  `''`/`'.'` means the root. Listings omit real directories named `.git`,
  `.pi-webui`, and `node_modules`. **The `.pi-webui` exclusion is only a
  compatibility listing filter, not a protected data store or access policy.**
  Direct reads and Git status/diffs do not apply that filter.
- `getWorkspaceFilePreview(cwd, path): Promise<WorkspaceFilePreview>` returns
  `{ path, content, size, binary, truncated, language? }`. `path` is relative;
  `language` is only the lowercased extension. NUL or invalid UTF-8 yields
  `binary: true` and empty content. A cut UTF-8 suffix in a truncated preview is
  omitted, not replaced or classified as binary. `size` is stat-time size.
- `parsePorcelain(raw)` and `parseNumstat(raw)` expose NUL-delimited
  porcelain-v1/numstat parsers. They are convenience parsers for Git output, not
  strict validators of hostile arbitrary metadata.

Diff paths are nonempty relative paths. Capture and preview also accept absolute
paths lexically inside `cwd`. Directory paths must be relative. NUL and lexical
escapes outside the selected root are rejected. Git selection uses global
`--literal-pathspecs`, not merely `--`: glob characters and `:(...)` in filenames
cannot select sibling files. This does not prohibit explicitly selected directory
paths from yielding multi-file diffs.

## Bounds and limitations

- Diff subprocess stdout is collected up to **2 MiB + 1 byte** and clipped to
  **2 MiB**, with `truncated: true` when clipped. It is decoded text, not an exact
  byte-preserving patch transport: UTF-8 replacement at invalid/cut boundaries
  can affect re-encoded length. A truncated patch need not be applicable.
- Previews read at most **256 KiB + 1 byte**, returning at most **256 KiB** of
  source bytes before text decoding. Truncation uses the preceding stat size;
  concurrent changes can make that metadata stale.
- Shared `./git.js` caps each metadata command at **8 MiB**, stderr at **64 KiB**,
  and each Git command at **10 seconds**. Metadata stdout overflow throws rather
  than exposing a partial inventory. These are per-command bounds, not a total
  workspace-operation memory, duration or repository-computation guarantee.
- Directory enumeration uses `opendir` with a **5,000-entry scan budget**,
  counting **all entries**, including excluded directories. It observes at most
  one additional entry to detect exhaustion, then throws
  `Workspace directory scan limit exceeded (5000 entries)` and closes the
  iterator. **Overflow is an explicit refusal, not a successful partial list**;
  no result metadata reads start before enumeration completes within budget.
  `opendir` uses a 32-entry buffer; Node/OS directory buffering may read ahead.
- Within that budget, visible names/types are sorted before selecting the first
  **500**. Only those selected entries receive explicit `lstat` calls, at most
  **8 concurrently** per call. Each batch settles before an error propagates;
  no later batch starts on metadata failure. These caps bound application-level
  enumeration and metadata work, not total process memory, filesystem/OS work,
  concurrent callers or operation duration.
- Listing/preview perform lexical and realpath containment checks. They do not
  hold a stable descriptor-relative chain across resolution/stat/open. The
  listing iterator's directory handle does not make the later path-based `lstat`
  calls race-free. Ancestor replacement, symlink swaps and other TOCTOU races
  remain; resource caps are not filesystem confinement or a sandbox. Diff
  selection has lexical containment only and does not use the browsing realpath
  check. Git handles its own index/worktree/path semantics.
- Status, numstats, captures, stat and file reads are separate live operations.
  There is no snapshot, atomic capture, immutable source identity, consistency
  guarantee, or mutation lock. Files may change/disappear between operations.
  Directory caps likewise do **not** create a consistent filesystem snapshot:
  enumeration types/order and later metadata may reflect different moments.
- The `/dev/null` untracked-diff implementation (and the shared Git
  helper's null config paths) assumes a POSIX-like environment. Windows/native
  platform parity is not established.
- These helpers offer **no OS sandbox, authorization, secret filtering or
  hostile-repository containment**. The caller owns trust, path selection,
  permissions and presentation. Native Git still reads repository metadata;
  bounded output does not bound all Git algorithms or filesystem work.

See the package [build commands](../README.md#build-and-verify) to build and test
this entry.
