# @jpahd/git-chat-protocol

Private/unpublished ESM protobuf messages, enums and Connect service descriptors
for git-chat. Requires Node 22+ or a compatible ESM runtime and
`@bufbuild/protobuf` 2.14.0. [MIT](LICENSE).

git-chat owns the authoritative Go wire schema. This package contains generated
TypeScript descriptors; it creates no client, transport or connection.

```ts
import { create, toBinary } from "@bufbuild/protobuf";
import { ListCommitsRequestSchema, RepoService } from "@jpahd/git-chat-protocol/repo";

const request = create(ListCommitsRequestSchema, { repoId: "example", limit: 20 });
const bytes = toBinary(ListCommitsRequestSchema, request);
// RepoService can be passed to a separately configured Connect client.
```

## Public entries

| Export | JavaScript / declarations | Chatworks compatibility export |
| --- | --- | --- |
| `./auth` | `dist/gen/gitchat/v1/auth_pb.{js,d.ts}` | `@jpahd/chatworks/proto/auth` |
| `./chat` | `dist/gen/gitchat/v1/chat_pb.{js,d.ts}` | `@jpahd/chatworks/proto/chat` |
| `./repo` | `dist/gen/gitchat/v1/repo_pb.{js,d.ts}` | `@jpahd/chatworks/proto/repo` |

Entries export message types, schemas, enums, file descriptors and service
descriptors. There is no root barrel or CommonJS entry. Compatibility reexports
must forward the same descriptor objects, not copies or independently generated
versions.

Protobuf is the sole runtime dependency. Connect transports belong to consumers;
native repository-core reads need neither Connect nor this package. Supply this
package at runtime when importing a Chatworks protocol reexport, and deduplicate
Protobuf across the consumer's dependency graph.

## Canonical refs

`Branch.fullRef` is string field 5. Binary and protobuf JSON preserve it in
branch/tag inventories; JSON emits `fullRef` and accepts `full_ref`. Older-server
omission yields `""`. Clients must not invent a namespace-qualified ref from a
display name. `commit` may identify an annotated tag object, not a peeled commit.

## Build and verify

From this directory, with workspace dependencies installed:

```sh
npm run build
npm run check
npm test
```

Normal builds compile the committed artifacts. The generator is protoc-gen-es
2.12.0; runtime Protobuf and build TypeScript versions are separate. See
[generation and provenance](docs/GENERATION.md) for schema inputs, compatibility
fixtures and regeneration commands.
