/** Minimum structural inputs: host protocols and live sessions stay outside. */
export type ChangeBucket = "staged" | "unstaged" | "untracked" | "conflicted";

export interface DocumentInput {
  authority: "canonical";
  path: string;
  title: string;
  preview: string;
  objectId: string;
}

export interface ChangeInput {
  path: string;
  fromPath?: string;
  status: string;
  bucket: ChangeBucket;
  additions?: number;
  deletions?: number;
}

export interface BranchInput {
  branch: string;
  head: string;
  targetBranch: string;
  integrated: boolean;
  ahead: number;
  behind: number;
  error?: string;
}

export interface CommitInput {
  sha: string;
  subject: string;
  body: string;
  authoredAt: number;
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface ArtifactInput {
  toolCallId: string;
  path: string;
  capturedAt: number;
  diffs: readonly { path: string; bucket: ChangeBucket }[];
  error?: string;
}
