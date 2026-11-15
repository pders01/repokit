/** Neutral structural contracts; no transport, agent or workspace dependencies. */
export interface RepositoryDiff {
  rawDiff: string;
  truncated: boolean;
}

export interface RepositoryInfo {
  root: string;
  branch: string;
  defaultBranch: string;
  head: string;
  shortHead: string;
}

export interface RepositoryRef {
  name: string;
  kind: "branch" | "tag";
  commit: string;
  committedAt: number;
  subject: string;
}

export interface RepositoryTreeEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "submodule";
  size: number;
  objectId: string;
}

export interface RepositoryFile {
  path: string;
  ref: string;
  content: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  objectId: string;
  language?: string;
}

export interface RepositoryCommit {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  authoredAt: number;
  parentShas: string[];
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface RepositoryChangedFile {
  path: string;
  fromPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "type-changed" | "unknown";
  additions: number;
  deletions: number;
}

export interface RepositoryComparison {
  baseRef: string;
  headRef: string;
  files: RepositoryChangedFile[];
  additions: number;
  deletions: number;
}

export interface RepositoryBlameLine {
  line: number;
  text: string;
  commit: string;
  authorName: string;
  authorEmail: string;
  authoredAt: number;
  summary: string;
}

export interface KnowledgeDocument {
  authority: "canonical";
  path: string;
  title: string;
  preview: string;
  objectId: string;
  modified: boolean;
}

/** Markdown discovered in a pinned commit, never a mutable filesystem preview. */
export interface RepositoryMarkdownDocument extends KnowledgeDocument {
  ref: string;
}

export interface RepositoryFileSearch {
  ref: string;
  paths: string[];
  truncated: boolean;
  incomplete: boolean;
}
