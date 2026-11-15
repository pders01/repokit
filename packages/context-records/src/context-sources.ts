import type {
  ChangeBucket,
  DocumentInput as KnowledgeDocument,
  BranchInput as ManagedWorktreeStatus,
  CommitInput as RepositoryCommit,
  ArtifactInput as ToolArtifact,
  ChangeInput as WorkspaceFile,
} from "./inputs.js";

export interface SessionContextSource {
  kind: "session";
  sessionId: string;
  access: "app-owned" | "external";
  revision: string;
  entryId?: string;
}

export interface DocumentContextSource {
  kind: "document";
  path: string;
  objectId: string;
  sessionId?: string;
}

export interface ChangeContextSource {
  kind: "change";
  path: string;
  bucket: ChangeBucket;
  sessionId?: string;
  head?: string;
}

export interface BranchContextSource {
  kind: "branch";
  branch: string;
  head: string;
  targetBranch: string;
}

export interface CommitContextSource {
  kind: "commit";
  commit: string;
  path?: string;
}

export interface ArtifactContextSource {
  kind: "artifact";
  sessionId: string;
  toolCallId: string;
  path: string;
}

export type ContextSource =
  | SessionContextSource
  | DocumentContextSource
  | ChangeContextSource
  | BranchContextSource
  | CommitContextSource
  | ArtifactContextSource;

export type ContextStatementRole =
  | "summary"
  | "outcome"
  | "next-step"
  | "scope"
  | "status"
  | "detail";

export interface ContextStatement {
  role: ContextStatementRole;
  text: string;
  sources: readonly [ContextSource, ...ContextSource[]];
}

export type ContextProvenance = "canonical" | "derived" | "observed";
export type ContextFreshness = "current" | "stale" | "immutable" | "snapshot";

interface ContextRecordBase<S extends ContextSource> {
  id: string;
  source: S;
  provenance: ContextProvenance;
  freshness: ContextFreshness;
  title: ContextStatement;
  statements: readonly ContextStatement[];
  updatedAt: number;
}

export interface SessionContextRecord extends ContextRecordBase<SessionContextSource> {
  category: "session-outcome";
}

export interface DocumentContextRecord extends ContextRecordBase<DocumentContextSource> {
  category: "document";
}

export interface ChangeContextRecord extends ContextRecordBase<ChangeContextSource> {
  category: "change";
}

export interface BranchContextRecord extends ContextRecordBase<BranchContextSource> {
  category: "branch";
}

export interface CommitContextRecord extends ContextRecordBase<CommitContextSource> {
  category: "commit";
}

export interface ArtifactContextRecord extends ContextRecordBase<ArtifactContextSource> {
  category: "artifact";
}

export type ContextRecord =
  | SessionContextRecord
  | DocumentContextRecord
  | ChangeContextRecord
  | BranchContextRecord
  | CommitContextRecord
  | ArtifactContextRecord;

export function documentContext(
  document: KnowledgeDocument,
  sessionId?: string,
): DocumentContextRecord {
  if (document.authority !== "canonical") {
    throw new Error("Knowledge document is not a canonical tracked source");
  }
  const source: DocumentContextSource = {
    kind: "document",
    path: document.path,
    objectId: document.objectId,
    ...(sessionId ? { sessionId } : {}),
  };
  return {
    id: `document:${contextSourceKey(source)}`,
    category: "document",
    source,
    provenance: "canonical",
    freshness: "current",
    title: linkedStatement("summary", document.title, source),
    statements: document.preview
      ? [linkedStatement("summary", document.preview, source)]
      : [],
    updatedAt: 0,
  };
}

export function changeContext(
  file: WorkspaceFile,
  scope: { sessionId?: string; head?: string; updatedAt?: number } = {},
): ChangeContextRecord {
  const source: ChangeContextSource = {
    kind: "change",
    path: file.path,
    bucket: file.bucket,
    ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
    ...(scope.head ? { head: scope.head } : {}),
  };
  const counts = changeCounts(file);
  return {
    id: `change:${contextSourceKey(source)}`,
    category: "change",
    source,
    provenance: "observed",
    freshness: "snapshot",
    title: linkedStatement("summary", file.path, source),
    statements: [
      linkedStatement("status", `${file.status}${counts}`, source),
      ...(file.fromPath
        ? [linkedStatement("detail", `Renamed from ${file.fromPath}`, source)]
        : []),
    ],
    updatedAt: scope.updatedAt ?? 0,
  };
}

export function branchContext(
  status: ManagedWorktreeStatus,
  updatedAt = 0,
): BranchContextRecord {
  const source: BranchContextSource = {
    kind: "branch",
    branch: status.branch,
    head: status.head,
    targetBranch: status.targetBranch,
  };
  const state = status.integrated
    ? `Integrated into ${status.targetBranch}`
    : `${status.ahead} ahead, ${status.behind} behind ${status.targetBranch}`;
  return {
    id: `branch:${contextSourceKey(source)}`,
    category: "branch",
    source,
    provenance: "observed",
    freshness: "snapshot",
    title: linkedStatement("summary", status.branch, source),
    statements: [
      linkedStatement("status", state, source),
      ...(status.error ? [linkedStatement("detail", status.error, source)] : []),
    ],
    updatedAt,
  };
}

export function commitContext(
  commit: RepositoryCommit,
  path?: string,
): CommitContextRecord {
  const source: CommitContextSource = {
    kind: "commit",
    commit: commit.sha,
    ...(path ? { path } : {}),
  };
  const changeSummary = `${commit.filesChanged} files, +${commit.additions}, -${commit.deletions}`;
  return {
    id: `commit:${contextSourceKey(source)}`,
    category: "commit",
    source,
    provenance: "canonical",
    freshness: "immutable",
    title: linkedStatement("summary", commit.subject, source),
    statements: [
      ...(commit.body ? [linkedStatement("detail", commit.body, source)] : []),
      linkedStatement("status", changeSummary, source),
    ],
    updatedAt: commit.authoredAt * 1_000,
  };
}

export function artifactContext(
  artifact: ToolArtifact,
  sessionId: string,
): ArtifactContextRecord {
  const source: ArtifactContextSource = {
    kind: "artifact",
    sessionId,
    toolCallId: artifact.toolCallId,
    path: artifact.path,
  };
  return {
    id: `artifact:${contextSourceKey(source)}`,
    category: "artifact",
    source,
    provenance: "observed",
    freshness: "snapshot",
    title: linkedStatement("summary", artifact.path, source),
    statements: [
      ...artifact.diffs.map((diff) => linkedStatement(
        "scope",
        diff.path,
        source,
        {
          kind: "change",
          sessionId,
          path: diff.path,
          bucket: diff.bucket,
        },
      )),
      ...(artifact.error ? [linkedStatement("status", artifact.error, source)] : []),
    ],
    updatedAt: artifact.capturedAt,
  };
}

export function linkedStatement(
  role: ContextStatementRole,
  text: string,
  source: ContextSource,
  ...additionalSources: ContextSource[]
): ContextStatement {
  return { role, text, sources: [source, ...additionalSources] };
}

export function contextSourceKey(source: ContextSource): string {
  switch (source.kind) {
    case "session":
      return joinKey(source.kind, source.access, source.sessionId, source.entryId);
    case "document":
      return joinKey(source.kind, source.sessionId, source.path);
    case "change":
      return joinKey(source.kind, source.sessionId, source.bucket, source.path);
    case "branch":
      return joinKey(source.kind, source.branch);
    case "commit":
      return joinKey(source.kind, source.commit, source.path);
    case "artifact":
      return joinKey(source.kind, source.sessionId, source.toolCallId, source.path);
    default:
      return assertNever(source);
  }
}

export function contextSearchText(record: ContextRecord): string {
  return [
    record.title.text,
    ...record.statements.map((statement) => statement.text),
    contextSourceSearchText(record.source),
  ]
    .join(" ")
    .toLocaleLowerCase();
}

function contextSourceSearchText(source: ContextSource): string {
  switch (source.kind) {
    case "session":
      return `${source.sessionId} ${source.entryId ?? ""}`;
    case "document":
      return `${source.path} ${source.objectId}`;
    case "change":
      return `${source.path} ${source.bucket} ${source.head ?? ""}`;
    case "branch":
      return `${source.branch} ${source.head} ${source.targetBranch}`;
    case "commit":
      return `${source.commit} ${source.path ?? ""}`;
    case "artifact":
      return `${source.sessionId} ${source.toolCallId} ${source.path}`;
    default:
      return assertNever(source);
  }
}

function changeCounts(file: WorkspaceFile): string {
  const additions = file.additions ?? 0;
  const deletions = file.deletions ?? 0;
  return additions || deletions ? ` · +${additions} -${deletions}` : "";
}

function joinKey(...parts: Array<string | undefined>): string {
  return parts
    .filter((part): part is string => part !== undefined && part !== "")
    .map((part) => encodeURIComponent(part))
    .join(":");
}

function assertNever(value: never): never {
  throw new Error(`Unhandled context source: ${String(value)}`);
}
