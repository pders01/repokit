# Repokit

Headless Node/ESM libraries for bounded Git reads, private source annotations,
source-linked context and git-chat integration. Packages are MIT-licensed,
private/unpublished, and have experimental APIs.

## Packages

| Package | Responsibility | Runtime |
| --- | --- | --- |
| [@jpahd/repository-core](packages/repository-core/README.md) | Native Git inspection, immutable source reads and mutable workspace previews | Node 22+, Git |
| [@jpahd/source-annotations](packages/source-annotations/README.md) | Private notes, Git anchoring, storage, import/export and JSON CLI | Node 22+, Git |
| [@jpahd/context-records](packages/context-records/README.md) | Provenance, chronology, grouping and bounded prompt selection | Standard ESM |
| [@jpahd/commits-core](packages/commits-core/README.md) | Commit-reading contracts and presentation-independent reader state | Standard ESM |
| [@jpahd/commits-adapters](packages/commits-adapters/README.md) | Read-only git-chat Commits provider and transport helpers | Standard ESM; Connect/Protobuf peers |
| [@jpahd/git-chat-protocol](packages/git-chat-protocol/README.md) | Generated git-chat message and service descriptors | Standard ESM; Protobuf |

Native Node APIs and git-chat RPC are independent access paths with different
capabilities. Chatworks supplies browser UI; Repokit supplies no application shell,
editor plugin or annotation RPC server.

## Build and verify

Requirements: Node.js 22+, npm and native Git.

```sh
npm ci --ignore-scripts
npm run verify
```

`verify` builds packages, checks types, runs Node tests and checks packed consumers.
For individual steps, use `npm run build`, `npm run check`, `npm test` and
`npm run test:packed`. The packed check requires built output. Package-local
commands are listed in each README.

## Consume compiled packages

Use public package exports and supply their declared dependencies and peers.
Packages emit ESM JavaScript and TypeScript declarations. Node filesystem/Git
entries are not browser-safe; portable contracts and state can be used separately.

```js
import { getRepositoryFile } from '@jpahd/repository-core';

const file = await getRepositoryFile('/path/to/repository', 'README.md', 'HEAD');
```

### Export six tarballs

Pack all workspaces from a selected full Repokit commit SHA into an empty directory:

```sh
npm run verify
ARTIFACTS=/absolute/path/to/empty/repokit-bundle
mkdir -p "$ARTIFACTS"
npm pack --workspaces --ignore-scripts --offline --pack-destination "$ARTIFACTS"
```

This produces six npm archives, not a registry release. Provision third-party
dependencies separately. Consumers select and validate the artifacts they install;
Chatworks' development tooling requires the complete six-package set. Keep shared
Protobuf descriptors and peers deduplicated. See [compatibility](docs/compatibility.md)
for dependency and type-library requirements.

## Annotation CLI

```sh
node packages/source-annotations/dist/bin.js --help
node packages/source-annotations/dist/bin.js --cwd /repo --data-dir /private/base list
```

The installed binary is `source-annotations`. Success writes one JSON result to
stdout; errors go to stderr. Use an explicit disposable private data directory
for development, outside checkouts and `.git` ancestry.

The store uses schema 1. Its base is selected by the service constructor or
`--data-dir`, then `PI_WEBUI_ANNOTATIONS_DIR`, then
`~/.local/share/pi-webui/annotations`. Import/export is explicit; updates and
deletes require the current revision. See [annotation format and storage](docs/annotations.md).

## Host responsibilities

Hosts select repositories and bind credentials, authenticated identity, request
scope and mutation authority. Source text and annotation provenance are data, not
authorization or model instructions. Resource bounds are not an OS sandbox.

git-chat owns the Go wire schema and has no annotation RPC. Connecting to it does
not synchronize private notes. A browser or non-Node editor needs a host-provided
RPC or CLI bridge for native operations.

## Documentation

- [Architecture](docs/architecture.md)
- [Capabilities and compatibility](docs/compatibility.md)
- [Annotation schema, CLI and storage](docs/annotations.md)

## License

[MIT](LICENSE). Third-party licenses and notices apply.
