import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { assertGitBudget, withGitBudget } from "@jpahd/repository-core/git";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type {
  AnnotationAuthor,
  AnnotationCategory,
  AnnotationCreate,
  AnnotationExport,
  AnnotationList,
  AnnotationQuery,
  AnnotationState,
  AnnotationUpdate,
  GitAnnotationTarget,
  ResolvedAnnotation,
  SourceAnnotation,
} from "./contracts.js";
import {
  createGitResolver,
  createGitTarget,
  gitRepositoryKey,
  resolveAnnotationRef,
} from "./git-target.js";

/**
 * The store is deliberately a single bounded JSON document per repository.  A
 * namespace which has never been written gets a deterministic display id;
 * the UUID is allocated, atomically, by the first write (including import).
 */
const SCHEMA_VERSION = 1;
const MAX_RECORDS = 1_000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 4 * 1024;
const MAX_QUOTE_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_EXPORT_BYTES = 16 * 1024 * 1024;
const INITIALIZATION_RETRY_MS = 1_000;
const INITIALIZATION_RETRY_DELAY_MS = 10;
const MAX_LINE = 10_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const FINGERPRINT = /^[0-9a-f]{64}$/i;
const ANNOTATION_TEMP = /^annotations\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;

type StoredDocument = {
  schemaVersion: 1;
  repositoryId: string;
  annotations: SourceAnnotation[];
};

export class AnnotationService {
  private base: string;
  private baseCanonicalized = false;
  // Keep expensive Git-backed operations from piling up within one service;
  // separate service instances still coordinate through the filesystem lock.
  private expensiveTail: Promise<void> = Promise.resolve();
  private expensivePending = 0;

  constructor(configuredBase?: string) {
    const requested = configuredBase?.trim() || process.env.PI_WEBUI_ANNOTATIONS_DIR?.trim()
      || resolve(homedir(), ".local/share/pi-webui/annotations");
    // Defer filesystem and repository-policy validation until an annotation
    // operation actually needs the store. Optional storage must not block
    // unrelated server startup.
    if (!requested) throw new Error("Annotation storage directory is empty");
    this.base = resolve(requested);
  }

  async list(cwd: string, query: AnnotationQuery = {}): Promise<AnnotationList> {
    assertQuery(query);
    return this.withExpensiveGuard(async () => {
      const context = await this.context(cwd);
      const stored = await this.loadForReader(context);
      const repositoryId = stored?.repositoryId || context.displayId;
      const ref = await resolveAnnotationRef(cwd, query.ref);
      const resolver = await createGitResolver(cwd, ref);
      const candidates = (stored?.annotations || []).filter((annotation) =>
        query.includeResolved || annotation.state !== "resolved");
      const items: ResolvedAnnotation[] = [];
      for (const annotation of candidates) {
        assertGitBudget();
        const placement = await resolver(annotation.target);
        // A known projection owns path filtering. Falling back to the original
        // path for an unplaced target keeps old notes discoverable, while a
        // rename cannot make a note appear under a reused old path.
        const projectedPath = placement.path ?? annotation.target.path;
        if (query.path !== undefined && projectedPath !== query.path) continue;
        items.push({ annotation: clone(annotation), placement });
      }
      return { repositoryId, ref, items };
    });
  }

  async create(cwd: string, input: AnnotationCreate, author: AnnotationAuthor): Promise<SourceAnnotation> {
    assertCreate(input);
    assertAuthor(author);
    return this.withExpensiveGuard(async () => {
      const target = await createGitTarget(cwd, {
        ref: input.ref,
        path: input.path,
        startLine: input.startLine,
        endLine: input.endLine,
        whitespace: input.whitespace,
      });
      assertTarget(target);
      const context = await this.context(cwd);
      return this.withLock(context, async () => {
        const document = await this.loadOrCreate(context);
        if (document.annotations.length >= MAX_RECORDS) throw new Error("Annotation record limit exceeded");
        const now = new Date().toISOString();
        const annotation: SourceAnnotation = {
          id: crypto.randomUUID(),
          repositoryId: document.repositoryId,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          author: clone(author),
          body: input.body,
          category: input.category || "explanation",
          state: "open",
          target: clone(target),
        };
        assertAnnotation(annotation);
        document.annotations.push(annotation);
        await this.save(context, document);
        return clone(annotation);
      });
    });
  }

  async update(cwd: string, input: AnnotationUpdate): Promise<SourceAnnotation> {
    assertUpdate(input);
    const id = normalizeId(input.id);
    const context = await this.context(cwd);
    return this.withLock(context, async () => {
      const document = await this.load(context);
      if (!document) throw new Error("Annotation not found");
      const index = document.annotations.findIndex((candidate) => candidate.id === id);
      if (index < 0) throw new Error("Annotation not found");
      const current = document.annotations[index]!;
      if (current.revision !== input.expectedRevision) throw new Error("Annotation revision conflict");
      const updated: SourceAnnotation = {
        ...current,
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.category === undefined ? {} : { category: input.category }),
        ...(input.state === undefined ? {} : { state: input.state }),
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      assertAnnotation(updated);
      document.annotations[index] = updated;
      await this.save(context, document);
      return clone(updated);
    });
  }

  async delete(cwd: string, id: string, expectedRevision: number): Promise<{ deleted: true }> {
    assertId(id);
    assertRevision(expectedRevision);
    const normalizedId = normalizeId(id);
    const context = await this.context(cwd);
    return this.withLock(context, async () => {
      const document = await this.load(context);
      if (!document) throw new Error("Annotation not found");
      const index = document.annotations.findIndex((candidate) => candidate.id === normalizedId);
      if (index < 0) throw new Error("Annotation not found");
      if (document.annotations[index]!.revision !== expectedRevision) throw new Error("Annotation revision conflict");
      document.annotations.splice(index, 1);
      await this.save(context, document);
      return { deleted: true };
    });
  }

  async export(cwd: string): Promise<AnnotationExport> {
    return this.withExpensiveGuard(async () => {
      const context = await this.context(cwd);
      const document = await this.loadForReader(context);
      const result: AnnotationExport = {
        schemaVersion: 1,
        // Lists may use a deterministic ephemeral display id, but a portable
        // empty export must carry a logical UUID rather than a namespace hash.
        repository: { id: document?.repositoryId || crypto.randomUUID() },
        annotations: document?.annotations.map(clone) || [],
      };
      assertExport(result);
      const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
      if (bytes > MAX_EXPORT_BYTES) throw new Error("Annotation export limit exceeded");
      return result;
    });
  }

  async import(cwd: string, document: unknown): Promise<{ imported: number; skipped: number }> {
    const incoming = parseExport(document);
    return this.withExpensiveGuard(async () => {
      const context = await this.context(cwd);
      // Anchor verification intentionally happens before taking the write lock and
      // before identity creation: a bad portable document has no side effects.
      const verified: SourceAnnotation[] = [];
      const seen = new Set<string>();
      for (const original of incoming.annotations) {
        assertGitBudget();
        if (seen.has(original.id)) throw new Error("Import contains duplicate annotation ids");
        seen.add(original.id);
        const target = await createGitTarget(cwd, {
          ref: original.target.commit,
          path: original.target.path,
          startLine: original.target.startLine,
          endLine: original.target.endLine,
          whitespace: original.target.whitespace,
        });
        assertTarget(target);
        if (!sameTarget(target, original.target)) throw new Error(`Import anchor verification failed for ${original.id}`);
        verified.push(clone(original));
      }

      return this.withLock(context, async () => {
        const local = await this.loadOrCreate(context);
        const byId = new Map(local.annotations.map((annotation) => [annotation.id, annotation]));
        let imported = 0;
        let skipped = 0;
        const additions: SourceAnnotation[] = [];
        for (const original of verified) {
          const remapped = { ...original, repositoryId: local.repositoryId };
          const existing = byId.get(remapped.id);
          if (existing) {
            if (!sameJson(existing, remapped)) throw new Error(`Import annotation id collision: ${remapped.id}`);
            skipped++;
          } else {
            additions.push(remapped);
            byId.set(remapped.id, remapped);
            imported++;
          }
        }
        if (local.annotations.length + additions.length > MAX_RECORDS) throw new Error("Annotation record limit exceeded");
        if (additions.length > 0) {
          local.annotations.push(...additions);
          await this.save(context, local);
        }
        return { imported, skipped };
      });
    });
  }

  private async context(cwd: string): Promise<Context> {
    const commonDirectory = await gitRepositoryKey(cwd);
    if (!isAbsolute(commonDirectory)) throw new Error("Git repository key must be absolute");
    // Resolve ordinary ancestor aliases (for example /tmp on macOS) only at
    // access time, while rejecting a configured final symlink.
    if (!this.baseCanonicalized) {
      this.base = canonicalPotentialPath(this.base);
      this.baseCanonicalized = true;
    }
    assertCanonicalPath(this.base);
    rejectGitAncestry(this.base);
    const namespace = createHash("sha256").update(commonDirectory).digest("hex");
    return {
      namespace,
      displayId: `namespace-${namespace}`,
      directory: join(this.base, namespace),
      annotationsPath: join(this.base, namespace, "annotations.json"),
      lockPath: join(this.base, `${namespace}.lock`),
    };
  }

  private async loadForReader(context: Context): Promise<StoredDocument | undefined> {
    const deadline = Date.now() + INITIALIZATION_RETRY_MS;
    while (true) {
      try {
        const document = await this.load(context);
        if (document !== undefined || !(await this.initializationLockActive(context))) return document;
      } catch (error) {
        if (!isMissingData(error) || !(await this.initializationLockActive(context))) throw error;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw busyInitializationError();
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(INITIALIZATION_RETRY_DELAY_MS, remaining)));
    }
  }

  private async load(context: Context): Promise<StoredDocument | undefined> {
    const baseState = await safeLstat(this.base);
    if (!baseState) return undefined;
    if (!baseState.isDirectory() || baseState.isSymbolicLink()) throw new Error("Annotation storage base is not a private directory");
    assertMode(baseState.mode, 0o700, "Annotation storage base");
    assertCanonicalPath(this.base);

    const namespaceState = await safeLstat(context.directory);
    if (!namespaceState) return undefined;
    if (!namespaceState.isDirectory() || namespaceState.isSymbolicLink()) throw new Error("Annotation namespace is not a private directory");
    assertMode(namespaceState.mode, 0o700, "Annotation namespace");
    assertCanonicalPath(context.directory);
    const names = await readdir(context.directory);
    let hasCommittedDocument = false;
    for (const name of names) {
      if (name === "annotations.json") {
        hasCommittedDocument = true;
        continue;
      }
      if (ANNOTATION_TEMP.test(name)) {
        // A crashed writer may leave a private temporary behind. It can never
        // be the committed document and is ignored; symlinks are fail-closed.
        const temporaryState = await safeLstat(join(context.directory, name));
        if (temporaryState && (!temporaryState.isFile() || temporaryState.isSymbolicLink())) {
          throw new Error("Annotation temporary file is not regular");
        }
        if (temporaryState) assertMode(temporaryState.mode, 0o600, "Annotation temporary file");
        continue;
      }
      throw new Error("Unknown annotation storage file");
    }
    if (!hasCommittedDocument) throw new Error("Annotation data is missing");
    return parseStored(await readJson(context.annotationsPath, MAX_FILE_BYTES));
  }

  private async loadOrCreate(context: Context): Promise<StoredDocument> {
    const namespaceExisted = Boolean(await safeLstat(context.directory));
    await ensurePrivateDirectory(this.base, true);
    await ensurePrivateDirectory(context.directory, true);
    if (namespaceExisted) {
      const current = await this.load(context);
      if (current) return current;
      throw new Error("Annotation data is missing");
    }
    // Do not overwrite anything that appeared between the initial probe and
    // directory creation; that case is initialized/corrupt data, not empty.
    if ((await readdir(context.directory)).length !== 0) {
      throw new Error("Annotation namespace was initialized concurrently");
    }
    const document: StoredDocument = { schemaVersion: 1, repositoryId: crypto.randomUUID(), annotations: [] };
    // UUID and records are published together; no identity sidecar can mask a
    // missing committed data file as an initialized empty store.
    await this.save(context, document);
    return document;
  }

  private async save(context: Context, document: StoredDocument): Promise<void> {
    assertStored(document);
    await writeAtomic(context.annotationsPath, `${JSON.stringify(document)}\n`, MAX_FILE_BYTES);
  }

  private async initializationLockActive(context: Context): Promise<boolean> {
    const state = await safeLstat(context.lockPath);
    if (!state) return false;
    if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("Annotation lock is not private");
    assertMode(state.mode, 0o700, "Annotation lock");
    return true;
  }

  private async withExpensiveGuard<T>(operation: () => Promise<T>): Promise<T> {
    if (this.expensivePending >= 8) throw new Error("Annotation service is busy; retry later");
    this.expensivePending++;
    const queuedAt = performance.now();
    let release!: () => void;
    const previous = this.expensiveTail;
    this.expensiveTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (performance.now() - queuedAt > 10_000) throw new Error("Annotation request expired while waiting; retry later");
      return await withGitBudget(operation);
    } finally {
      this.expensivePending--;
      release();
    }
  }

  private async withLock<T>(context: Context, operation: () => Promise<T>): Promise<T> {
    await ensurePrivateDirectory(this.base, true);
    try {
      await mkdir(context.lockPath, { mode: 0o700 });
    } catch (error) {
      if (isCode(error, "EEXIST")) {
        throw new Error("Annotation storage is busy; stale locks require manual recovery");
      }
      throw error;
    }
    try {
      const lockState = await lstat(context.lockPath);
      if (!lockState.isDirectory() || lockState.isSymbolicLink()) throw new Error("Annotation lock is not private");
      assertMode(lockState.mode, 0o700, "Annotation lock");
      return await operation();
    } finally {
      await rmdir(context.lockPath);
    }
  }
}

interface Context {
  namespace: string;
  displayId: string;
  directory: string;
  annotationsPath: string;
  lockPath: string;
}

function assertCreate(input: AnnotationCreate): void {
  assertPlainObject(input, "Annotation create");
  assertKeys(input, ["ref", "path", "startLine", "endLine", "body", "category", "whitespace"]);
  assertRef(input.ref);
  assertPath(input.path);
  assertLine(input.startLine);
  assertLine(input.endLine);
  if (input.startLine > input.endLine) throw new Error("Annotation line range is invalid");
  assertBody(input.body);
  if (input.category !== undefined) assertCategory(input.category);
  if (input.whitespace !== undefined) assertWhitespace(input.whitespace);
}

function assertQuery(query: AnnotationQuery): void {
  assertPlainObject(query, "Annotation query");
  assertKeys(query, ["ref", "path", "includeResolved"]);
  if (query.ref !== undefined) assertRef(query.ref);
  if (query.path !== undefined) assertPath(query.path);
  if (query.includeResolved !== undefined && typeof query.includeResolved !== "boolean") throw new Error("Invalid includeResolved");
}

function assertUpdate(input: AnnotationUpdate): void {
  assertPlainObject(input, "Annotation update");
  assertKeys(input, ["id", "expectedRevision", "body", "category", "state"]);
  assertId(input.id);
  assertRevision(input.expectedRevision);
  if (input.body !== undefined) assertBody(input.body);
  if (input.category !== undefined) assertCategory(input.category);
  if (input.state !== undefined) assertState(input.state);
  if (input.body === undefined && input.category === undefined && input.state === undefined) throw new Error("Annotation update is empty");
}

function assertAuthor(author: AnnotationAuthor): void {
  assertPlainObject(author, "Annotation author");
  assertKeys(author, ["kind", "name", "sessionId", "model"]);
  if (author.kind !== "human" && author.kind !== "agent") throw new Error("Invalid annotation author kind");
  boundedString(author.name, "author name", 256, true);
  if (author.name.trim().length === 0) throw new Error("Invalid author name");
  if (author.sessionId !== undefined) boundedString(author.sessionId, "session id", 256, true);
  if (author.model !== undefined) boundedString(author.model, "model", 256, true);
}

function assertTarget(target: GitAnnotationTarget): void {
  assertPlainObject(target, "Git annotation target");
  assertKeys(target, ["kind", "commit", "blob", "path", "startLine", "endLine", "quote", "fingerprint", "whitespace"]);
  if (target.kind !== "git") throw new Error("Invalid annotation target kind");
  if (typeof target.commit !== "string" || typeof target.blob !== "string" ||
      !OBJECT_ID.test(target.commit) || !OBJECT_ID.test(target.blob)) throw new Error("Invalid Git object id");
  assertPath(target.path);
  assertLine(target.startLine);
  assertLine(target.endLine);
  if (target.startLine > target.endLine) throw new Error("Annotation target line range is invalid");
  assertPlainObject(target.quote, "Annotation quote");
  assertKeys(target.quote, ["exact", "prefix", "suffix"]);
  boundedString(target.quote.exact, "annotation quote", MAX_QUOTE_BYTES, false);
  boundedString(target.quote.prefix, "annotation quote prefix", MAX_QUOTE_BYTES, false);
  boundedString(target.quote.suffix, "annotation quote suffix", MAX_QUOTE_BYTES, false);
  if (typeof target.fingerprint !== "string" || !FINGERPRINT.test(target.fingerprint)) throw new Error("Invalid annotation fingerprint");
  assertWhitespace(target.whitespace);
}

function assertAnnotation(annotation: SourceAnnotation): void {
  assertPlainObject(annotation, "Annotation");
  assertKeys(annotation, ["id", "repositoryId", "revision", "createdAt", "updatedAt", "author", "body", "category", "state", "target"]);
  assertId(annotation.id);
  assertId(annotation.repositoryId);
  assertRevision(annotation.revision);
  assertTimestamp(annotation.createdAt, "createdAt");
  assertTimestamp(annotation.updatedAt, "updatedAt");
  if (Date.parse(annotation.updatedAt) < Date.parse(annotation.createdAt)) throw new Error("Annotation timestamps are out of order");
  assertAuthor(annotation.author);
  assertBody(annotation.body);
  assertCategory(annotation.category);
  assertState(annotation.state);
  assertTarget(annotation.target);
}

function assertStored(document: StoredDocument): void {
  assertPlainObject(document, "Annotation document");
  assertKeys(document, ["schemaVersion", "repositoryId", "annotations"]);
  if (document.schemaVersion !== SCHEMA_VERSION) throw new Error("Unsupported annotation schema");
  assertId(document.repositoryId);
  if (!Array.isArray(document.annotations) || document.annotations.length > MAX_RECORDS) throw new Error("Invalid annotation records");
  const ids = new Set<string>();
  for (const annotation of document.annotations) {
    assertAnnotation(annotation);
    if (ids.has(annotation.id)) throw new Error("Duplicate annotation id");
    ids.add(annotation.id);
    if (annotation.repositoryId !== document.repositoryId) throw new Error("Annotation repository id mismatch");
  }
}

function normalizeStoredIds(value: unknown): void {
  if (!isRecord(value)) return;
  lowercaseField(value, "repositoryId");
  if (Array.isArray(value.annotations)) {
    for (const annotation of value.annotations) normalizeAnnotationIds(annotation);
  }
}

function normalizeExportIds(value: unknown): void {
  if (!isRecord(value)) return;
  const repository = value.repository;
  if (isRecord(repository)) lowercaseField(repository, "id");
  if (Array.isArray(value.annotations)) {
    for (const annotation of value.annotations) normalizeAnnotationIds(annotation);
  }
}

function normalizeAnnotationIds(value: unknown): void {
  if (!isRecord(value)) return;
  lowercaseField(value, "id");
  lowercaseField(value, "repositoryId");
  const target = value.target;
  if (!isRecord(target)) return;
  lowercaseField(target, "commit");
  lowercaseField(target, "blob");
  lowercaseField(target, "fingerprint");
}

function lowercaseField(value: Record<string, unknown>, field: string): void {
  if (typeof value[field] === "string") value[field] = value[field].toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeId(value: unknown): string {
  assertId(value);
  return value.toLowerCase();
}

function parseStored(value: unknown): StoredDocument {
  normalizeStoredIds(value);
  assertStored(value as StoredDocument);
  return value as StoredDocument;
}

function assertExport(document: AnnotationExport): void {
  assertPlainObject(document, "Annotation export");
  assertKeys(document, ["schemaVersion", "repository", "annotations"]);
  if (document.schemaVersion !== SCHEMA_VERSION) throw new Error("Unsupported annotation export schema");
  assertPlainObject(document.repository, "Annotation export repository");
  assertKeys(document.repository, ["id"]);
  if (typeof document.repository.id !== "string" || !UUID.test(document.repository.id)) throw new Error("Invalid annotation repository id");
  if (!Array.isArray(document.annotations) || document.annotations.length > MAX_RECORDS) throw new Error("Invalid annotation export records");
  for (const annotation of document.annotations) assertAnnotation(annotation);
  for (const annotation of document.annotations) if (annotation.repositoryId !== document.repository.id) throw new Error("Annotation repository id mismatch");
}

function parseExport(value: unknown): AnnotationExport {
  const normalized = clone(value);
  normalizeExportIds(normalized);
  assertExport(normalized as AnnotationExport);
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, "utf8") > MAX_EXPORT_BYTES) throw new Error("Annotation import limit exceeded");
  return normalized as AnnotationExport;
}

function assertCategory(value: unknown): asserts value is AnnotationCategory {
  if (value !== "explanation" && value !== "invariant" && value !== "review" && value !== "question") throw new Error("Invalid annotation category");
}
function assertState(value: unknown): asserts value is AnnotationState {
  if (value !== "open" && value !== "resolved") throw new Error("Invalid annotation state");
}
function assertWhitespace(value: unknown): void {
  if (value !== "exact" && value !== "trim-line-end") throw new Error("Invalid annotation whitespace policy");
}
function assertRef(value: unknown): asserts value is string {
  boundedString(value, "Git ref", 512, true);
  if (typeof value !== "string" || value.includes("\0") || value.includes("\n") || value.includes("\r")) throw new Error("Invalid Git ref");
}
function assertPath(value: unknown): asserts value is string {
  boundedString(value, "annotation path", MAX_PATH_BYTES, true);
  if (typeof value !== "string" || isAbsolute(value) || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error("Invalid annotation path");
}
function assertBody(value: unknown): asserts value is string {
  boundedString(value, "annotation body", MAX_BODY_BYTES, true);
  if (value.trim().length === 0) throw new Error("Invalid annotation body");
}
function assertTimestamp(value: unknown, label: string): asserts value is string {
  boundedString(value, label, 64, true);
  if (typeof value !== "string" || new Date(value).toISOString() !== value) throw new Error(`Invalid ${label}`);
}
function assertLine(value: unknown): asserts value is number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_LINE) throw new Error("Invalid annotation line"); }
function assertRevision(value: unknown): asserts value is number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_LINE) throw new Error("Invalid annotation revision"); }
function assertId(value: unknown): asserts value is string { if (typeof value !== "string" || !UUID.test(value)) throw new Error("Invalid annotation id"); }
function boundedString(value: unknown, label: string, maxBytes: number, nonEmpty: boolean): asserts value is string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  if ((nonEmpty && value.length === 0) || Buffer.byteLength(value, "utf8") > maxBytes || value.includes("\0")) throw new Error(`Invalid ${label}`);
}
function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`Invalid ${label}`);
}
function assertKeys(value: Record<string, unknown>, allowed: string[]): void {
  const expected = new Set(allowed);
  for (const key of Object.keys(value)) if (!expected.has(key)) throw new Error(`Unknown annotation field: ${key}`);
}
function sameTarget(left: GitAnnotationTarget, right: GitAnnotationTarget): boolean { return sameJson(left, right); }
function sameJson(left: unknown, right: unknown): boolean { return stableJson(left) === stableJson(right); }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function clone<T>(value: T): T { return structuredClone(value); }
function isCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code; }
function isMissingData(error: unknown): boolean { return error instanceof Error && error.message === "Annotation data is missing"; }
function busyInitializationError(): Error { return new Error("Annotation storage is busy; retry later; stale locks require manual recovery"); }

async function safeLstat(path: string) { try { return await lstat(path); } catch (error) { if (isCode(error, "ENOENT")) return undefined; throw error; } }
async function readJson(path: string, maxBytes: number): Promise<unknown> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (isCode(error, "ENOENT")) throw new Error("Annotation data is missing");
    throw new Error("Annotation storage file cannot be opened");
  }
  try {
    const state = await handle.stat();
    if (!state.isFile()) throw new Error("Annotation storage contains a non-regular file");
    assertMode(state.mode, 0o600, "Annotation storage file");
    if (state.size > maxBytes) throw new Error("Annotation storage file is too large");
    const bytes = await readDescriptor(handle, maxBytes);
    assertCanonicalPath(dirname(path));
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("Malformed annotation UTF-8");
    }
    try { return JSON.parse(text) as unknown; } catch { throw new Error("Malformed annotation JSON"); }
  } finally {
    await handle.close();
  }
}
async function readDescriptor(handle: Awaited<ReturnType<typeof open>>, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = new Uint8Array(Math.min(64 * 1024, maxBytes + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) throw new Error("Annotation storage file is too large");
    chunks.push(chunk.subarray(0, bytesRead));
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
async function writeAtomic(path: string, content: string, maxBytes: number): Promise<void> {
  if (Buffer.byteLength(content, "utf8") > maxBytes) throw new Error("Annotation storage file is too large");
  const parent = dirname(path);
  await ensurePrivateDirectory(parent, false);
  const existing = await safeLstat(path);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error("Annotation storage file was replaced");
  if (existing) assertMode(existing.mode, 0o600, "Annotation storage file");
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    const state = await lstat(path);
    if (!state.isFile() || state.isSymbolicLink()) throw new Error("Annotation storage file was replaced");
    assertMode(state.mode, 0o600, "Annotation storage file");
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
async function ensurePrivateDirectory(path: string, create: boolean): Promise<void> {
  assertCanonicalPath(path);
  const current = await safeLstat(path);
  if (!current) {
    if (!create) throw new Error(`Missing annotation directory: ${path}`);
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  const state = await lstat(path);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("Annotation directory is not canonical");
  assertCanonicalPath(path);
  assertMode(state.mode, 0o700, "Annotation directory");
}
function assertMode(mode: number, expected: number, label: string): void { if ((mode & 0o777) !== expected) throw new Error(`${label} must have mode ${expected.toString(8)}`); }

function assertCanonicalPath(path: string): void {
  let cursor = resolve(path).startsWith(sep) ? sep : "";
  for (const part of resolve(path).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error("Annotation storage path was replaced by a symlink");
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
      break;
    }
  }
}

function canonicalPotentialPath(input: string): string {
  const requested = resolve(input);
  try {
    if (lstatSync(requested).isSymbolicLink()) throw new Error("Annotation storage path was replaced by a symlink");
  } catch (error) {
    if (!isCode(error, "ENOENT") && !isCode(error, "ENOTDIR")) throw error;
  }
  let cursor = requested;
  const missing: string[] = [];
  while (true) {
    try {
      lstatSync(cursor);
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error("Cannot resolve annotation storage directory");
      missing.push(basename(cursor));
      cursor = parent;
      continue;
    }
    // Existing dangling aliases are not missing suffixes. Resolve once, then
    // reject later replacements instead of silently rebasing the private store.
    return resolve(realpathSync(cursor), ...missing.reverse());
  }
}

function rejectGitAncestry(path: string): void {
  let cursor = path;
  while (true) {
    if (cursor === ".git" || cursor.endsWith(`${sep}.git`)) throw new Error("Annotation storage must be outside every .git ancestry");
    try {
      lstatSync(join(cursor, ".git"));
      throw new Error("Annotation storage must be outside every .git ancestry");
    } catch (error) {
      if (!isCode(error, "ENOENT") && !isCode(error, "ENOTDIR")) throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}
