# @jpahd/source-annotations

Private/unpublished ESM for annotation storage, Git anchoring and a JSON CLI.
Requires Node 22+ and Git. Its only runtime package dependency is
`@jpahd/repository-core`, through its `/git` entry. [MIT](LICENSE).

## Build and checks

From the repository root, after the npm workspace install and repository-core
build:

```sh
npm --prefix packages/source-annotations run build
npm --prefix packages/source-annotations run check
npm --prefix packages/source-annotations run check:contracts
npm --prefix packages/source-annotations test
```

Build before checking contracts or testing; these commands use compiled output.
Native entries need Node type declarations; `/contracts` needs only ES2022 types.

## Service and resolver (`.`)

```ts
import { AnnotationService, createGitTarget, createGitResolver }
  from "@jpahd/source-annotations";

const service = new AnnotationService("/private/base");
const notes = await service.list("/repo", { ref: "HEAD" });
const note = await service.create("/repo", {
  ref: "HEAD", path: "src/example.ts", startLine: 1, endLine: 2,
  body: "Explains this conversion boundary.",
}, { kind: "human", name: "Reader" });
await service.update("/repo", {
  id: note.id, expectedRevision: note.revision, state: "resolved",
});
```

`AnnotationService` exposes `list(cwd, query?)`,
`create(cwd, input, author)`, `update(cwd, input)`,
`delete(cwd, id, expectedRevision)`, `export(cwd)` and `import(cwd, document)` API.
The root also exports `gitRepositoryKey`, `resolveAnnotationRef`,
`createGitTarget` and `createGitResolver`. Resolve within an explicitly requested
repository; original targets must be immutable Git commits. `WORKTREE` is only a
listing projection. Placement never mutates an original target, and ambiguity
remains unplaced rather than silently choosing a match.

## Neutral contracts (`./contracts`)

All portable annotation types and `AnnotationClient` are exported as types here.
This entry has no runtime imports and needs neither DOM nor Node declarations.
`AnnotationClient` deliberately exposes only the UI/editor-facing operations:

```ts
interface AnnotationClient {
  list(query: AnnotationQuery): Promise<AnnotationList>;
  create(input: AnnotationCreate): Promise<SourceAnnotation>;
  update(input: AnnotationUpdate): Promise<SourceAnnotation>;
  delete(input: { id: string; expectedRevision: number }): Promise<{ deleted: true }>;
}
```

The **host** binds cwd, author attribution, authentication and transport policy:

```ts
const client: AnnotationClient = {
  list: (query) => service.list(cwd, query),
  create: (input) => service.create(cwd, input, author),
  update: (input) => service.update(cwd, input),
  delete: ({ id, expectedRevision }) => service.delete(cwd, id, expectedRevision),
};
```

An author's optional `sessionId` remains portable **self-reported provenance**;
it is not an RPC routing scope or an authenticated identity. Hosts own their
request scope and authorization; neither is inferred from annotation metadata.

## JSON CLI (`./cli` and `source-annotations` bin)

```sh
node packages/source-annotations/dist/bin.js --help
node packages/source-annotations/dist/bin.js --cwd /repo --data-dir /private/base list
printf '%s' '{"ref":"HEAD","path":"src/example.ts","startLine":1,"endLine":2,"body":"Explains the boundary."}' \
  | node packages/source-annotations/dist/bin.js --cwd /repo --data-dir /private/base create
```

An installed workspace bin may be invoked as `source-annotations`. Commands are
`list`, `create`, `update`, `delete`, `export` and `import`; run `--help` for flags.
`./cli` exports `parseAnnotationArgs`, throwing `main(args?, usage?)`, and
`runAnnotationCli(args?, usage?)`, which reports a JSON error on stderr and sets
`process.exitCode = 1`. Importing `./cli` never starts it. The separate Node bin invokes the CLI.

Success writes exactly one JSON result on stdout; failure writes exactly one JSON
error on stderr. Mutation JSON stdin is bounded to 1 MiB, import to 17 MiB.
Export is a portable schema-1 document; import verifies all original Git anchors
before writing, remaps repository IDs and rejects conflicting IDs. Update/delete
require the exact current revision. No silent merging, migration or synchronization.

## Storage compatibility and safeguards

The store uses schema 1. Its base is selected in this order:

1. Explicit service constructor/CLI `--data-dir` base;
2. `PI_WEBUI_ANNOTATIONS_DIR`;
3. `~/.local/share/pi-webui/annotations`.

Access is lazy. Nothing reads or initializes a store merely by importing the
package or showing help. Below the base, SHA-256 of Git's canonical common-dir
selects a namespace containing one `annotations.json` with `schemaVersion`,
`repositoryId`, and `annotations`. Linked worktrees share identity. Lists before
first write use `namespace-…`; the first write allocates a logical UUID. There is
no identity sidecar or data rewrite on read.

The base must be outside every checkout/`.git` ancestry. Existing directories must
be `0700`, files `0600`; symlinks, unknown files and malformed/missing committed
data fail closed. Writers use an exclusive sibling lock directory and atomic
private temporary rename. Recognized private temporary files are ignored, never
promoted. Busy/stale locks and missing documents require explicit manual recovery;
the package never deletes/reconstructs a live store. Back up private data while
writers are stopped, and keep explicit exports private (they include prose and
source quotes).

Record/body/source/export limits, queue limits, Git deadlines and aggregate
budgets are documented in the annotation guide. `@jpahd/repository-core/git`
supplies the shared argument-vector Git runner, environment isolation and budget
accounting. These
are resource and filesystem safeguards, **not an OS sandbox** or protection from
trusted same-user processes. Annotation bodies/provenance are data, not instructions.

The browser panel lives in Chatworks under its optional `/source-annotations`
entry. Native editor integrations may use this service in a compatible Node host
or call a host-owned RPC/CLI bridge. git-chat currently has no annotation RPC
service; the injected client interface does not create one automatically. See the
[annotation schema and CLI guide](../../docs/annotations.md) and
[six-tarball export](../../README.md#export-six-tarballs).
