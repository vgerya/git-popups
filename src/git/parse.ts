// Pure parsing helpers for git CLI output. No vscode import: unit-testable in plain node.
import type { BranchInfo, StashEntry, WorktreeInfo } from './types';

/** Field separator used in for-each-ref format strings (ASCII unit separator). */
export const US = '\x1f';

/**
 * Format string for `git for-each-ref` matching {@link parseForEachRef}.
 * Fields (separated by %1f): refname, refname:short, objectname:short, upstream:short,
 * upstream:track, committerdate:unix, HEAD ("*" for current), symref.
 */
export const FOR_EACH_REF_FORMAT = [
  '%(refname)',
  '%(refname:short)',
  '%(objectname:short)',
  '%(upstream:short)',
  '%(upstream:track)',
  '%(committerdate:unix)',
  '%(HEAD)',
  '%(symref)',
].join('%1f'); // for-each-ref hex escape is %XX (not %xXX like pretty formats)

/**
 * Parse an `%(upstream:track)` value.
 * Input examples: "", "[ahead 2]", "[behind 1]", "[ahead 2, behind 1]", "[gone]".
 */
export function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  const t = (track || '').trim();
  const ahead = /ahead (\d+)/.exec(t);
  const behind = /behind (\d+)/.exec(t);
  return {
    ahead: ahead ? parseInt(ahead[1], 10) : 0,
    behind: behind ? parseInt(behind[1], 10) : 0,
    gone: /\bgone\b/.test(t),
  };
}

/**
 * Parse output of `git for-each-ref --format=<FOR_EACH_REF_FORMAT> refs/heads refs/remotes`.
 * One ref per line; fields separated by \x1f in the order of {@link FOR_EACH_REF_FORMAT}.
 * Symbolic refs (e.g. refs/remotes/origin/HEAD) are skipped.
 */
export function parseForEachRef(output: string): BranchInfo[] {
  const result: BranchInfo[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [ref, short, commit, upstream, track, date, head, symref] = line.split(US);
    if (!ref) continue;
    if (symref || /^refs\/remotes\/[^/]+\/HEAD$/.test(ref)) continue;
    const isRemote = ref.startsWith('refs/remotes/');
    if (!isRemote && !ref.startsWith('refs/heads/')) continue;
    const name = isRemote ? ref.slice('refs/remotes/'.length) : ref.slice('refs/heads/'.length);
    const { ahead, behind } = parseTrack(track ?? '');
    const info: BranchInfo = {
      name: name || short,
      ref,
      kind: isRemote ? 'remote' : 'local',
      isCurrent: !isRemote && (head ?? '').trim() === '*',
      ahead,
      behind,
      commit: commit ?? '',
      committerDate: parseInt(date ?? '', 10) || 0,
    };
    if (isRemote) info.remote = name.split('/')[0];
    if (upstream) info.upstream = upstream;
    result.push(info);
  }
  return result;
}

export interface StatusV2 {
  /** Branch name, undefined if detached */
  head?: string;
  /** Commit sha, undefined for "(initial)" */
  oid?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  hasChanges: boolean;
  hasStagedChanges: boolean;
  hasUntracked: boolean;
  hasConflicts: boolean;
  /** Paths (repo-relative, forward slashes) with any change, including untracked. */
  changedPaths: Set<string>;
  untrackedPaths: Set<string>;
}

/**
 * Parse `git status --porcelain=v2 --branch` (newline-terminated, NOT -z).
 * Header lines: "# branch.oid <sha|(initial)>", "# branch.head <name|(detached)>",
 * "# branch.upstream <name>", "# branch.ab +A -B".
 * Entry lines: "1 XY sub mH mI mW hH hI path", "2 XY sub mH mI mW hH hI Xscore path\torig",
 * "u XY sub m1 m2 m3 mW h1 h2 h3 path", "? path", "! path".
 * Note: paths with special chars are C-quoted by git; quoted paths are unquoted best-effort.
 */
export function parseStatusV2(output: string): StatusV2 {
  const s: StatusV2 = {
    ahead: 0, behind: 0, hasChanges: false, hasStagedChanges: false,
    hasUntracked: false, hasConflicts: false, changedPaths: new Set(), untrackedPaths: new Set(),
  };
  for (const line of output.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# ')) {
      const [key, ...rest] = line.slice(2).split(' ');
      const val = rest.join(' ');
      if (key === 'branch.oid') s.oid = val === '(initial)' ? undefined : val;
      else if (key === 'branch.head') s.head = val === '(detached)' ? undefined : val;
      else if (key === 'branch.upstream') s.upstream = val;
      else if (key === 'branch.ab') {
        const m = /\+(\d+) -(\d+)/.exec(val);
        if (m) { s.ahead = parseInt(m[1], 10); s.behind = parseInt(m[2], 10); }
      }
      continue;
    }
    const type = line[0];
    if (type === '?') {
      const p = unquote(line.slice(2));
      s.hasUntracked = true; s.hasChanges = true;
      s.untrackedPaths.add(p); s.changedPaths.add(p);
    } else if (type === '1' || type === '2' || type === 'u') {
      const xy = line.slice(2, 4);
      const nFields = type === '1' ? 8 : type === '2' ? 9 : 10;
      let rest = splitN(line, nFields);
      if (type === '2') rest = rest.split('\t')[0];
      const p = unquote(rest);
      s.hasChanges = true;
      s.changedPaths.add(p);
      if (type === 'u') { s.hasConflicts = true; s.hasStagedChanges = true; }
      else if (xy[0] !== '.') s.hasStagedChanges = true;
    }
  }
  return s;
}

/** Return the remainder of `line` after skipping `n` space-separated fields. */
function splitN(line: string, n: number): string {
  let idx = 0;
  for (let i = 0; i < n; i++) {
    idx = line.indexOf(' ', idx);
    if (idx < 0) return '';
    idx++;
  }
  return line.slice(idx);
}

/** Best-effort unquote of git C-style quoted paths ("a\tb" / octal escapes). */
export function unquote(p: string): string {
  if (!(p.length >= 2 && p.startsWith('"') && p.endsWith('"'))) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') { bytes.push(...Buffer.from(c, 'utf8')); continue; }
    const n = body[++i];
    if (n >= '0' && n <= '7') {
      bytes.push(parseInt(body.substr(i, 3), 8)); i += 2;
    } else {
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', a: '\x07', b: '\b', f: '\f', v: '\v' };
      bytes.push(...Buffer.from(map[n] ?? n, 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Parse `git reflog --format=%gs -n N` (newest first). Picks lines
 * "checkout: moving from <X> to <Y>" and returns destination names Y, unique, newest first.
 * Also includes the source X (it was checked out before), keeping order of appearance.
 * Caller filters out current branch / non-existent branches.
 */
export function parseReflogCheckouts(output: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (n: string) => { if (n && !seen.has(n)) { seen.add(n); out.push(n); } };
  for (const line of output.split('\n')) {
    const m = /^checkout: moving from (\S+) to (\S+)\s*$/.exec(line.trim());
    if (!m) continue;
    add(m[2]);
    add(m[1]);
  }
  return out;
}

/**
 * Parse `git worktree list --porcelain`. Blocks separated by blank lines:
 * "worktree <path>", "HEAD <sha>", "branch refs/heads/<name>" | "detached", optional "bare", "locked", "prunable".
 * The first block is the main worktree.
 */
export function parseWorktreesPorcelain(output: string): WorktreeInfo[] {
  const result: WorktreeInfo[] = [];
  let cur: WorktreeInfo | undefined;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), head: '', isMain: result.length === 0 };
      result.push(cur);
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice(5);
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    }
  }
  return result;
}

/**
 * Parse `git stash list --format=%gd%x1f%gs`. One entry per line: "stash@{N}\x1f<message>".
 * Also accepts the default format "stash@{N}: <message>".
 */
export function parseStashList(output: string): StashEntry[] {
  const result: StashEntry[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    let ref: string, message: string;
    if (line.includes(US)) {
      [ref, message] = line.split(US);
    } else {
      const i = line.indexOf(': ');
      ref = i >= 0 ? line.slice(0, i) : line;
      message = i >= 0 ? line.slice(i + 2) : '';
    }
    const m = /^stash@\{(\d+)\}$/.exec(ref.trim());
    if (!m) continue;
    result.push({ index: parseInt(m[1], 10), ref: ref.trim(), message: (message ?? '').trim() });
  }
  return result;
}
