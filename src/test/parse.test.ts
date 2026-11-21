import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  FOR_EACH_REF_FORMAT, US, parseForEachRef, parseReflogCheckouts, parseStashList,
  parseStatusV2, parseTrack, parseWorktreesPorcelain, unquote,
} from '../git/parse';
import { Fixture, buildFixture, commit, git, rmrf, write } from './helpers';

describe('parse.ts', function () {
  this.timeout(30000);
  let fx: Fixture;

  before(() => { fx = buildFixture(); });
  after(() => rmrf(fx?.base));

  describe('parseTrack', () => {
    it('handles empty', () => assert.deepStrictEqual(parseTrack(''), { ahead: 0, behind: 0, gone: false }));
    it('handles ahead', () => assert.deepStrictEqual(parseTrack('[ahead 2]'), { ahead: 2, behind: 0, gone: false }));
    it('handles behind', () => assert.deepStrictEqual(parseTrack('[behind 13]'), { ahead: 0, behind: 13, gone: false }));
    it('handles ahead+behind', () =>
      assert.deepStrictEqual(parseTrack('[ahead 2, behind 1]'), { ahead: 2, behind: 1, gone: false }));
    it('handles gone', () => assert.deepStrictEqual(parseTrack('[gone]'), { ahead: 0, behind: 0, gone: true }));
    it('tolerates undefined-ish input', () =>
      assert.deepStrictEqual(parseTrack(undefined as unknown as string), { ahead: 0, behind: 0, gone: false }));
  });

  describe('parseForEachRef (real git output)', () => {
    const list = () => parseForEachRef(git(fx.repo, 'for-each-ref', `--format=${FOR_EACH_REF_FORMAT}`, 'refs/heads', 'refs/remotes'));

    it('lists local branches incl. nested names', () => {
      const locals = list().filter(b => b.kind === 'local').map(b => b.name).sort();
      assert.deepStrictEqual(locals, ['bugfix', 'develop', 'feature/nested/y', 'feature/x', 'main', 'wt-branch']);
    });

    it('lists remote branches and skips origin/HEAD symref', () => {
      const remotes = list().filter(b => b.kind === 'remote');
      assert.deepStrictEqual(remotes.map(b => b.name).sort(), ['origin/develop', 'origin/feature/remote-only', 'origin/main']);
      assert.ok(remotes.every(b => b.remote === 'origin'));
      assert.ok(remotes.every(b => !b.isCurrent));
      assert.ok(!list().some(b => b.name.endsWith('/HEAD')));
    });

    it('marks exactly the current branch', () => {
      const cur = list().filter(b => b.isCurrent);
      assert.strictEqual(cur.length, 1);
      assert.strictEqual(cur[0].name, 'main');
    });

    it('fills ref, commit, committerDate', () => {
      const main = list().find(b => b.name === 'main')!;
      assert.strictEqual(main.ref, 'refs/heads/main');
      assert.strictEqual(main.commit, git(fx.repo, 'rev-parse', '--short', 'main').trim());
      const now = Math.floor(Date.now() / 1000);
      assert.ok(main.committerDate > now - 3600 && main.committerDate <= now + 5, `date ${main.committerDate}`);
    });

    it('computes upstream ahead/behind', () => {
      const bs = list();
      const main = bs.find(b => b.name === 'main')!;
      assert.strictEqual(main.upstream, 'origin/main');
      assert.strictEqual(main.ahead, 2);
      assert.strictEqual(main.behind, 1);
      const dev = bs.find(b => b.name === 'develop')!;
      assert.strictEqual(dev.upstream, 'origin/develop');
      assert.strictEqual(dev.ahead, 0);
      assert.strictEqual(dev.behind, 0);
      const fx1 = bs.find(b => b.name === 'feature/x')!;
      assert.strictEqual(fx1.upstream, undefined);
      assert.strictEqual(fx1.ahead, 0);
    });

    it('ignores blank lines, non-branch refs, and symref lines', () => {
      const line = (f: string[]) => f.join(US);
      const out = [
        '',
        line(['refs/tags/v1', 'v1', 'abc', '', '', '1', ' ', '']),
        line(['refs/remotes/origin/HEAD', 'origin', 'abc', '', '', '1', ' ', 'refs/remotes/origin/main']),
        line(['refs/heads/x', 'x', 'abc1234', 'origin/x', '[gone]', '1700000000', '*', '']),
        '',
      ].join('\n');
      const r = parseForEachRef(out);
      assert.strictEqual(r.length, 1);
      assert.deepStrictEqual(r[0], {
        name: 'x', ref: 'refs/heads/x', kind: 'local', isCurrent: true, ahead: 0, behind: 0,
        commit: 'abc1234', committerDate: 1700000000, upstream: 'origin/x',
      });
    });

    it('handles empty output', () => assert.deepStrictEqual(parseForEachRef(''), []));
  });

  describe('parseReflogCheckouts (real git output)', () => {
    // must run before tests that do more checkouts
    it('returns unique checkout targets/sources newest first', () => {
      const out = git(fx.repo, 'reflog', '--format=%gs', '-n', '100');
      const r = parseReflogCheckouts(out);
      // history: main -> feature/x -> bugfix -> develop -> feature/x -> main  (plus clone-time develop/main)
      assert.deepStrictEqual(r.slice(0, 4), ['main', 'feature/x', 'develop', 'bugfix']);
      assert.strictEqual(new Set(r).size, r.length, 'no duplicates');
    });

    it('ignores non-checkout reflog entries', () => {
      const out = [
        'commit: local b',
        'checkout: moving from dev to main',
        'reset: moving to HEAD~1',
        'rebase (finish): returning to refs/heads/x',
        'checkout: moving from a to dev',
        '',
      ].join('\n');
      assert.deepStrictEqual(parseReflogCheckouts(out), ['main', 'dev', 'a']);
    });

    it('handles empty output', () => assert.deepStrictEqual(parseReflogCheckouts(''), []));
  });

  describe('parseStatusV2 (real git output)', () => {
    const status = (cwd: string) => parseStatusV2(git(cwd, 'status', '--porcelain=v2', '--branch'));

    it('clean tree with upstream', () => {
      const s = status(fx.repo);
      assert.strictEqual(s.head, 'main');
      assert.strictEqual(s.oid, git(fx.repo, 'rev-parse', 'HEAD').trim());
      assert.strictEqual(s.upstream, 'origin/main');
      assert.strictEqual(s.ahead, 2);
      assert.strictEqual(s.behind, 1);
      assert.strictEqual(s.hasChanges, false);
      assert.strictEqual(s.hasStagedChanges, false);
      assert.strictEqual(s.hasUntracked, false);
      assert.strictEqual(s.hasConflicts, false);
      assert.strictEqual(s.changedPaths.size, 0);
    }).timeout(10000);

    it('untracked, modified, staged, renamed and paths with spaces / unicode', () => {
      const r = fx.repo;
      write(r, 'new file.txt', 'u\n');
      write(r, 'a.txt', 'a modified\n');
      write(r, 'staged.txt', 's\n');
      git(r, 'add', 'staged.txt');
      fs.mkdirSync(path.join(r, 'dir'), { recursive: true });
      git(r, 'mv', 'b.txt', 'dir/b renamed.txt');
      write(r, 'тест.txt', 'unicode\n');
      write(r, 'tab\there.txt', 'tab\n');
      try {
        const s = status(r);
        assert.strictEqual(s.hasChanges, true);
        assert.strictEqual(s.hasStagedChanges, true);
        assert.strictEqual(s.hasUntracked, true);
        assert.strictEqual(s.hasConflicts, false);
        assert.ok(s.untrackedPaths.has('new file.txt'), [...s.untrackedPaths].join('|'));
        assert.ok(s.untrackedPaths.has('тест.txt'), [...s.untrackedPaths].join('|'));
        assert.ok(s.untrackedPaths.has('tab\there.txt'), [...s.untrackedPaths].join('|'));
        for (const p of ['a.txt', 'staged.txt', 'dir/b renamed.txt', 'new file.txt']) {
          assert.ok(s.changedPaths.has(p), `${p} in ${[...s.changedPaths].join('|')}`);
        }
        assert.ok(!s.changedPaths.has('b.txt'), 'rename source should not be listed');
      } finally {
        git(r, 'reset', '-q', '--hard');
        git(r, 'clean', '-qfd');
      }
    });

    it('only unstaged modification -> no staged changes', () => {
      write(fx.repo, 'a.txt', 'changed\n');
      try {
        const s = status(fx.repo);
        assert.strictEqual(s.hasChanges, true);
        assert.strictEqual(s.hasStagedChanges, false);
        assert.deepStrictEqual([...s.changedPaths], ['a.txt']);
      } finally { git(fx.repo, 'checkout', '-q', '--', 'a.txt'); }
    });

    it('merge conflict -> hasConflicts', () => {
      const r = fx.repo;
      git(r, 'checkout', '-q', '-b', 'conflict-a');
      commit(r, 'c.txt', 'A\n', 'A');
      git(r, 'checkout', '-q', '-b', 'conflict-b', 'main');
      commit(r, 'c.txt', 'B\n', 'B');
      try {
        assert.throws(() => git(r, 'merge', 'conflict-a'));
        const s = status(r);
        assert.strictEqual(s.head, 'conflict-b');
        assert.strictEqual(s.hasConflicts, true);
        assert.strictEqual(s.hasStagedChanges, true);
        assert.ok(s.changedPaths.has('c.txt'));
      } finally {
        git(r, 'merge', '--abort');
        git(r, 'checkout', '-q', 'main');
        git(r, 'branch', '-D', 'conflict-a', 'conflict-b');
      }
    });

    it('detached HEAD -> head undefined', () => {
      git(fx.repo, 'checkout', '-q', '--detach', 'HEAD~1');
      try {
        const s = status(fx.repo);
        assert.strictEqual(s.head, undefined);
        assert.strictEqual(s.oid, git(fx.repo, 'rev-parse', 'HEAD').trim());
        assert.strictEqual(s.upstream, undefined);
      } finally { git(fx.repo, 'checkout', '-q', 'main'); }
    });

    it('initial (unborn) repo -> oid undefined', () => {
      const r = path.join(fx.base, 'empty');
      git(fx.base, 'init', '-q', r);
      const s = status(r);
      assert.strictEqual(s.oid, undefined);
      assert.strictEqual(s.head, 'main');
      assert.strictEqual(s.hasChanges, false);
    });
  });

  describe('unquote', () => {
    it('leaves plain paths', () => assert.strictEqual(unquote('a b.txt'), 'a b.txt'));
    it('decodes escapes', () => assert.strictEqual(unquote('"a\\tb\\\\c\\"d"'), 'a\tb\\c"d'));
    it('decodes octal utf-8', () => assert.strictEqual(unquote('"\\321\\202.txt"'), 'т.txt'));
  });

  describe('parseWorktreesPorcelain (real git output)', () => {
    it('lists main and linked worktree', () => {
      const wts = parseWorktreesPorcelain(git(fx.repo, 'worktree', 'list', '--porcelain'));
      assert.strictEqual(wts.length, 2);
      assert.deepStrictEqual(wts[0], {
        path: fx.repo, head: git(fx.repo, 'rev-parse', 'HEAD').trim(), isMain: true, branch: 'main',
      });
      assert.strictEqual(wts[1].path, fx.worktree);
      assert.strictEqual(wts[1].branch, 'wt-branch');
      assert.strictEqual(wts[1].isMain, false);
      assert.match(wts[1].head, /^[0-9a-f]{40}$/);
    });

    it('detached worktree has no branch', () => {
      const p = path.join(fx.base, 'wt-detached');
      git(fx.repo, 'worktree', 'add', '-q', '--detach', p, 'HEAD~1');
      try {
        const wts = parseWorktreesPorcelain(git(fx.repo, 'worktree', 'list', '--porcelain'));
        const d = wts.find(w => w.path === p)!;
        assert.ok(d, 'detached worktree listed');
        assert.strictEqual(d.branch, undefined);
        assert.strictEqual(d.head, git(fx.repo, 'rev-parse', 'HEAD~1').trim());
      } finally { git(fx.repo, 'worktree', 'remove', '--force', p); }
    });

    it('bare repo main block', () => {
      const wts = parseWorktreesPorcelain(git(fx.remote, 'worktree', 'list', '--porcelain'));
      assert.strictEqual(wts.length, 1);
      assert.strictEqual(wts[0].isMain, true);
      assert.strictEqual(wts[0].branch, undefined);
    });

    it('handles empty output', () => assert.deepStrictEqual(parseWorktreesPorcelain(''), []));
  });

  describe('parseStashList (real git output)', () => {
    before(() => {
      write(fx.repo, 'a.txt', 'stash one\n');
      git(fx.repo, 'stash', 'push', '-q', '-m', 'first stash');
      write(fx.repo, 'a.txt', 'stash two\n');
      git(fx.repo, 'stash', 'push', '-q', '-m', 'second: with colon');
    });
    after(() => { git(fx.repo, 'stash', 'clear'); });

    it('parses the %gd%x1f%gs format', () => {
      const r = parseStashList(git(fx.repo, 'stash', 'list', '--format=%gd%x1f%gs'));
      assert.deepStrictEqual(r, [
        { index: 0, ref: 'stash@{0}', message: 'On main: second: with colon' },
        { index: 1, ref: 'stash@{1}', message: 'On main: first stash' },
      ]);
    });

    it('parses the default format', () => {
      const r = parseStashList(git(fx.repo, 'stash', 'list'));
      assert.deepStrictEqual(r, [
        { index: 0, ref: 'stash@{0}', message: 'On main: second: with colon' },
        { index: 1, ref: 'stash@{1}', message: 'On main: first stash' },
      ]);
    });

    it('handles empty output and junk', () => {
      assert.deepStrictEqual(parseStashList(''), []);
      assert.deepStrictEqual(parseStashList('garbage line\n'), []);
    });
  });
});
