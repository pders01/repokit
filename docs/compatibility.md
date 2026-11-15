# Capabilities and compatibility

## Access paths

| Capability | Direct package | git-chat RPC | Presentation |
| --- | --- | --- | --- |
| Source/history/diff reads | repository-core; Node 22+ and Git | RepoService | Host client or adapter |
| Commits contracts/state | commits-core; standard ESM | Provider maps supported RepoService reads | Chatworks optional Commits reader |
| Private notes and placement | source-annotations; Node 22+ and Git | Not implemented | Chatworks injected-client panel or host UI |
| Context selection | context-records; standard ESM | Knowledge/cards use a different model | Host-supplied source records |
| Wire descriptors | git-chat-protocol; Protobuf | Go schema is authoritative | No UI dependency |

Shared contracts do not imply backend parity. Package READMEs describe supported
operations, dependencies and refusals. Repokit supplies no editor plugins or
persistent browser backend. Native filesystem helpers have POSIX assumptions;
Windows portability is not guaranteed.

## Runtime and types

Native services require Node 22+ and Git. Portable annotation contracts require
neither DOM nor Node declarations. Core/service/protocol APIs do not require DOM
runtime globals; native entries require Node type declarations and are not
browser-safe.

Connect 2.1 declarations reference `HeadersInit`, so TypeScript consumers of RPC
entries need standard DOM/fetch type libraries even under Node. The runtime uses
Node's fetch primitives. Hosts supply fetch, endpoint and authentication policy.

Import compiled public exports and satisfy declared dependencies/peers. Shared
Protobuf descriptors must retain object identity, including through Chatworks'
`/proto/auth`, `/proto/chat` and `/proto/repo` compatibility reexports. See
[package artifacts](../README.md#export-six-tarballs).

## Repository limits

Immutable reads pin object identities. Tree/compare arrays have no continuation
or completeness flag; search distinguishes result truncation from incomplete
listing. Shallow history/diff reads refuse rather than inventing roots or
exhaustion. See [repository-core bounds](../packages/repository-core/README.md#bounds-and-refusals).

The optional workspace entry reads mutable files/status, not snapshots. Directory
reads scan at most 5,000 entries, refuse on entry 5,001, return at most 500 entries
and use eight concurrent metadata reads. Path checks are not race-free filesystem
confinement. See [workspace limits](../packages/repository-core/docs/workspace.md).

The git-chat Commits adapter rejects normalization aliases and glob/pathspec-sensitive
names. Patch completeness is unknown without structured omission evidence. Native
Git and go-git may differ in merge, ordering, message, shallow and diff semantics.
Local cancellation/deadline settlement does not imply server-side cancellation.

## Annotations

Schema 1 uses `PI_WEBUI_ANNOTATIONS_DIR` or the default
`~/.local/share/pi-webui/annotations` unless an explicit base is supplied. The
`pi-webui` name is a storage identifier, not an application dependency.

Store access is lazy. Hosts must retain record identities, revision checks and
explicit import/export; changing hosts does not require deleting the store.
Neither a UI client nor git-chat connectivity authorizes note upload or creates
annotation RPCs. See [annotation schema and safeguards](annotations.md).

## Release status

Packages are private/unpublished, APIs experimental, and code [MIT-licensed](../LICENSE).
The [GitHub repository](https://github.com/pders01/repokit) provides source;
package artifacts must be built and supplied explicitly.
