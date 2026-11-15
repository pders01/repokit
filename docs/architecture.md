# Architecture

Repokit separates repository capabilities from their presentation and transport.
Native Git and annotation services run in Node. Portable contracts and state can
be consumed by browsers, editors or other hosts.

## Access paths

```text
Node application                           RPC client
       |                                        |
Repokit package API                       git-chat Connect API
       |                                        |
local Node implementation                 Go implementation
       |                                        |
   local Git                              server-side Git
```

Direct Node use and git-chat RPC are complementary, independently implemented
access paths. A common interface describes supported operations; it does not
supply missing capabilities or guarantee backend parity.

## Dependencies

```text
source-annotations -------> repository-core
commits-adapters ---------> commits-core
        |
        +-----------------> git-chat-protocol
context-records            (independent)
```

Headless packages do not import Chatworks, Lit, application state or editor APIs.
git-chat owns `proto/gitchat/v1` and the Go server. The protocol package contains
generated TypeScript descriptors; Chatworks' compatibility entries forward those
same objects.

Chatworks owns browser components, including optional `/source-annotations`,
`/commits-reader` and `/repository-ui` entries. Editor integrations own commands,
buffers and host lifecycle. Node-compatible hosts can embed services directly;
other hosts need a transport or CLI bridge.

## Source identity

Immutable reads identify repository scope, resolved commit, path, blob and range
where applicable. Branch names and display labels are not immutable identities.
Annotation placement is derived from an immutable anchor and never rewrites it.
Ambiguous matches remain unplaced. Missing, stale, refused and incomplete results
are distinct from successful empty results.

Mutable workspace reads have no snapshot guarantee. Editor buffers and live files
must not be presented as committed Git content. See [compatibility](compatibility.md)
for API-specific bounds and refusals.

## Authority and private data

Hosts bind repository selection, credentials, authenticated identity, request
scope and mutation policy. Libraries do not derive authorization from UI events
or author provenance.

Authored annotations and derived context have separate lifecycles and privacy.
git-chat has no annotation RPC; its connection does not upload local notes.
Annotation storage and import/export are explicit. Importing a package does not
initialize a store. See [annotation storage](annotations.md).

## Package boundary

Consumers use compiled public exports with declared dependencies and peers.
Normal builds use committed protocol artifacts. Schema updates use explicitly
selected git-chat inputs and the protocol package's
[generation guide](../packages/git-chat-protocol/docs/GENERATION.md).
