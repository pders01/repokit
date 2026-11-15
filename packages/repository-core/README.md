# @jpahd/repository-core

Private/unpublished ESM for read-only native-Git repository features. Requires
Node **22+** and native `git` on PATH. No runtime npm dependencies. [MIT](LICENSE).

## Build and verify

From this package directory, with workspace dependencies installed:

```sh
npm run build
npm run check
npm test
```

Build before testing. Emitted code uses ordinary ESM and declarations; TypeScript
consumers need Node type declarations. See [workspace commands](../../README.md#build-and-verify).

## Named exports

- `@jpahd/repository-core`: neutral structural types and `getRepositoryInfo`,
  `listRepositoryRefs`, `listRepositoryTree`, `getRepositoryFile`,
  `searchRepositoryFiles`, `listRepositoryCommits`, `getRepositoryDiff`,
  `compareRepositoryRefs`, `getRepositoryBlame`, `listKnowledgeDocuments`.
- `@jpahd/repository-core/git`: `runGit`, `withGitBudget`, `assertGitBudget`,
  and the `GitResult` type. Annotation and repository consumers share this one
  runner and its async-local budget.
- `@jpahd/repository-core/bounded-stream`: `readBoundedStream`, accepting Node
  async-iterable streams or Web streams, and `BoundedStreamResult`.
- `@jpahd/repository-core/text-preview`: `decodeTextPreview`.
- `@jpahd/repository-core/repository-log`: `parseRepositoryLog` and
  `REPOSITORY_LOG_FORMAT`.

Root exports additionally include pure `describeKnowledgeDocument`,
`parseRepositoryBlame`, and `repositoryPath` helpers for thin host wrappers.
Types are structural, not tied to an RPC implementation.

```js
import { getRepositoryFile, searchRepositoryFiles } from '@jpahd/repository-core';
import { withGitBudget } from '@jpahd/repository-core/git';

const file = await withGitBudget(async () => {
  const result = await searchRepositoryFiles(selectedRoot, 'README', selectedRef);
  if (!result.paths.length) return undefined;
  return getRepositoryFile(selectedRoot, result.paths[0], result.ref);
});
```

## Identity and host boundary

Repository content reads resolve a commit before reading objects. Search/file
results identify the pinned commit; comparison returns resolved base/head IDs.
Blame defaults to **HEAD**, never mutable working-tree contents. Markdown
sources are regular `.md`/`.mdx` blobs in one pinned commit, with commit and blob
identity and `modified: false`; index renames, deleted files, symlinks and local
edits cannot change those sources. Discovery does not skip a failed object read
and publish a success for the rest. Info/ref inventory inherently describes the
repository at the time of each inventory read, not a transaction across calls.

The optional `@jpahd/repository-core/workspace` entry preserves bounded mutable
working-tree status, directory/file previews and staged/unstaged/untracked diffs.
See [workspace reads and limitations](docs/workspace.md). It is separate from
immutable snapshot APIs: live files are not a consistent Git snapshot. Blame and
Markdown discovery use the immutable APIs, not working-tree projections. Consumers
select and authorize a repository themselves; this package neither discovers
application workspaces nor grants writer authority.

## Bounds and refusals

- Git stdout defaults to **8 MiB**, stderr to **64 KiB**. Explicit stdout limits
  are retained for file/diff previews and small ref resolution. Streams are
  drained while retaining bounded bytes; invalid numeric limits refuse.
- Each child has a **10 s** deadline, shortened by the active work budget.
  Deadline expiry kills/awaits the exact owned child and closes its pipes.
  `withGitBudget` defaults to **20 s / 4096 commands**, with latched exhaustion
  even when callers catch command errors. `assertGitBudget` covers cached work.
- Ambient `GIT_*` settings are scrubbed. Global/system Git configuration,
  replacement objects, optional locks, lazy fetch and interactive prompts are
  disabled. Repository-local configuration is not a security sandbox.
- Text previews retain **512 KiB**; diffs **2 MiB**. Invalid complete UTF-8,
  malformed interiors and NUL content are not represented as decoded text.
  A truncated UTF-8 suffix is omitted without inventing replacement characters.
- Tree/compare arrays retain up to **2000 entries**; Markdown discovery up to
  **250 regular documents**. These array limits do not expose a
  continuation/completeness flag. Do not advertise exhaustive inventory.
- Search ranks regular files: **100 results**,
  **2 MiB listing**, **50,000 scanned entries**, distinct `truncated` and
  `incomplete` flags, and refusal/skipping of unsafe or unrepresentable paths.
- History/diff reads refuse shallow repositories rather than asserting false
  roots/exhaustion. Complete log metadata uses NUL framing and strict UTF-8;
  oversized metadata refuses instead of publishing a partial parsed result.

These are output/lifetime controls, not bounds on native Git's internal memory,
CPU, hostile local configuration or all descendant processes. The low-level Git
runner is not a read-only command allowlist; callers own command selection.
High-level APIs are read-only; they do not provide staging, worktree management
or remote operations. Filesystem behavior assumes a POSIX-like environment;
Windows portability is not guaranteed.
