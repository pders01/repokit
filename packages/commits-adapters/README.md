# @jpahd/commits-adapters

Experimental, private/unpublished ESM adapters for headless Commits providers.
Requires Node 22+ or a compatible browser host. [MIT](LICENSE).

## Public entries

| Entry | Purpose |
| --- | --- |
| `/common` | Bounded validation, immutable snapshots, safe errors and finite cancellable reads |
| `/git-chat` | Read-only git-chat RepoService Commits provider |
| `/git-chat-transport` | Host-injected Connect-web transport restricted to reading RPCs |

There is no root export or prebuilt native-Git Commits provider. Hosts can
implement a provider using repository-core reads. The common entry depends on
commits-core contracts, not wire descriptors. RPC entries use
`@jpahd/git-chat-protocol/repo`.

## Host contract

Hosts supply repository/worktree bindings, initial-ref policy, endpoint,
authentication and fetch/transport. Adapters do not select repositories, navigate
or mutate Git. Bindings and returned values are immutable snapshots; errors are
sanitized and reads have finite local deadlines.

The git-chat adapter rejects normalization aliases and glob/pathspec-sensitive
names. Patch completeness is unknown without structured omission evidence.
Refusals and capabilities remain explicit; a shared provider interface does not
guarantee native/go-git merge, order, message, shallow or diff parity. Local
cancellation does not establish server-side cancellation.

## Dependencies

Commits-core, git-chat-protocol, Protobuf and Connect are peers. Supply matching
private core/protocol artifacts and deduplicate the wire dependency graph. No UI
package is required.

The Connect-web transport uses standard fetch primitives and an explicit
host-injected fetch. Connect 2.1 declarations require DOM/fetch type libraries
(`HeadersInit`) even in Node TypeScript consumers; this is not a DOM runtime
dependency. See [compatibility](../../docs/compatibility.md).

## Build and verify

Build commits-core and git-chat-protocol first, then run from this directory:

```sh
npm run build
npm run check
npm test
npm run check:package
```

`check:package` checks a local archive's integrity and module/declaration closure.
The workspace's `test:packed` checks consumption of the actual package archives.
See [workspace commands](../../README.md#build-and-verify).
