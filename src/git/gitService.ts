import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BranchInfo, GitService, RepoState, StashEntry, WorktreeInfo } from './types';
import {
  FOR_EACH_REF_FORMAT,
  parseForEachRef,
  parseReflogCheckouts,
  parseStashList,
  parseStatusV2,
  parseWorktreesPorcelain,
} from './parse';

type Op = NonNullable<RepoState['operationInProgress']>;

const MAX_BUFFER = 50 * 1024 * 1024;

/** Runs git in `cwd`; resolves stdout, rejects with Error(stderr.trim()). */
export function runGit(cwd: string, args: string[], extraEnv?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        maxBuffer: MAX_BUFFER,
        env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', ...extraEnv },
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || '').toString().trim() || (stdout || '').toString().trim() || err.message;
          reject(new Error(msg));
        } else {
          resolve(stdout.toString());
        }
      },
    );
  });
}

function realpath(p: string): string {
  try { return fs.realpathSync.native(p); } catch { return p; }
}

export class CliGitService implements GitService {
  exec(root: string, args: string[]): Promise<string> {
    return runGit(root, args);
  }

  private async tryExec(root: string, args: string[]): Promise<string | undefined> {
    try { return await runGit(root, args); } catch { return undefined; }
  }

  async getRepoRoot(): Promise<string | undefined> {
    const candidates: string[] = [];
    const doc = vscode.window.activeTextEditor?.document;
    if (doc && doc.uri.scheme === 'file') candidates.push(path.dirname(doc.uri.fsPath));
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      if (f.uri.scheme === 'file') candidates.push(f.uri.fsPath);
    }
    for (const dir of candidates) {
      if (!fs.existsSync(dir)) continue;
      const out = await this.tryExec(dir, ['rev-parse', '--show-toplevel']);
      if (out && out.trim()) return path.normalize(out.trim());
    }
    return undefined;
  }

  async getState(root: string): Promise<RepoState> {
    const [statusOut, gitPaths, stashOut] = await Promise.all([
      runGit(root, ['status', '--porcelain=v2', '--branch']),
      runGit(root, [
        'rev-parse',
        '--git-path', 'MERGE_HEAD',
        '--git-path', 'rebase-merge',
        '--git-path', 'rebase-apply',
        '--git-path', 'CHERRY_PICK_HEAD',
        '--git-path', 'REVERT_HEAD',
      ]),
      this.tryExec(root, ['stash', 'list', '-n', '1']),
    ]);
    const st = parseStatusV2(statusOut);
    const [mergeHead, rebaseMerge, rebaseApply, cherry, revert] = gitPaths
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((p) => fs.existsSync(path.resolve(root, p)));

    let op: Op | undefined;
    if (rebaseMerge || rebaseApply) op = 'rebase';
    else if (mergeHead) op = 'merge';
    else if (cherry) op = 'cherry-pick';
    else if (revert) op = 'revert';

    const state: RepoState = {
      root,
      currentBranch: st.head,
      detachedAt: st.head ? undefined : st.oid?.slice(0, 8),
      hasChanges: st.hasChanges,
      hasStagedChanges: st.hasStagedChanges,
      hasStash: !!(stashOut && stashOut.trim()),
      operationInProgress: op,
    };

    const rel = this.activeFileRelative(root);
    if (rel !== undefined) {
      const tracked = await this.tryExec(root, ['ls-files', '--error-unmatch', '--', rel]);
      state.activeFileTracked = tracked !== undefined;
      state.activeFileModified = st.changedPaths.has(rel) && !st.untrackedPaths.has(rel);
    }
    return state;
  }

  /** Active editor file path relative to root (forward slashes), or undefined if none / outside root. */
  private activeFileRelative(root: string): string | undefined {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.uri.scheme !== 'file') return undefined;
    const rel = path.relative(realpath(root), realpath(doc.uri.fsPath));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    return rel.split(path.sep).join('/');
  }

  async listBranches(root: string): Promise<BranchInfo[]> {
    const out = await runGit(root, ['for-each-ref', `--format=${FOR_EACH_REF_FORMAT}`, 'refs/heads', 'refs/remotes']);
    return parseForEachRef(out);
  }

  async listWorktrees(root: string): Promise<WorktreeInfo[]> {
    return parseWorktreesPorcelain(await runGit(root, ['worktree', 'list', '--porcelain']));
  }

  async listStashes(root: string): Promise<StashEntry[]> {
    return parseStashList(await runGit(root, ['stash', 'list', '--format=%gd%x1f%gs']));
  }

  async recentBranches(root: string, limit: number): Promise<string[]> {
    const [reflog, heads, current] = await Promise.all([
      this.tryExec(root, ['reflog', '--format=%gs', '-n', '200']),
      runGit(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
      this.currentBranch(root),
    ]);
    if (!reflog) return [];
    const existing = new Set(heads.split('\n').map((s) => s.trim()).filter(Boolean));
    return parseReflogCheckouts(reflog)
      .filter((b) => b !== current && existing.has(b))
      .slice(0, Math.max(0, limit));
  }

  /** Extra: current branch name, or undefined if detached. */
  async currentBranch(root: string): Promise<string | undefined> {
    const out = await this.tryExec(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return out?.trim() || undefined;
  }

  /** Extra: upstream config of a local branch: remote name and remote branch name (without refs/heads/). */
  async getUpstreamConfig(root: string, branch: string): Promise<{ remote: string; branch: string } | undefined> {
    const remote = (await this.tryExec(root, ['config', '--get', `branch.${branch}.remote`]))?.trim();
    const merge = (await this.tryExec(root, ['config', '--get', `branch.${branch}.merge`]))?.trim();
    if (!remote || !merge) return undefined;
    return { remote, branch: merge.replace(/^refs\/heads\//, '') };
  }

  /** Extra: list remote names. */
  async listRemotes(root: string): Promise<string[]> {
    return (await runGit(root, ['remote'])).split('\n').map((s) => s.trim()).filter(Boolean);
  }

  private async defaultRemote(root: string, branch: string): Promise<string> {
    const pushRemote = (await this.tryExec(root, ['config', '--get', `branch.${branch}.pushRemote`]))?.trim()
      || (await this.tryExec(root, ['config', '--get', 'remote.pushDefault']))?.trim();
    if (pushRemote) return pushRemote;
    const remotes = await this.listRemotes(root);
    if (remotes.includes('origin') || remotes.length === 0) return 'origin';
    return remotes[0];
  }

  async checkout(root: string, ref: string): Promise<void> {
    await runGit(root, ['checkout', ref]);
  }

  async checkoutRemote(root: string, remoteBranch: string, localName: string): Promise<void> {
    await runGit(root, ['checkout', '-b', localName, '--track', remoteBranch]);
  }

  async createBranch(root: string, name: string, from: string, checkout: boolean): Promise<void> {
    if (checkout) await runGit(root, ['checkout', '-b', name, from]);
    else await runGit(root, ['branch', name, from]);
  }

  async renameBranch(root: string, oldName: string, newName: string): Promise<void> {
    await runGit(root, ['branch', '-m', oldName, newName]);
  }

  async deleteBranch(root: string, name: string, force: boolean): Promise<void> {
    await runGit(root, ['branch', force ? '-D' : '-d', name]);
  }

  async deleteRemoteBranch(root: string, remote: string, name: string): Promise<void> {
    // Accept both "feature" and "origin/feature".
    const short = name.startsWith(remote + '/') ? name.slice(remote.length + 1) : name;
    await runGit(root, ['push', remote, '--delete', short]);
  }

  async merge(root: string, ref: string): Promise<void> {
    await runGit(root, ['merge', '--no-edit', ref]);
  }

  async rebase(root: string, onto: string): Promise<void> {
    await runGit(root, ['rebase', onto], { GIT_EDITOR: 'true' });
  }

  async checkoutAndRebaseOntoCurrent(root: string, branch: string): Promise<void> {
    const current = await this.currentBranch(root);
    if (!current) throw new Error('Cannot rebase onto current: HEAD is detached');
    // `git rebase <upstream> <branch>` checks out <branch> first, then rebases it.
    await runGit(root, ['rebase', current, branch], { GIT_EDITOR: 'true' });
  }

  async updateBranch(root: string, branch: BranchInfo): Promise<void> {
    if (branch.kind === 'remote') {
      const remote = branch.remote ?? branch.name.split('/')[0];
      const rb = branch.name.slice(remote.length + 1);
      await runGit(root, ['fetch', remote, rb]);
      return;
    }
    const current = await this.currentBranch(root);
    if (branch.isCurrent || branch.name === current) {
      await runGit(root, ['pull'], { GIT_EDITOR: 'true' });
      return;
    }
    const up = await this.getUpstreamConfig(root, branch.name);
    if (!up) throw new Error(`Branch '${branch.name}' has no upstream branch`);
    if (up.remote === '.') {
      // Tracking a local branch: fast-forward only.
      await runGit(root, ['fetch', '.', `refs/heads/${up.branch}:refs/heads/${branch.name}`]);
      return;
    }
    await runGit(root, ['fetch', up.remote, `refs/heads/${up.branch}:refs/heads/${branch.name}`]);
  }

  async updateProject(root: string): Promise<void> {
    await runGit(root, ['fetch', '--all', '--prune']);
    if (await this.currentBranch(root)) {
      await runGit(root, ['pull'], { GIT_EDITOR: 'true' });
    }
  }

  async fetch(root: string): Promise<void> {
    await runGit(root, ['fetch', '--all', '--prune']);
  }

  async push(root: string, branch: string, opts?: { setUpstream?: boolean; force?: boolean }): Promise<void> {
    const force = opts?.force ? ['--force-with-lease'] : [];
    const up = await this.getUpstreamConfig(root, branch);
    if (!up || opts?.setUpstream) {
      const remote = up && up.remote !== '.' ? up.remote : await this.defaultRemote(root, branch);
      await runGit(root, ['push', ...force, '-u', remote, branch]);
      return;
    }
    await runGit(root, ['push', ...force, up.remote, `refs/heads/${branch}:refs/heads/${up.branch}`]);
  }

  async stash(root: string, message?: string, includeUntracked?: boolean): Promise<void> {
    const args = ['stash', 'push'];
    if (includeUntracked) args.push('--include-untracked');
    if (message) args.push('-m', message);
    await runGit(root, args);
  }

  async stashPop(root: string, index: number): Promise<void> {
    await runGit(root, ['stash', 'pop', `stash@{${index}}`]);
  }

  async stashApply(root: string, index: number): Promise<void> {
    await runGit(root, ['stash', 'apply', `stash@{${index}}`]);
  }

  async stashDrop(root: string, index: number): Promise<void> {
    await runGit(root, ['stash', 'drop', `stash@{${index}}`]);
  }

  async addWorktree(root: string, wtPath: string, branch: string, newBranch?: string): Promise<void> {
    if (newBranch) await runGit(root, ['worktree', 'add', '-b', newBranch, wtPath, branch]);
    else await runGit(root, ['worktree', 'add', wtPath, branch]);
  }

  async removeWorktree(root: string, wtPath: string): Promise<void> {
    await runGit(root, ['worktree', 'remove', wtPath]);
  }

  async diffNames(root: string, ref: string): Promise<string[]> {
    const out = await runGit(root, ['diff', '--name-only', ref, '--']);
    return out.split('\n').filter(Boolean);
  }

  async logBetween(root: string, a: string, b: string): Promise<string[]> {
    const out = await runGit(root, ['log', '--oneline', '--no-decorate', `${b}..${a}`, '--']);
    return out.split('\n').filter(Boolean);
  }

  async abortOperation(root: string, op: Op): Promise<void> {
    await runGit(root, [op, '--abort']);
  }

  async continueOperation(root: string, op: Op): Promise<void> {
    await runGit(root, [op, '--continue'], { GIT_EDITOR: 'true' });
  }
}
