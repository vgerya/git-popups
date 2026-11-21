// Shared test helpers: build real git repositories in a temp dir. No vscode import.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let envReady = false;

/** Isolate git from the user's/system config and give it a deterministic identity. */
export function setupGitEnv(): void {
  if (envReady) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-gitcfg-'));
  const cfg = path.join(dir, 'gitconfig');
  fs.writeFileSync(cfg, [
    '[user]', '\tname = Test User', '\temail = test@example.com',
    '[init]', '\tdefaultBranch = main',
    '[commit]', '\tgpgsign = false',
    '[advice]', '\tdetachedHead = false',
    '[pull]', '\trebase = false',
    '',
  ].join('\n'));
  process.env.GIT_CONFIG_GLOBAL = cfg;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_TERMINAL_PROMPT = '0';
  delete process.env.GIT_DIR;
  delete process.env.GIT_WORK_TREE;
  envReady = true;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function tmpDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function write(repo: string, rel: string, content: string): void {
  const p = path.join(repo, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

export function commit(repo: string, rel: string, content: string, msg: string): void {
  write(repo, rel, content);
  git(repo, 'add', '--', rel);
  git(repo, 'commit', '-q', '-m', msg);
}

export function rmrf(p: string | undefined): void {
  if (p) fs.rmSync(p, { recursive: true, force: true });
}

export interface Fixture {
  base: string;
  /** bare remote */
  remote: string;
  /** "upstream" working clone used to push new commits to the remote */
  other: string;
  /** the repo under test */
  repo: string;
  /** a linked worktree of `repo` */
  worktree: string;
}

/**
 * Builds:
 *  - bare remote with branches main, develop, feature/remote-only
 *  - repo = clone; main tracks origin/main and is ahead 2 / behind 1;
 *    develop tracks origin/develop (in sync); local-only feature/x, feature/nested/y, bugfix
 *  - reflog of checkouts: main -> feature/x -> bugfix -> develop -> feature/x -> main
 *  - linked worktree on branch `wt-branch`
 *  - (no stash, clean tree; individual tests add those)
 */
export function buildFixture(): Fixture {
  setupGitEnv();
  const base = tmpDir('gp-fixture-');
  const remote = path.join(base, 'remote.git');
  const other = path.join(base, 'other');
  const repo = path.join(base, 'repo');
  const worktree = path.join(base, 'wt');

  git(base, 'init', '-q', '--bare', remote);
  git(base, 'init', '-q', other);
  commit(other, 'README.md', 'hello\n', 'initial');
  git(other, 'remote', 'add', 'origin', remote);
  git(other, 'push', '-q', '-u', 'origin', 'main');
  git(other, 'checkout', '-q', '-b', 'develop');
  commit(other, 'dev.txt', 'dev\n', 'dev commit');
  git(other, 'push', '-q', '-u', 'origin', 'develop');
  git(other, 'checkout', '-q', '-b', 'feature/remote-only');
  commit(other, 'ro.txt', 'ro\n', 'remote only');
  git(other, 'push', '-q', '-u', 'origin', 'feature/remote-only');
  git(other, 'checkout', '-q', 'main');

  git(base, 'clone', '-q', remote, repo);
  git(repo, 'checkout', '-q', 'develop'); // creates tracking branch develop
  git(repo, 'checkout', '-q', 'main');

  // remote main moves ahead by 1 commit
  commit(other, 'remote.txt', 'remote\n', 'remote change on main');
  git(other, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');

  // local main gets 2 commits
  commit(repo, 'a.txt', 'a\n', 'local a');
  commit(repo, 'b.txt', 'b\n', 'local b');

  git(repo, 'branch', 'feature/x');
  git(repo, 'branch', 'feature/nested/y');
  git(repo, 'branch', 'bugfix');
  git(repo, 'branch', 'wt-branch');

  git(repo, 'checkout', '-q', 'feature/x');
  git(repo, 'checkout', '-q', 'bugfix');
  git(repo, 'checkout', '-q', 'develop');
  git(repo, 'checkout', '-q', 'feature/x');
  git(repo, 'checkout', '-q', 'main');

  git(repo, 'worktree', 'add', '-q', worktree, 'wt-branch');
  return { base, remote, other, repo, worktree };
}
