// Shared contract between the git layer and the popups. Do not change without coordinating.

export interface BranchInfo {
  /** Short name, e.g. "feature/faster-build" or "origin/feature/faster-build" for remotes */
  name: string;
  /** Full ref, e.g. "refs/heads/feature/faster-build" */
  ref: string;
  kind: 'local' | 'remote';
  /** For remote branches: remote name ("origin") */
  remote?: string;
  isCurrent: boolean;
  /** Upstream short name, e.g. "origin/feature/faster-build" */
  upstream?: string;
  ahead: number;
  behind: number;
  /** Abbreviated commit sha */
  commit: string;
  /** Unix seconds of last commit, used for sorting "recent" */
  committerDate: number;
}

export interface RepoState {
  root: string;
  currentBranch?: string;   // undefined when detached HEAD
  detachedAt?: string;      // sha if detached
  hasChanges: boolean;      // working tree or index dirty
  hasStagedChanges: boolean;
  hasStash: boolean;
  /** merge / rebase / cherry-pick in progress */
  operationInProgress?: 'merge' | 'rebase' | 'cherry-pick' | 'revert';
  activeFileTracked?: boolean; // the active editor file is tracked by git
  activeFileModified?: boolean;
}

export interface WorktreeInfo { path: string; branch?: string; head: string; isMain: boolean; }

export interface StashEntry { index: number; ref: string; message: string; }

export interface GitService {
  /** Repo for the active editor, or the first repo in the workspace. Undefined if none. */
  getRepoRoot(): Promise<string | undefined>;
  getState(root: string): Promise<RepoState>;
  listBranches(root: string): Promise<BranchInfo[]>;
  listWorktrees(root: string): Promise<WorktreeInfo[]>;
  listStashes(root: string): Promise<StashEntry[]>;
  /** Most recently checked-out branch names from reflog, newest first, excluding current */
  recentBranches(root: string, limit: number): Promise<string[]>;

  checkout(root: string, ref: string): Promise<void>;
  /** Checkout remote branch as new local tracking branch */
  checkoutRemote(root: string, remoteBranch: string, localName: string): Promise<void>;
  createBranch(root: string, name: string, from: string, checkout: boolean): Promise<void>;
  renameBranch(root: string, oldName: string, newName: string): Promise<void>;
  deleteBranch(root: string, name: string, force: boolean): Promise<void>;
  deleteRemoteBranch(root: string, remote: string, name: string): Promise<void>;
  merge(root: string, ref: string): Promise<void>;
  rebase(root: string, onto: string): Promise<void>;
  /** checkout target then rebase it onto current (IntelliJ "Checkout and Rebase onto Current") */
  checkoutAndRebaseOntoCurrent(root: string, branch: string): Promise<void>;
  /** fast-forward / pull a branch; for non-current branches uses `git fetch remote src:dst` */
  updateBranch(root: string, branch: BranchInfo): Promise<void>;
  /** Update Project: fetch all + pull current (rebase/merge per git config) */
  updateProject(root: string): Promise<void>;
  fetch(root: string): Promise<void>;
  push(root: string, branch: string, opts?: { setUpstream?: boolean; force?: boolean }): Promise<void>;
  stash(root: string, message?: string, includeUntracked?: boolean): Promise<void>;
  stashPop(root: string, index: number): Promise<void>;
  stashApply(root: string, index: number): Promise<void>;
  stashDrop(root: string, index: number): Promise<void>;
  addWorktree(root: string, path: string, branch: string, newBranch?: string): Promise<void>;
  removeWorktree(root: string, path: string): Promise<void>;
  /** files changed between ref and working tree */
  diffNames(root: string, ref: string): Promise<string[]>;
  /** commits in `a` not in `b` (one-line) */
  logBetween(root: string, a: string, b: string): Promise<string[]>;
  abortOperation(root: string, op: NonNullable<RepoState['operationInProgress']>): Promise<void>;
  continueOperation(root: string, op: NonNullable<RepoState['operationInProgress']>): Promise<void>;
  /** raw escape hatch */
  exec(root: string, args: string[]): Promise<string>;
}
