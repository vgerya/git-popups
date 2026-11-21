// Integration tests for CliGitService against real temp repositories.
// gitService.ts imports 'vscode', which is not available under plain mocha, so a minimal
// fake 'vscode' module is registered before the service is required.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { BranchInfo, GitService } from '../git/types';
import { Fixture, buildFixture, commit, git, rmrf, write } from './helpers';

// ---- fake vscode -----------------------------------------------------------------------------
interface FakeUri { fsPath: string; scheme: string }
const fakeVscode = {
  window: { activeTextEditor: undefined as undefined | { document: { uri: FakeUri } } },
  workspace: { workspaceFolders: [] as { uri: FakeUri }[] },
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module');
const FAKE_ID = '__fake_vscode__';
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') return FAKE_ID;
  return origResolve.call(this, request, ...rest);
};
require.cache[FAKE_ID] = { id: FAKE_ID, filename: FAKE_ID, loaded: true, exports: fakeVscode } as unknown as NodeModule;

const fileUri = (p: string): FakeUri => ({ fsPath: p, scheme: 'file' });
function setWorkspace(root: string, activeFile?: string) {
  fakeVscode.workspace.workspaceFolders = [{ uri: fileUri(root) }];
  fakeVscode.window.activeTextEditor = activeFile ? { document: { uri: fileUri(activeFile) } } : undefined;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CliGitService } = require('../git/gitService') as { CliGitService: new () => GitService };

// ---- tests -----------------------------------------------------------------------------------
describe('CliGitService (integration)', function () {
  this.timeout(30000);
  let fx: Fixture;
  let svc: GitService;
  let repo: string;

  beforeEach(() => {
    fx = buildFixture();
    repo = fx.repo;
    setWorkspace(repo);
    svc = new CliGitService();
  });
  afterEach(() => rmrf(fx?.base));

  const branch = async (name: string): Promise<BranchInfo | undefined> =>
    (await svc.listBranches(repo)).find(b => b.name === name);

  describe('getRepoRoot', () => {
    it('resolves the workspace folder repo', async () => {
      assert.strictEqual(await svc.getRepoRoot(), repo);
    });
    it('prefers the active editor file repo', async () => {
      setWorkspace(repo, path.join(fx.worktree, 'README.md'));
      assert.strictEqual(await svc.getRepoRoot(), fx.worktree);
    });
    it('resolves from a subdirectory', async () => {
      fs.mkdirSync(path.join(repo, 'sub', 'deep'), { recursive: true });
      setWorkspace(path.join(repo, 'sub', 'deep'));
      assert.strictEqual(await svc.getRepoRoot(), repo);
    });
    it('returns undefined outside a repo', async () => {
      const d = path.join(fx.base, 'not-a-repo');
      fs.mkdirSync(d);
      setWorkspace(d);
      assert.strictEqual(await svc.getRepoRoot(), undefined);
    });
  });

  describe('listBranches', () => {
    it('returns local + remote branches with tracking info', async () => {
      const bs = await svc.listBranches(repo);
      const locals = bs.filter(b => b.kind === 'local').map(b => b.name).sort();
      const remotes = bs.filter(b => b.kind === 'remote').map(b => b.name).sort();
      assert.deepStrictEqual(locals, ['bugfix', 'develop', 'feature/nested/y', 'feature/x', 'main', 'wt-branch']);
      assert.deepStrictEqual(remotes, ['origin/develop', 'origin/feature/remote-only', 'origin/main']);
      const main = bs.find(b => b.name === 'main')!;
      assert.strictEqual(main.isCurrent, true);
      assert.strictEqual(main.upstream, 'origin/main');
      assert.strictEqual(main.ahead, 2);
      assert.strictEqual(main.behind, 1);
    });
  });

  describe('getState', () => {
    it('clean repo', async () => {
      const s = await svc.getState(repo);
      assert.strictEqual(s.root, repo);
      assert.strictEqual(s.currentBranch, 'main');
      assert.strictEqual(s.detachedAt, undefined);
      assert.strictEqual(s.hasChanges, false);
      assert.strictEqual(s.hasStagedChanges, false);
      assert.strictEqual(s.hasStash, false);
      assert.strictEqual(s.operationInProgress, undefined);
      assert.strictEqual(s.activeFileTracked, undefined);
    });

    it('dirty / staged / active file flags', async () => {
      write(repo, 'a.txt', 'modified\n');
      setWorkspace(repo, path.join(repo, 'a.txt'));
      let s = await svc.getState(repo);
      assert.strictEqual(s.hasChanges, true);
      assert.strictEqual(s.hasStagedChanges, false);
      assert.strictEqual(s.activeFileTracked, true);
      assert.strictEqual(s.activeFileModified, true);

      git(repo, 'add', 'a.txt');
      s = await svc.getState(repo);
      assert.strictEqual(s.hasStagedChanges, true);

      write(repo, 'untracked.txt', 'x\n');
      setWorkspace(repo, path.join(repo, 'untracked.txt'));
      s = await svc.getState(repo);
      assert.strictEqual(s.activeFileTracked, false);
      assert.strictEqual(s.activeFileModified, false);

      setWorkspace(repo, path.join(repo, 'README.md'));
      s = await svc.getState(repo);
      assert.strictEqual(s.activeFileTracked, true);
      assert.strictEqual(s.activeFileModified, false);
    });

    it('detached HEAD', async () => {
      git(repo, 'checkout', '-q', '--detach', 'HEAD~1');
      const s = await svc.getState(repo);
      assert.strictEqual(s.currentBranch, undefined);
      assert.ok(s.detachedAt && git(repo, 'rev-parse', 'HEAD').startsWith(s.detachedAt), `detachedAt=${s.detachedAt}`);
    });

    it('merge in progress -> operationInProgress=merge, abortOperation clears it', async () => {
      git(repo, 'checkout', '-q', '-b', 'm1');
      commit(repo, 'c.txt', '1\n', 'm1');
      git(repo, 'checkout', '-q', 'main');
      commit(repo, 'c.txt', '2\n', 'main c');
      await assert.rejects(svc.merge(repo, 'm1'));
      let s = await svc.getState(repo);
      assert.strictEqual(s.operationInProgress, 'merge');
      assert.strictEqual(s.hasChanges, true);
      await svc.abortOperation(repo, 'merge');
      s = await svc.getState(repo);
      assert.strictEqual(s.operationInProgress, undefined);
      assert.strictEqual(s.hasChanges, false);
    });

    it('rebase in progress -> operationInProgress=rebase', async () => {
      git(repo, 'checkout', '-q', '-b', 'r1');
      commit(repo, 'c.txt', '1\n', 'r1');
      git(repo, 'checkout', '-q', 'main');
      commit(repo, 'c.txt', '2\n', 'main c');
      git(repo, 'checkout', '-q', 'r1');
      await assert.rejects(svc.rebase(repo, 'main'));
      const s = await svc.getState(repo);
      assert.strictEqual(s.operationInProgress, 'rebase');
      await svc.abortOperation(repo, 'rebase');
      assert.strictEqual((await svc.getState(repo)).operationInProgress, undefined);
    });

    it('cherry-pick in progress -> operationInProgress=cherry-pick', async () => {
      git(repo, 'checkout', '-q', '-b', 'cp');
      commit(repo, 'c.txt', '1\n', 'cp');
      git(repo, 'checkout', '-q', 'main');
      commit(repo, 'c.txt', '2\n', 'main c');
      assert.throws(() => git(repo, 'cherry-pick', 'cp'));
      assert.strictEqual((await svc.getState(repo)).operationInProgress, 'cherry-pick');
      await svc.abortOperation(repo, 'cherry-pick');
    });

    it('unborn repository (no commits)', async () => {
      const r = path.join(fx.base, 'unborn');
      git(fx.base, 'init', '-q', r);
      const s = await svc.getState(r);
      assert.strictEqual(s.currentBranch, 'main');
      assert.strictEqual(s.hasChanges, false);
      assert.strictEqual(s.hasStash, false);
      assert.deepStrictEqual(await svc.listBranches(r), []);
      assert.deepStrictEqual(await svc.recentBranches(r, 5), []);
      assert.deepStrictEqual(await svc.listStashes(r), []);
    });

    it('works inside a linked worktree', async () => {
      const s = await svc.getState(fx.worktree);
      assert.strictEqual(s.currentBranch, 'wt-branch');
      assert.strictEqual(s.operationInProgress, undefined);
    });
  });

  describe('branch CRUD', () => {
    it('createBranch without checkout', async () => {
      await svc.createBranch(repo, 'feature/new', 'develop', false);
      const b = await branch('feature/new');
      assert.ok(b);
      assert.strictEqual(b!.isCurrent, false);
      assert.strictEqual(b!.commit, git(repo, 'rev-parse', '--short', 'develop').trim());
      assert.strictEqual((await svc.getState(repo)).currentBranch, 'main');
    });

    it('createBranch with checkout', async () => {
      await svc.createBranch(repo, 'feature/co', 'main', true);
      assert.strictEqual((await svc.getState(repo)).currentBranch, 'feature/co');
      assert.strictEqual((await branch('feature/co'))!.isCurrent, true);
    });

    it('createBranch rejects an existing name', async () => {
      await assert.rejects(svc.createBranch(repo, 'bugfix', 'main', false), /already exists/);
    });

    it('checkout local branch', async () => {
      await svc.checkout(repo, 'develop');
      assert.strictEqual((await svc.getState(repo)).currentBranch, 'develop');
    });

    it('checkout a revision (detached)', async () => {
      const sha = git(repo, 'rev-parse', 'HEAD~1').trim();
      await svc.checkout(repo, sha);
      const s = await svc.getState(repo);
      assert.strictEqual(s.currentBranch, undefined);
      assert.ok(sha.startsWith(s.detachedAt!));
    });

    it('checkoutRemote creates a tracking branch', async () => {
      await svc.checkoutRemote(repo, 'origin/feature/remote-only', 'feature/remote-only');
      const b = await branch('feature/remote-only');
      assert.ok(b && b.isCurrent);
      assert.strictEqual(b!.upstream, 'origin/feature/remote-only');
    });

    it('renameBranch', async () => {
      await svc.renameBranch(repo, 'feature/x', 'feature/renamed');
      assert.strictEqual(await branch('feature/x'), undefined);
      assert.ok(await branch('feature/renamed'));
    });

    it('renameBranch of the current branch', async () => {
      await svc.renameBranch(repo, 'main', 'trunk');
      assert.strictEqual((await svc.getState(repo)).currentBranch, 'trunk');
    });

    it('deleteBranch (merged, non-force)', async () => {
      await svc.deleteBranch(repo, 'bugfix', false);
      assert.strictEqual(await branch('bugfix'), undefined);
    });

    it('deleteBranch non-force refuses unmerged; force deletes', async () => {
      git(repo, 'checkout', '-q', '-b', 'unmerged');
      commit(repo, 'u.txt', 'u\n', 'unmerged work');
      git(repo, 'checkout', '-q', 'main');
      await assert.rejects(svc.deleteBranch(repo, 'unmerged', false), /not fully merged/);
      await svc.deleteBranch(repo, 'unmerged', true);
      assert.strictEqual(await branch('unmerged'), undefined);
    });

    it('deleteBranch refuses the current branch', async () => {
      await assert.rejects(svc.deleteBranch(repo, 'main', true));
    });

    it('deleteRemoteBranch accepts "origin/x" and "x"', async () => {
      await svc.deleteRemoteBranch(repo, 'origin', 'origin/feature/remote-only');
      assert.strictEqual(await branch('origin/feature/remote-only'), undefined);
      assert.throws(() => git(fx.remote, 'rev-parse', '--verify', 'refs/heads/feature/remote-only'));
      await svc.deleteRemoteBranch(repo, 'origin', 'develop');
      assert.throws(() => git(fx.remote, 'rev-parse', '--verify', 'refs/heads/develop'));
    });
  });

  describe('merge / rebase helpers', () => {
    it('merge fast-forward', async () => {
      git(repo, 'checkout', '-q', '-b', 'ff');
      commit(repo, 'ff.txt', 'ff\n', 'ff');
      git(repo, 'checkout', '-q', 'main');
      await svc.merge(repo, 'ff');
      assert.strictEqual(git(repo, 'rev-parse', 'main').trim(), git(repo, 'rev-parse', 'ff').trim());
    });

    it('merge non-ff creates merge commit without editor', async () => {
      git(repo, 'checkout', '-q', '-b', 'side');
      commit(repo, 'side.txt', 's\n', 'side');
      git(repo, 'checkout', '-q', 'main');
      commit(repo, 'main2.txt', 'm\n', 'main2');
      await svc.merge(repo, 'side');
      assert.strictEqual(git(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ').length, 3);
    });

    it('checkoutAndRebaseOntoCurrent', async () => {
      git(repo, 'checkout', '-q', '-b', 'topic', 'main~2');
      commit(repo, 't.txt', 't\n', 'topic');
      git(repo, 'checkout', '-q', 'main');
      await svc.checkoutAndRebaseOntoCurrent(repo, 'topic');
      assert.strictEqual((await svc.getState(repo)).currentBranch, 'topic');
      assert.strictEqual(git(repo, 'rev-parse', 'topic~1').trim(), git(repo, 'rev-parse', 'main').trim());
    });

    it('logBetween / diffNames', async () => {
      const log = await svc.logBetween(repo, 'main', 'origin/main');
      assert.strictEqual(log.length, 2);
      assert.match(log[0], /local b/);
      write(repo, 'a.txt', 'wt change\n');
      const names = (await svc.diffNames(repo, 'develop')).sort();
      assert.ok(names.includes('a.txt') && names.includes('b.txt'), names.join(','));
    });
  });

  describe('stash', () => {
    it('stash / listStashes / stashPop', async () => {
      write(repo, 'a.txt', 'stashed change\n');
      await svc.stash(repo, 'my work');
      let s = await svc.getState(repo);
      assert.strictEqual(s.hasChanges, false);
      assert.strictEqual(s.hasStash, true);
      const list = await svc.listStashes(repo);
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].index, 0);
      assert.match(list[0].message, /my work/);

      await svc.stashPop(repo, 0);
      s = await svc.getState(repo);
      assert.strictEqual(s.hasStash, false);
      assert.strictEqual(s.hasChanges, true);
      assert.strictEqual(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'stashed change\n');
    });

    it('stash with includeUntracked, apply and drop by index', async () => {
      write(repo, 'untracked.txt', 'u\n');
      await svc.stash(repo, 'with untracked', true);
      assert.ok(!fs.existsSync(path.join(repo, 'untracked.txt')));
      write(repo, 'a.txt', 'second\n');
      await svc.stash(repo, 'second');
      let list = await svc.listStashes(repo);
      assert.deepStrictEqual(list.map(e => e.index), [0, 1]);
      assert.match(list[1].message, /with untracked/);

      await svc.stashApply(repo, 1);
      assert.ok(fs.existsSync(path.join(repo, 'untracked.txt')));
      assert.strictEqual((await svc.listStashes(repo)).length, 2);

      await svc.stashDrop(repo, 0);
      list = await svc.listStashes(repo);
      assert.strictEqual(list.length, 1);
      assert.match(list[0].message, /with untracked/);
    });

    it('stash without message', async () => {
      write(repo, 'a.txt', 'x\n');
      await svc.stash(repo);
      assert.strictEqual((await svc.listStashes(repo)).length, 1);
    });
  });

  describe('recentBranches', () => {
    it('newest first, excluding current, honoring limit', async () => {
      assert.deepStrictEqual(await svc.recentBranches(repo, 10), ['feature/x', 'develop', 'bugfix']);
      assert.deepStrictEqual(await svc.recentBranches(repo, 2), ['feature/x', 'develop']);
      assert.deepStrictEqual(await svc.recentBranches(repo, 0), []);
    });

    it('drops deleted branches and detached SHAs', async () => {
      git(repo, 'checkout', '-q', '--detach', 'HEAD~1');
      git(repo, 'checkout', '-q', 'main');
      git(repo, 'branch', '-D', 'bugfix');
      assert.deepStrictEqual(await svc.recentBranches(repo, 10), ['feature/x', 'develop']);
    });

    it('updates after a checkout', async () => {
      await svc.checkout(repo, 'bugfix');
      assert.deepStrictEqual(await svc.recentBranches(repo, 3), ['main', 'feature/x', 'develop']);
    });
  });

  describe('worktrees', () => {
    it('listWorktrees', async () => {
      const wts = await svc.listWorktrees(repo);
      assert.strictEqual(wts.length, 2);
      assert.strictEqual(wts[0].path, repo);
      assert.strictEqual(wts[0].isMain, true);
      assert.strictEqual(wts[0].branch, 'main');
      assert.strictEqual(wts[1].path, fx.worktree);
      assert.strictEqual(wts[1].branch, 'wt-branch');
    });

    it('addWorktree (existing + new branch) and removeWorktree', async () => {
      const p1 = path.join(fx.base, 'wt-bugfix');
      const p2 = path.join(fx.base, 'wt-new');
      await svc.addWorktree(repo, p1, 'bugfix');
      await svc.addWorktree(repo, p2, 'develop', 'feature/from-wt');
      let wts = await svc.listWorktrees(repo);
      assert.strictEqual(wts.find(w => w.path === p1)?.branch, 'bugfix');
      assert.strictEqual(wts.find(w => w.path === p2)?.branch, 'feature/from-wt');
      await svc.removeWorktree(repo, p1);
      wts = await svc.listWorktrees(repo);
      assert.strictEqual(wts.find(w => w.path === p1), undefined);
    });
  });

  describe('push', () => {
    it('push new branch with setUpstream to bare remote', async () => {
      await svc.createBranch(repo, 'feature/pushed', 'main', true);
      commit(repo, 'p.txt', 'p\n', 'pushed work');
      await svc.push(repo, 'feature/pushed', { setUpstream: true });
      assert.strictEqual(
        git(fx.remote, 'rev-parse', 'refs/heads/feature/pushed').trim(),
        git(repo, 'rev-parse', 'feature/pushed').trim());
      const b = await branch('feature/pushed');
      assert.strictEqual(b!.upstream, 'origin/feature/pushed');
      assert.strictEqual(b!.ahead, 0);
      assert.strictEqual(b!.behind, 0);
      assert.ok(await branch('origin/feature/pushed'));
    });

    it('push without upstream sets one automatically', async () => {
      await svc.push(repo, 'feature/x');
      assert.strictEqual((await branch('feature/x'))!.upstream, 'origin/feature/x');
    });

    it('push with existing upstream (non-current branch)', async () => {
      git(repo, 'checkout', '-q', 'develop');
      commit(repo, 'd2.txt', 'd2\n', 'dev 2');
      git(repo, 'checkout', '-q', 'main');
      await svc.push(repo, 'develop');
      assert.strictEqual(git(fx.remote, 'rev-parse', 'develop').trim(), git(repo, 'rev-parse', 'develop').trim());
    });

    it('rejected non-ff push, then force (with lease) succeeds', async () => {
      // main is ahead 2 / behind 1 -> non-fast-forward
      await assert.rejects(svc.push(repo, 'main'));
      await svc.push(repo, 'main', { force: true });
      assert.strictEqual(git(fx.remote, 'rev-parse', 'main').trim(), git(repo, 'rev-parse', 'main').trim());
    });
  });

  describe('updateBranch / fetch / updateProject', () => {
    it('updateBranch fast-forwards a non-current branch from its upstream', async () => {
      // advance remote develop
      git(fx.other, 'checkout', '-q', 'develop');
      commit(fx.other, 'dev2.txt', 'dev2\n', 'remote dev 2');
      git(fx.other, 'push', '-q', 'origin', 'develop');
      const before = git(repo, 'rev-parse', 'develop').trim();
      const dev = (await branch('develop'))!;
      assert.strictEqual(dev.isCurrent, false);
      await svc.updateBranch(repo, dev);
      const after = git(repo, 'rev-parse', 'develop').trim();
      assert.notStrictEqual(after, before);
      assert.strictEqual(after, git(fx.remote, 'rev-parse', 'develop').trim());
      assert.strictEqual((await svc.getState(repo)).currentBranch, 'main');
    });

    it('updateBranch refuses non-fast-forward for a non-current branch', async () => {
      // diverge develop locally and remotely
      git(fx.other, 'checkout', '-q', 'develop');
      commit(fx.other, 'dev2.txt', 'dev2\n', 'remote dev 2');
      git(fx.other, 'push', '-q', 'origin', 'develop');
      git(repo, 'checkout', '-q', 'develop');
      commit(repo, 'dev-local.txt', 'l\n', 'local dev');
      git(repo, 'checkout', '-q', 'main');
      const before = git(repo, 'rev-parse', 'develop').trim();
      await assert.rejects(svc.updateBranch(repo, (await branch('develop'))!));
      assert.strictEqual(git(repo, 'rev-parse', 'develop').trim(), before);
    });

    it('updateBranch without upstream rejects', async () => {
      await assert.rejects(svc.updateBranch(repo, (await branch('feature/x'))!), /no upstream/);
    });

    it('updateBranch on current branch pulls', async () => {
      git(fx.other, 'checkout', '-q', 'develop');
      commit(fx.other, 'dev2.txt', 'dev2\n', 'remote dev 2');
      git(fx.other, 'push', '-q', 'origin', 'develop');
      await svc.checkout(repo, 'develop');
      await svc.updateBranch(repo, (await branch('develop'))!);
      assert.strictEqual(git(repo, 'rev-parse', 'develop').trim(), git(fx.remote, 'rev-parse', 'develop').trim());
    });

    it('updateBranch on a remote branch fetches it', async () => {
      git(fx.other, 'checkout', '-q', 'develop');
      commit(fx.other, 'dev2.txt', 'dev2\n', 'remote dev 2');
      git(fx.other, 'push', '-q', 'origin', 'develop');
      await svc.updateBranch(repo, (await branch('origin/develop'))!);
      assert.strictEqual(git(repo, 'rev-parse', 'origin/develop').trim(), git(fx.remote, 'rev-parse', 'develop').trim());
    });

    it('fetch prunes deleted remote branches', async () => {
      git(fx.other, 'push', '-q', 'origin', '--delete', 'feature/remote-only');
      await svc.fetch(repo);
      assert.strictEqual(await branch('origin/feature/remote-only'), undefined);
    });

    it('updateProject merges upstream into current branch', async () => {
      await svc.updateProject(repo);
      const main = (await branch('main'))!;
      assert.strictEqual(main.behind, 0);
      assert.strictEqual(main.ahead, 3); // 2 local + merge commit
    });
  });

  describe('exec', () => {
    it('runs raw git and rejects with stderr', async () => {
      assert.strictEqual((await svc.exec(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(), 'main');
      await assert.rejects(svc.exec(repo, ['rev-parse', '--verify', 'nope']), /fatal|Needed a single revision/);
    });
  });
});
