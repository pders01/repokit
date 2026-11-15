/** Portable source annotations. Lines are 1-based and inclusive; Git targets are immutable. */
export type AnnotationWhitespace = "exact" | "trim-line-end";
export type AnnotationState = "open" | "resolved";
export type AnnotationCategory = "explanation" | "invariant" | "review" | "question";
export interface AnnotationAuthor {
  kind: "human" | "agent";
  name: string;
  /** Attribution, not an authenticated identity or model attestation. */
  sessionId?: string;
  model?: string;
}
export interface GitAnnotationTarget {
  kind: "git";
  commit: string;
  blob: string;
  path: string;
  startLine: number;
  endLine: number;
  quote: { exact: string; prefix: string; suffix: string };
  fingerprint: string;
  whitespace: AnnotationWhitespace;
}
export interface SourceAnnotation {
  id: string;
  repositoryId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  author: AnnotationAuthor;
  body: string;
  category: AnnotationCategory;
  state: AnnotationState;
  target: GitAnnotationTarget;
}
export interface AnnotationPlacement {
  status: "unchanged" | "moved" | "stale" | "unplaced";
  /** Resolved immutable commit, or the literal WORKTREE for an ephemeral projection. */
  ref: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  reason?: string;
}
export interface ResolvedAnnotation {
  annotation: SourceAnnotation;
  placement: AnnotationPlacement;
}
export interface AnnotationList {
  repositoryId: string;
  ref: string;
  items: ResolvedAnnotation[];
}
export interface AnnotationExport {
  schemaVersion: 1;
  repository: { id: string };
  annotations: SourceAnnotation[];
}
export interface AnnotationCreate {
  ref: string;
  path: string;
  startLine: number;
  endLine: number;
  body: string;
  category?: AnnotationCategory;
  whitespace?: AnnotationWhitespace;
}
export interface AnnotationUpdate {
  id: string;
  expectedRevision: number;
  body?: string;
  category?: AnnotationCategory;
  state?: AnnotationState;
}
export interface AnnotationQuery {
  ref?: string;
  path?: string;
  includeResolved?: boolean;
}
/**
 * UI/editor-facing operations. The host binds repository scope and author
 * attribution; neither transport session routing nor authentication lives here.
 */
export interface AnnotationClient {
  list(query: AnnotationQuery): Promise<AnnotationList>;
  create(input: AnnotationCreate): Promise<SourceAnnotation>;
  update(input: AnnotationUpdate): Promise<SourceAnnotation>;
  delete(input: { id: string; expectedRevision: number }): Promise<{ deleted: true }>;
}
