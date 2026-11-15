#!/usr/bin/env node
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadWorkspace, root } from "./workspace.mjs";
import { createPackedConsumer } from "./lib/packed-consumer.mjs";

const packages = loadWorkspace();
const consumer = await createPackedConsumer(packages.map((entry) => entry.directory), root);
try {
  for (const manifest of consumer.manifests) assert.equal(manifest.private, true);
  const checks = `import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { runGit } from '@jpahd/repository-core/git';
import { getWorkspaceStatus } from '@jpahd/repository-core/workspace';
import { AnnotationService } from '@jpahd/source-annotations';
import { documentContext, contextSourceKey, buildContextPromptDraft } from '@jpahd/context-records';
import { fullCommit } from '@jpahd/commits-core/contracts';
import { CommitsReaderState } from '@jpahd/commits-core/state';
import * as common from '@jpahd/commits-adapters/common';
import * as provider from '@jpahd/commits-adapters/git-chat';
import * as transport from '@jpahd/commits-adapters/git-chat-transport';
import { RepoService } from '@jpahd/git-chat-protocol/repo';
import { AuthService } from '@jpahd/git-chat-protocol/auth';
import { ChatService } from '@jpahd/git-chat-protocol/chat';
assert.equal(typeof Bun, 'undefined'); assert.equal(typeof document, 'undefined');
assert.equal(typeof runGit, 'function'); assert.equal(typeof AnnotationService, 'function');
assert.equal((await getWorkspaceStatus(process.cwd())).isGit, false);
const record = documentContext({authority:'canonical',path:'README.md',objectId:'a'.repeat(40),title:'Packed',preview:'Real packed consumer'});
assert.equal(buildContextPromptDraft([record],{selectedSourceKeys:[contextSourceKey(record.source)],maxTokens:4096}).citations.length,1);
assert.equal(fullCommit('a'.repeat(40)),'a'.repeat(40));
assert.equal(typeof CommitsReaderState,'function');
for(const exports of [common,provider,transport]) assert(Object.keys(exports).length);
for(const service of [RepoService,AuthService,ChatService]) assert(service.typeName.startsWith('gitchat.v1.'));
for(const name of ${JSON.stringify(packages.map((entry) => entry.manifest.name))}) {
 const specifier=name==='@jpahd/commits-adapters'?name+'/common':name==='@jpahd/git-chat-protocol'?name+'/repo':name==='@jpahd/commits-core'?name+'/contracts':name;
 const path=await realpath(fileURLToPath(import.meta.resolve(specifier)));
 assert(path.startsWith(resolve('node_modules',name)+'/dist/'),'Not extracted bytes: '+specifier);
}
console.log('All headless package entries consumed under Node without DOM/Bun');
`;
  await writeFile(join(consumer.directory, "consumer.mjs"), checks);
  console.log(consumer.run(process.execPath, ["consumer.mjs"]).trim());
  const annotation = consumer.manifests.find((entry) => entry.name === "@jpahd/source-annotations");
  const bin = typeof annotation.bin === "string" ? annotation.bin : annotation.bin["source-annotations"];
  assert.match(consumer.run(process.execPath, [join(consumer.directory, "node_modules", annotation.name, bin), "--help"]), /[Uu]sage/);
  await writeFile(join(consumer.directory, "consumer.ts"), `
import type { AnnotationClient } from '@jpahd/source-annotations/contracts';
import { AnnotationService } from '@jpahd/source-annotations';
import { documentContext } from '@jpahd/context-records';
import { runGit } from '@jpahd/repository-core/git';
import { getWorkspaceStatus } from '@jpahd/repository-core/workspace';
import { CommitsReaderState } from '@jpahd/commits-core/state';
import { RepoService } from '@jpahd/git-chat-protocol/repo';
void documentContext; void runGit; void getWorkspaceStatus; void CommitsReaderState; void AnnotationService;
void RepoService;
export type Consumer = { client: AnnotationClient };
`);
  await writeFile(join(consumer.directory, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: false, noEmit: true, types: ["node"], lib: ["ES2022"] }, include: ["consumer.ts"] }));
  consumer.run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"]);
  console.log("Packed core/service/protocol declarations compile without DOM; standalone annotation CLI help passed");
  // Connect 2.1 declarations refer to HeadersInit, which @types/node does not
  // expose globally. Keep this upstream typing requirement distinct from runtime
  // support: the RPC adapters already ran above with no DOM or Bun globals.
  await writeFile(join(consumer.directory, "rpc-consumer.ts"), `
import * as provider from '@jpahd/commits-adapters/git-chat';
import * as transport from '@jpahd/commits-adapters/git-chat-transport';
void provider; void transport;
`);
  await writeFile(join(consumer.directory, "tsconfig.rpc.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: false, noEmit: true, types: ["node"], lib: ["ES2022", "DOM", "DOM.Iterable"] }, include: ["rpc-consumer.ts"] }));
  consumer.run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.rpc.json"]);
  console.log("Packed Connect adapter declarations compile with standard fetch/DOM type libraries");
} finally {
  await consumer.dispose();
}
