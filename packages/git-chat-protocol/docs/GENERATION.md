# Protocol generation

## Schema and toolchain

git-chat owns `proto/gitchat/v1/{auth,chat,repo}.proto`. This package contains
TypeScript artifacts, not schemas or generated Go. Normal builds use the
committed artifacts and do not run a generator.

| Setting | Value |
| --- | --- |
| Generator | protoc-gen-es 2.12.0 |
| Plugin | `buf.build/bufbuild/es:v2.12.0` |
| Options | `target=ts,import_extension=js` |
| Protobuf package / syntax | `gitchat.v1` / proto3 |
| Runtime Protobuf | 2.14.0 |
| Build TypeScript | 5.9.3 |

`buf.gen.yaml` uses managed mode and emits candidates into `.sync/gen`.
Connect v2 consumes service descriptors directly; no Connect-ES plugin is needed.

## Compatibility fixtures

- [legacy-descriptors.json](../test/fixtures/legacy-descriptors.json): exports,
  source hashes and descriptor bytes from Chatworks
  `679a8e2fc96223f16a64f72e5c2b87b5a9090e7e`, with `Branch` fields 1–4.
- [current-baseline.json](../test/fixtures/current-baseline.json): maintained
  artifact origins/hashes, canonical schema descriptors and generated Go `Branch`
  tags. Its schema revision is git-chat
  `c644bb1b33ddb9d3e1a64a88e3990760c0d9ddb6`; the descriptor capture uses Buf 1.52.1.
  Artifact origin and schema revision are separate provenance records, not a claim
  that those schemas generated the artifact snapshot.

The current repo artifact's SHA-256 is
`b3b760d25dc0a6da0c6136ecd002aa8f07fb7e29229dc2ca819c53d891464b92`.
The fixtures retain exact hashes and source attribution; they are not checkout
dependencies.

Legacy comparisons permit only the additive `Branch.full_ref = 5` difference.
Canonical comparisons exclude managed language options and redundant explicit
`json_name` spellings, while checking effective JSON names. Source/descriptor
conformance is distinct from live-server behavior.

## Regenerate

Select the git-chat schema revision explicitly. From this package directory,
with Buf installed and an empty candidate directory:

```sh
GIT_CHAT=/path/to/git-chat
buf generate "$GIT_CHAT" --template buf.gen.yaml
diff -u src/gen/gitchat/v1/auth_pb.ts .sync/gen/gitchat/v1/auth_pb.ts
diff -u src/gen/gitchat/v1/chat_pb.ts .sync/gen/gitchat/v1/chat_pb.ts
diff -u src/gen/gitchat/v1/repo_pb.ts .sync/gen/gitchat/v1/repo_pb.ts
```

The remote plugin may require registry access. Review descriptor/API differences
before replacing generated files; do not hand-edit embedded descriptors. Retain
the legacy fixture and update the current fixture's schema revision, hashes and
independently captured canonical descriptors when changing schemas.

```sh
npm run check
npm test
```

Consumer compatibility also requires a deduplicated Protobuf/Connect graph and
shared descriptor identity through any compatibility reexports.
