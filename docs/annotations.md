# Private source annotations

Private source annotations are small, portable records attached to immutable Git
source. They are intended for explanations, invariants, review notes, and questions.
They are data, not instructions. Bodies may contain Markdown; clients must treat
that content as untrusted data. The Chatworks annotation panel renders escaped
plain text rather than interpreting HTML or links.

This format is versioned. It is **not W3C Web Annotation or SARIF compliant**.

## Reading and selecting source

The browser source/annotation panel is `@jpahd/chatworks/source-annotations`.
Other clients can use the same service without a browser. Virtual note rows are presentation, never inserted source. Every client
must distinguish original immutable anchors from derived placement and must not
silently treat stale/unplaced coordinates as current source locations.

## Portable document schema

`export` writes exactly one JSON document. This example illustrates its shape;
the commit/blob IDs are placeholders, so it is not an importable fixture:

```json
{
  "schemaVersion": 1,
  "repository": {
    "id": "8d8a3dc4-0e93-4c65-9e9e-f3d9f137b493"
  },
  "annotations": [
    {
      "id": "b6c9e4a3-2a0c-4c4f-8d34-0b1ef3e9cc20",
      "repositoryId": "8d8a3dc4-0e93-4c65-9e9e-f3d9f137b493",
      "revision": 1,
      "createdAt": "2026-01-15T12:00:00.000Z",
      "updatedAt": "2026-01-15T12:00:00.000Z",
      "author": {
        "kind": "agent",
        "name": "local-agent",
        "sessionId": "session-42",
        "model": "example-model"
      },
      "body": "This converts the persisted value before the request boundary.",
      "category": "explanation",
      "state": "open",
      "target": {
        "kind": "git",
        "commit": "0123456789012345678901234567890123456789",
        "blob": "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
        "path": "src/adapter.ts",
        "startLine": 12,
        "endLine": 13,
        "quote": {
          "exact": "const value = parse(input);\nreturn send(value);",
          "prefix": "export function adapt(input: string) {",
          "suffix": "}"
        },
        "fingerprint": "22fb8058846bc5da7a482cf3bc65c7da7993c8d24157054b1629d5af47e97b10",
        "whitespace": "exact"
      }
    }
  ]
}
```

The schema is:

- `schemaVersion` is the number `1`.
- `repository.id` is the portable logical repository UUID. Every annotation's
  `repositoryId` must equal it. A new local store allocates its UUID on first write.
  Before that, lists return an ephemeral `namespace-…` ID; an empty export uses a
  fresh UUID without creating storage. Empty exports therefore need not have a
  stable ID. Neither form should be used to infer a remote repository identity.
- `id` is an annotation UUID. `revision` starts at `1` and increases for every
  update. `createdAt` and `updatedAt` are ISO timestamps.
- `author.kind` is `human` or `agent`; `name` is required. `sessionId` and `model`
  are optional labels. They are attribution supplied by the caller, not identity
  authentication, model attestation, or proof of who generated the record.
- `body` is required prose or code documentation. Explanations are first-class:
  they can say what code does, why it exists, and how data flows; an annotation does
  not need to be a finding. `category` is `explanation`, `invariant`, `review`, or
  `question`, and defaults to `explanation`. `state` is `open` or `resolved`.
- `target.kind` is `git`. `commit` and `blob` identify the immutable original
  commit and blob. `path` is repository-relative, with `/` separators. `startLine`
  and `endLine` are 1-based and inclusive.
- `quote.exact` is the selected line text joined with `\n`; `prefix` and `suffix`
  provide nearby context. The implementation records up to three surrounding lines
  when available. `fingerprint` is a SHA-256 text anchor. `whitespace` is `exact` or
  `trim-line-end`.

A record contains no absolute checkout path, private storage path, hostname, or
machine-specific location. `path` is the portable repository-relative path only.

## Line and whitespace rules

Line numbers start at **1**, not 0, and both ends of a range are included. A range
must be ordered and must exist in the selected immutable Git blob. The original
annotation target is never rewritten when a branch changes, a file is renamed, or
text is edited.

`exact` is the default. It preserves meaningful indentation, spaces, tabs, and
internal whitespace. `trim-line-end` is an explicit opt-in: for matching and the
fingerprint it removes only trailing spaces and tabs from each selected line. It
does not strip leading indentation, collapse whitespace, normalize internal spaces,
or make a semantic-validity claim. Newline characters are line separators rather
than selected line content. A changed original quote can therefore be `stale` even
when it looks similar.

When listing at another commit, the service computes a derived placement and does
not change the original record:

- `unchanged`: the same path and range still match;
- `moved`: the anchor matches at a different line or after a tracked rename;
- `stale`: the file exists but the text anchor no longer matches;
- `unplaced`: the original object/path is unavailable, the file was deleted, or the
  anchor is ambiguous.

Ambiguous matches are never silently relocated. Exact original snapshots retain
original coordinates even for repeated text; changed repeated blocks require
unambiguous context in both the original and current snapshots, in addition to
diff projection. Code-block moves overlapping
diff hunks are conservatively unplaced rather than guessed. Tracked renames can
also be followed in the working tree; an untracked rename may remain unplaced.
These statuses describe anchoring,
not whether the prose remains semantically correct. `WORKTREE` is an ephemeral
listing projection and is never accepted as the immutable original `target.commit`.

## CLI

After `npm ci && npm run build`, the source-checkout invocation is:

```sh
node packages/source-annotations/dist/bin.js --cwd /repo --data-dir /private/base list
```

`--cwd` defaults to the current directory. `--data-dir` selects the private base and
otherwise `PI_WEBUI_ANNOTATIONS_DIR` is used by the service. If neither is set,
the default is `~/.local/share/pi-webui/annotations`. This historical name is a
storage compatibility contract, not an application dependency. The data directory
must be outside every checkout and every `.git` ancestry. Tests and experiments
must select a disposable private base explicitly, never use a live store.

Commands and flags:

```text
list    [--ref <ref>] [--path <repo-relative-path>] [--include-resolved]
create  [--author-kind human|agent] [--author-name <name>]
        [--session-id <label>] [--model <label>]
update  [--id <uuid>] [--expected-revision <positive-integer>]
delete  [--id <uuid>] [--expected-revision <positive-integer>]
export
import
```

All commands also accept `--cwd <path>`, `--data-dir <path>`, and `--help`.
`list` uses `HEAD` by default; pass `--ref WORKTREE` for an ephemeral working-tree
projection. `--include-resolved` is required to include resolved records. `--path`
is a repository-relative filter.

Mutation input is one bounded JSON object on stdin. `create` accepts the
`AnnotationCreate` fields (`ref`, `path`, `startLine`, `endLine`, `body`, optional
`category`, and optional `whitespace`). Its `ref` must identify an immutable commit;
creation on `WORKTREE` is rejected. `update` accepts `id`, mandatory
`expectedRevision`, and one or more of `body`, `category`, or `state`. `delete`
accepts `id` and mandatory `expectedRevision`. The matching command-line options
may override those two fields. `import` reads an `AnnotationExport` document from
stdin. `export` writes it to stdout, so files are handled without a special file
flag:

```sh
node packages/source-annotations/dist/bin.js --cwd /repo --data-dir /private/base export > /private/annotations.json
node packages/source-annotations/dist/bin.js --cwd /other-repo --data-dir /private/other-base import < /private/annotations.json
```

Successful commands write one JSON result to stdout and no logs. Failures write one
JSON object such as `{"error":"Annotation revision conflict"}` to stderr and exit
nonzero. Unknown commands and flags are rejected. JSON stdin is bounded before a
mutation is attempted; malformed or oversized input has no storage side effect.
Ordinary mutation stdin is limited to 1 MiB; import stdin permits 17 MiB so its byte
limit accommodates a bounded service export (16 MiB JSON plus framing whitespace).
The store allows up to 1,000 records, 64 KiB UTF-8 per body, and 256 KiB per quote
field. Original source files must be complete regular UTF-8 text blobs no larger
than 512 KiB. Oversized or binary targets are rejected, not silently truncated.
Git invocations use argument vectors, not inferred shell command strings, and the
annotation service disables Git's lazy object fetching and replacement objects.
Inherited Git redirection variables are removed, so preview and anchor reads use
the requested repository and the actual objects named by their hashes.

Expensive annotation operations are serialized per service instance, with at most
eight active/queued requests and a ten-second queue-age limit. Git work has a
20-second aggregate budget and a 4,096-command ceiling; individual commands are
limited to ten seconds. Cached resolver loops also check the work budget, and
source/blob/patch caches retain at most eight entries each. Exhaustion fails the
operation explicitly rather than publishing partially verified placements. Large
imports may need smaller batches even when the document fits the byte limit.
These bounds are resource controls, not an operating-system sandbox.

A create caller can put an optional `author` object in its JSON input or provide the
CLI author flags. If omitted, the CLI records `{ "kind": "agent", "name":
"local-agent" }`. This is explicitly self-reported provenance, not an attestation.

Optimistic lifecycle checks are mandatory. Read the current `revision`, send that
exact value to `update` or `delete`, and retry only after re-reading and deciding
what the new write should mean. A stale revision is a conflict; it is not silently
merged.

## Storage, identity, and portability

The store is private application data rather than source data. It is kept outside
checkouts, in a per-repository namespace below the configured base. Linked worktrees
share identity because the namespace key is derived from Git's canonical
`--git-common-dir`, not from an individual checkout path. The first write creates a
local repository UUID; this UUID is portable metadata, while the CommonDir-derived
namespace is local storage identity.

Export/import is deliberately explicit. Import verifies every annotation's original
commit, blob, path, line range, quote, fingerprint, and whitespace policy against
Git before it writes anything. It remaps the imported record's `repositoryId` to the
receiving store's local repository UUID and rejects malformed documents, duplicate
IDs, anchor failures, and conflicting ID reuse. Accepted UUIDs, Git object IDs,
and fingerprints are canonicalized to lowercase; case variants cannot bypass
duplicate checks. The immutable commit/blob must be
available in the receiving repository; an export is not a promise that arbitrary
repositories can accept the record.

Each namespace contains one self-contained `annotations.json`, including the UUID
and records; there is no identity sidecar. Existing storage directories must have
mode `0700`, and files `0600`; the service does not silently chmod unrelated existing
directories. Writes use an exclusive `<namespace>.lock` directory and atomic
private temporary-file rename. Readers tolerate only recognized private
`annotations.json.<uuid>.tmp` files beside the committed document; they never use
temporaries as authoritative data. Unknown files inside a namespace, malformed
records, duplicate IDs, cross-repository records, and symlinks fail closed.

Readers briefly retry an active first-write initialization instead of mistaking
its unpublished document for lost data. A lock that remains busy is an explicit
retry/recovery error. After confirming all relevant writers are stopped,
a stale lock directory can be removed manually. Do not delete `annotations.json`
to clear a lock. If a namespace exists but its committed document is missing,
restore a known-good backup; an interrupted first initialization with no committed
data also requires explicit recovery. Removing the entire namespace is not
reliably distinguishable from a new installation, so backups are still essential.
No automatic orphan-temp promotion or data reconstruction is attempted.

Canonical roots are fixed on first access and later symlink replacements rejected.
No-follow final-file descriptors and bounded reads close simple redirection gaps;
this is not complete OS-level isolation against a same-user process racing ancestor
replacement. Filesystem policy failures remain visible and are not silently retried.

Privacy here means annotations are not ordinarily committed with project source.
It does not protect data from trusted host processes, administrator access, filesystem
snapshots, or machine backups. Use a manually controlled backup of the private data
base, made while writers are stopped; do not treat Git commits as an annotation
backup. Keep exported files private as they contain source quotes and prose.

## Clients, RPC and editor integrations

`@jpahd/source-annotations/contracts` exposes the neutral `AnnotationClient` interface;
the service supplies list/create/update/delete/export/import methods. A host binds
repository selection, authenticated author, request scope, read/write authority and
transport. A browser read-only property is presentation, not server authorization.
Private prose and source quotes must not be copied into ordinary audit logs.

Repokit does not provide an annotation RPC server. git-chat has no annotation RPCs;
a host implementing a bridge must bind its own authentication, request scope and
mutation policy. Using git-chat must not automatically upload or synchronize local
private notes.

A compatible Node editor host can call the service directly; other hosts can use
a CLI or an explicitly implemented RPC bridge. Neither editor plugin nor a new
persistent browser backend is provided by Repokit.

Agents can invoke the JSON CLI without a UI session. Provide author/session/model
metadata when useful, treat it as self-reporting, and inspect every JSON result.
Clients must preserve immutable targets, display the requested ref/side, surface
stale/unplaced results, escape bodies as data, and retain revision conflict checks.
