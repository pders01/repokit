import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { clone, create, fromBinary, fromJson, toBinary, toJson, ScalarType } from "@bufbuild/protobuf";
import { fileDesc } from "@bufbuild/protobuf/codegenv2";
import { FileDescriptorProtoSchema } from "@bufbuild/protobuf/wkt";
// Self-references intentionally exercise the public compiled package exports.
import * as auth from "@jpahd/git-chat-protocol/auth";
import * as chat from "@jpahd/git-chat-protocol/chat";
import * as repo from "@jpahd/git-chat-protocol/repo";

const baseline = JSON.parse(await readFile(new URL("./fixtures/legacy-descriptors.json", import.meta.url), "utf8"));
const currentBaseline = JSON.parse(await readFile(new URL("./fixtures/current-baseline.json", import.meta.url), "utf8"));
const modules = { auth, chat, repo };
// These independent descriptors are the exact embedded pre-extraction Chatworks
// descriptors, not an oracle rederived from the package under test.
const legacy = Object.fromEntries(Object.entries(baseline.files).map(([name, file]) => [name, fileDesc(file.descriptorBase64)]));
const hex = (bytes) => Buffer.from(bytes).toString("hex");

for (const [name, api] of Object.entries(modules)) {
  test(`${name}: every legacy runtime export is present in the public compiled API`, () => {
    assert.deepEqual(Object.keys(api).sort(), baseline.files[name].exports.filter((x) => x.kind !== "type").map((x) => x.name).sort());
    assert.equal(typeof globalThis.document, "undefined");
    assert.equal(typeof globalThis.customElements, "undefined");
  });

  test(`${name}: complete legacy descriptor is unchanged except approved Branch.full_ref addition`, () => {
    const current = api[`file_gitchat_v1_${name}`];
    assert.equal(current.name, `gitchat/v1/${name}`);
    const previousShape = clone(FileDescriptorProtoSchema, current.proto);
    if (name === "repo") {
      const branch = previousShape.messageType.find((x) => x.name === "Branch");
      assert.equal(branch.field.length, 5);
      assert.equal(branch.field.pop().name, "full_ref");
    }
    assert.deepEqual(toBinary(FileDescriptorProtoSchema, previousShape), toBinary(FileDescriptorProtoSchema, legacy[name].proto));
  });

  test(`${name}: current descriptor conforms to independently compiled canonical Go schema`, () => {
    const current = api[`file_gitchat_v1_${name}`];
    const canonical = fromBinary(FileDescriptorProtoSchema, Buffer.from(currentBaseline.files[name].canonicalDescriptorBase64, "base64"));
    // Managed ES adds language file options; Buf's canonical descriptor also
    // spells out derived json_name values that ES compresses away. Compare all
    // remaining descriptor structure, and check effective JSON names separately.
    const normalize = (proto) => {
      const json = toJson(FileDescriptorProtoSchema, proto);
      delete json.options;
      const visit = (value) => Array.isArray(value) ? value.map(visit)
        : value && typeof value === "object" ? Object.fromEntries(Object.entries(value)
          .filter(([key]) => key !== "jsonName").map(([key, child]) => [key, visit(child)])) : value;
      return visit(json);
    };
    assert.deepEqual(normalize(current.proto), normalize(canonical));
    for (const message of canonical.messageType) {
      const schema = api[`${message.name}Schema`];
      assert.deepEqual(schema.fields.map((x) => [x.name, x.number, x.jsonName]),
        message.field.map((x) => [x.name, x.number, x.jsonName]));
    }
    assert.equal(currentBaseline.files[name].protoSha256, baseline.files[name].observedProtoSha256);
  });

  test(`${name}: all message schemas retain metadata and binary/JSON default compatibility`, () => {
    const current = api[`file_gitchat_v1_${name}`];
    for (const oldSchema of legacy[name].messages) {
      const schema = api[`${oldSchema.name}Schema`];
      assert.ok(schema, oldSchema.typeName);
      assert.equal(schema.typeName, oldSchema.typeName);
      assert.equal(current.messages.find((x) => x.typeName === schema.typeName), schema);
      const oldMessage = create(oldSchema);
      const bytes = toBinary(oldSchema, oldMessage);
      const newMessage = fromBinary(schema, bytes);
      assert.deepEqual(toBinary(schema, newMessage), bytes);
      assert.deepEqual(toJson(schema, newMessage), toJson(oldSchema, oldMessage));
      assert.deepEqual(fromBinary(oldSchema, toBinary(schema, newMessage)), oldMessage);
    }
  });

  test(`${name}: generated sources match reviewed Pi baseline and retain all legacy declaration symbols`, async () => {
    const source = await readFile(new URL(`../src/gen/gitchat/v1/${name}_pb.ts`, import.meta.url), "utf8");
    const sourceHash = createHash("sha256").update(source).digest("hex");
    assert.equal(sourceHash, currentBaseline.files[name].sourceSha256);
    if (name !== "repo") assert.equal(sourceHash, baseline.files[name].sourceSha256);
    assert.match(source, /protoc-gen-es v2\.12\.0/);
    assert.match(source, /target=ts,import_extension=js/);
    const declaration = await readFile(new URL(`../dist/gen/gitchat/v1/${name}_pb.d.ts`, import.meta.url), "utf8");
    const names = [...declaration.matchAll(/^export (?:declare )?(?:type|const|enum) (\w+)/gm)].map((x) => x[1]).sort();
    assert.deepEqual(names, baseline.files[name].exports.map((x) => x.name).sort());
  });
}

function roundTrip(moduleName, schemaName, input, expectedHex, expectedJson) {
  const schema = modules[moduleName][`${schemaName}Schema`];
  const oldSchema = legacy[moduleName].messages.find((x) => x.name === schemaName);
  const message = create(schema, input);
  const bytes = toBinary(schema, message);
  assert.equal(hex(bytes), expectedHex);
  assert.deepEqual(toBinary(oldSchema, create(oldSchema, input)), bytes);
  assert.deepEqual(fromBinary(schema, toBinary(oldSchema, create(oldSchema, input))), message);
  assert.deepEqual(fromBinary(oldSchema, bytes), create(oldSchema, input));
  assert.deepEqual(toJson(schema, message), expectedJson);
  assert.deepEqual(fromJson(schema, expectedJson), message);
}

test("auth: stable int64, enum, and terminal oneof wire/JSON representations", () => {
  roundTrip("auth", "StartPairingResponse", { sid: "s", code: "C", expiresAt: 9007199254740993n },
    "0a0173120143188180808080808010", { sid: "s", code: "C", expiresAt: "9007199254740993" });
  roundTrip("auth", "WhoamiResponse", { principal: "p", mode: auth.AuthMode.LOCAL },
    "0a01701001", { principal: "p", mode: "AUTH_MODE_LOCAL" });
  roundTrip("auth", "WatchPairingResponse", { kind: { case: "paired", value: { claimToken: "t", principal: "p" } } },
    "0a060a0174120170", { paired: { claimToken: "t", principal: "p" } });
  roundTrip("auth", "WatchPairingResponse", { kind: { case: "expired", value: { reason: "x" } } },
    "12030a0178", { expired: { reason: "x" } });
});

test("chat: bytes, bigint and streaming oneof cases preserve wire/JSON behavior", () => {
  roundTrip("chat", "Attachment", { id: "a", size: 3n, data: new Uint8Array([0, 255, 128]) },
    "0a016120032a0300ff80", { id: "a", size: "3", data: "AP+A" });
  roundTrip("chat", "MessageChunk", { kind: { case: "token", value: "hi" } },
    "0a026869", { token: "hi" });
  roundTrip("chat", "MessageChunk", { kind: { case: "thinking", value: "why" } },
    "3a03776879", { thinking: "why" });
  roundTrip("chat", "ChatMessage", { role: chat.MessageRole.ASSISTANT, createdAt: 42n },
    "1802402a", { role: "MESSAGE_ROLE_ASSISTANT", createdAt: "42" });
});

test("repo: repeated fields, literal paths and request fields keep exact binary/JSON behavior", () => {
  roundTrip("repo", "ListCommitsRequest", { repoId: "r", ref: "main", limit: 2, offset: 3, path: "a\nb" },
    "0a017212046d61696e180220032a03610a62", { repoId: "r", ref: "main", limit: 2, offset: 3, path: "a\nb" });
  roundTrip("repo", "CommitEntry", { sha: "s", authorTime: 42n, parentShas: ["a", "b"] },
    "0a0173302a5a01615a0162", { sha: "s", authorTime: "42", parentShas: ["a", "b"] });
  roundTrip("repo", "GetDiffRequest", { repoId: "r", fromPath: "old", fullRange: true, filesOnly: true },
    "0a017232036f6c6438014001", { repoId: "r", fromPath: "old", fullRange: true, filesOnly: true });
});

test("stable field names, numbers, scalar kinds, enum values and streaming metadata", () => {
  assert.deepEqual(repo.BranchSchema.fields.map((x) => [x.name, x.number, x.localName, x.jsonName, x.fieldKind, x.scalar]), [
    ["name", 1, "name", "name", "scalar", ScalarType.STRING],
    ["commit", 2, "commit", "commit", "scalar", ScalarType.STRING],
    ["committer_time", 3, "committerTime", "committerTime", "scalar", ScalarType.INT64],
    ["subject", 4, "subject", "subject", "scalar", ScalarType.STRING],
    ["full_ref", 5, "fullRef", "fullRef", "scalar", ScalarType.STRING],
  ]);
  assert.deepEqual(chat.MessageChunkSchema.fields.map((x) => [x.name, x.number, x.oneof?.name]), [
    ["token", 1, "kind"], ["done", 2, "kind"], ["card_hit", 3, "kind"], ["started", 4, "kind"],
    ["tool_call", 5, "kind"], ["tool_result", 6, "kind"], ["thinking", 7, "kind"],
  ]);
  assert.equal(repo.GetDiffRequestSchema.field.fromPath.number, 6);
  assert.equal(repo.CommitEntrySchema.field.parentShas.fieldKind, "list");
  assert.equal(auth.AuthMode.UNSPECIFIED, 0);
  assert.equal(auth.AuthMode.PAIRED, 2);
  assert.equal(chat.MessageRole.SYSTEM, 3);
  assert.equal(repo.EntryType.SUBMODULE, 4);
  assert.equal(auth.AuthService.typeName, "gitchat.v1.AuthService");
  assert.equal(auth.AuthService.method.watchPairing.methodKind, "server_streaming");
  assert.equal(chat.ChatService.method.sendMessage.methodKind, "server_streaming");
  assert.equal(chat.ChatService.method.sendMessage.output, chat.MessageChunkSchema);
  assert.equal(repo.RepoService.typeName, "gitchat.v1.RepoService");
  assert.equal(repo.RepoService.method.listCommits.methodKind, "unary");
  assert.equal(repo.RepoService.method.listCommits.input, repo.ListCommitsRequestSchema);
  assert.equal(repo.RepoService.method.listCommits.output, repo.ListCommitsResponseSchema);
});

test("Branch.full_ref field 5 is typed and preserved in binary and protobuf JSON", () => {
  const wire = Buffer.from("0a046d61696e2a0f726566732f68656164732f6d61696e", "hex");
  const message = fromBinary(repo.BranchSchema, wire);
  assert.equal(message.name, "main");
  assert.equal(message.fullRef, "refs/heads/main");
  assert.deepEqual(create(repo.BranchSchema, { name: "main", fullRef: "refs/heads/main" }), message);
  assert.equal(hex(toBinary(repo.BranchSchema, message)), hex(wire));
  const json = { name: "main", fullRef: "refs/heads/main" };
  assert.deepEqual(toJson(repo.BranchSchema, message), json);
  assert.deepEqual(fromJson(repo.BranchSchema, json), message);
  const snakeJson = { name: "main", full_ref: "refs/heads/main" };
  assert.deepEqual(toJson(repo.BranchSchema, message, { useProtoFieldName: true }), snakeJson);
  assert.deepEqual(fromJson(repo.BranchSchema, snakeJson), message);

  // Keep the original unknown-field proof against the actual older descriptor.
  const oldSchema = legacy.repo.messages.find((x) => x.name === "Branch");
  const oldMessage = fromBinary(oldSchema, wire);
  assert.equal(oldSchema.fields.some((x) => x.number === 5), false);
  assert.equal(hex(toBinary(oldSchema, oldMessage)), hex(wire));
  assert.deepEqual(toJson(oldSchema, oldMessage), { name: "main" });
  assert.equal(fromBinary(repo.BranchSchema, toBinary(oldSchema, oldMessage)).fullRef, message.fullRef);
});

test("older-server Branch omission preserves fields 1–4 without inventing a full ref", () => {
  roundTrip("repo", "Branch", { name: "main", commit: "tag-object", committerTime: 42n, subject: "s" },
    "0a046d61696e120a7461672d6f626a656374182a220173",
    { name: "main", commit: "tag-object", committerTime: "42", subject: "s" });
  for (const message of [create(repo.BranchSchema), fromBinary(repo.BranchSchema, new Uint8Array()), fromJson(repo.BranchSchema, { name: "main" })]) {
    assert.equal(message.fullRef, "");
    assert.equal(Object.hasOwn(toJson(repo.BranchSchema, message), "fullRef"), false);
  }
  const oldSchema = legacy.repo.messages.find((x) => x.name === "ListBranchesResponse");
  const oldMessage = create(oldSchema, { branches: [{ name: "main" }], tags: [{ name: "main", commit: "tag-object" }] });
  for (const response of [fromBinary(repo.ListBranchesResponseSchema, toBinary(oldSchema, oldMessage)),
    fromJson(repo.ListBranchesResponseSchema, toJson(oldSchema, oldMessage))]) {
    assert.equal(response.branches[0].fullRef, "");
    assert.equal(response.tags[0].fullRef, "");
    assert.deepEqual(toJson(repo.ListBranchesResponseSchema, response), toJson(oldSchema, oldMessage));
  }
});

test("ListBranchesResponse preserves exact branch/tag namespace metadata through binary and JSON", () => {
  const input = { branches: [{ name: "main", commit: "branch-object", fullRef: "refs/heads/main" }],
    tags: [{ name: "main", commit: "tag-object", fullRef: "refs/tags/main" }] };
  const message = create(repo.ListBranchesResponseSchema, input);
  for (const response of [fromBinary(repo.ListBranchesResponseSchema, toBinary(repo.ListBranchesResponseSchema, message)),
    fromJson(repo.ListBranchesResponseSchema, toJson(repo.ListBranchesResponseSchema, message))]) {
    assert.deepEqual(response, message);
    assert.deepEqual(toJson(repo.ListBranchesResponseSchema, response), input);
  }
});

test("Branch metadata conforms to captured generated Go protobuf tags, not encoding/json tags", () => {
  assert.equal(currentBaseline.goBranch.fields.length, 5);
  assert.deepEqual(repo.BranchSchema.fields.map((field) => {
    const wireType = field.scalar === ScalarType.STRING ? "bytes" : "varint";
    const jsonOption = field.name === field.jsonName ? "" : `,json=${field.jsonName}`;
    return [field.name, field.scalar === ScalarType.STRING ? "string" : "int64",
      `${wireType},${field.number},opt,name=${field.name}${jsonOption},proto3`];
  }), currentBaseline.goBranch.fields.map((field) => [field.jsonTag.split(",")[0], field.goType, field.protobufTag]));
  assert.equal(repo.BranchSchema.field.fullRef.jsonName, "fullRef");
});

test("package is private Node ESM with only protobuf as a runtime dependency", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.private, true);
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.type, "module");
  assert.equal(manifest.engines.node, ">=22");
  assert.equal(manifest.sideEffects, false);
  assert.deepEqual(manifest.dependencies, { "@bufbuild/protobuf": "2.14.0" });
  assert.equal(manifest.peerDependencies, undefined);
  assert.deepEqual(Object.keys(manifest.exports).sort(), ["./auth", "./chat", "./repo"]);
  for (const [name, api] of Object.entries(modules)) {
    assert.ok(api[`file_gitchat_v1_${name}`]);
    const js = await readFile(new URL(`../dist/gen/gitchat/v1/${name}_pb.js`, import.meta.url), "utf8");
    const imports = [...js.matchAll(/\bfrom\s+"([^"]+)"/g)].map((x) => x[1]);
    assert.deepEqual(imports, ["@bufbuild/protobuf/codegenv2"]);
  }
});
