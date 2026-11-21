import * as vscode from 'vscode';
import * as path from 'path';
import type { PopupContext } from './context';
import type { PopupItem } from '../ui/popup';
import type { RepoState, StashEntry, WorktreeInfo } from '../git/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const isMac = process.platform === 'darwin';
/** Platform-appropriate shortcut hint: sc('⌘K', 'Ctrl+K') */
export const sc = (mac: string, other: string) => (isMac ? mac : other);

export async function refreshScm(): Promise<void> {
  try { await vscode.commands.executeCommand('git.refresh'); } catch { /* ignore */ }
}

export async function commandExists(id: string): Promise<boolean> {
  const all = await vscode.commands.getCommands(true);
  return all.includes(id);
}

export function withProgress<T>(title: string, task: () => Promise<T>): Thenable<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: false },
    task,
  );
}

/** Run a mutating git op with a progress notification, then refresh SCM. */
async function mutate<T>(title: string, task: () => Promise<T>): Promise<T> {
  try {
    return await withProgress(title, task);
  } finally {
    await refreshScm();
  }
}

export interface ActiveFile {
  uri: vscode.Uri;
  /** repo-relative path with forward slashes */
  rel: string;
  name: string;
  tracked: boolean;
  modified: boolean;
  untracked: boolean;
}

/** Resolve the active editor's file relative to the repo, and its git status. */
export async function getActiveFile(ctx: PopupContext, root: string, state: RepoState): Promise<ActiveFile | undefined> {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc || doc.uri.scheme !== 'file') return undefined;
  const rel = path.relative(root, doc.uri.fsPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  const relPosix = rel.split(path.sep).join('/');
  let tracked = state.activeFileTracked ?? false;
  let modified = state.activeFileModified ?? false;
  let untracked = false;
  try {
    const [status, lsFiles] = await Promise.all([
      ctx.git.exec(root, ['status', '--porcelain=v1', '--', relPosix]),
      ctx.git.exec(root, ['ls-files', '--', relPosix]),
    ]);
    tracked = lsFiles.trim().length > 0;
    const line = status.split('\n').find(l => l.trim().length > 0);
    untracked = !!line && line.startsWith('??');
    modified = !!line && !line.startsWith('!!');
  } catch { /* fall back to state values */ }
  return { uri: doc.uri, rel: relPosix, name: path.basename(doc.uri.fsPath), tracked, modified, untracked };
}

const opLabel = (op: NonNullable<RepoState['operationInProgress']>) =>
  ({ merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-Pick', revert: 'Revert' })[op];

// ---------------------------------------------------------------------------
// In-progress operation
// ---------------------------------------------------------------------------

export function operationItems(ctx: PopupContext, root: string, op: NonNullable<RepoState['operationInProgress']>): PopupItem[] {
  const name = opLabel(op);
  return [
    {
      label: `Continue ${name}`, icon: 'debug-continue',
      run: () => mutate(`Continuing ${name.toLowerCase()}…`, () => ctx.git.continueOperation(root, op)),
    },
    {
      label: `Abort ${name}`, icon: 'debug-stop',
      run: async () => {
        const ok = await vscode.window.showWarningMessage(`Abort ${name.toLowerCase()} in progress?`, { modal: true }, 'Abort');
        if (ok !== 'Abort') return;
        await mutate(`Aborting ${name.toLowerCase()}…`, () => ctx.git.abortOperation(root, op));
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

export async function commitAll(): Promise<void> {
  await vscode.commands.executeCommand('workbench.view.scm');
  try { await vscode.commands.executeCommand('workbench.scm.focus'); } catch { /* ignore */ }
}

export async function commitFile(ctx: PopupContext, root: string, file: ActiveFile): Promise<void> {
  const message = await vscode.window.showInputBox({
    title: `Commit File: ${file.rel}`,
    prompt: 'Commit message',
    placeHolder: 'Commit message',
    ignoreFocusOut: true,
    validateInput: v => (v.trim() ? undefined : 'Commit message must not be empty'),
  });
  if (!message) return;
  const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === file.uri.toString());
  if (doc?.isDirty) await doc.save();
  await mutate(`Committing ${file.name}…`, async () => {
    await ctx.git.exec(root, ['add', '--', file.rel]);
    // `--only` (default with pathspec) commits just this file regardless of what else is staged
    await ctx.git.exec(root, ['commit', '--only', '-m', message, '--', file.rel]);
  });
  void vscode.window.showInformationMessage(`Committed ${file.name}`);
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

export async function rollbackFile(ctx: PopupContext, root: string, file: ActiveFile): Promise<void> {
  if (!file.tracked) {
    const ok = await vscode.window.showWarningMessage(
      `${file.name} is not tracked by Git. Delete it (move to trash)?`, { modal: true }, 'Delete');
    if (ok !== 'Delete') return;
    await vscode.workspace.fs.delete(file.uri, { useTrash: true });
    await refreshScm();
    return;
  }
  const ok = await vscode.window.showWarningMessage(
    `Rollback changes in ${file.rel}?`, { modal: true, detail: 'All local changes to this file (staged and unstaged) will be lost.' }, 'Rollback');
  if (ok !== 'Rollback') return;
  const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === file.uri.toString());
  await mutate(`Rolling back ${file.name}…`, async () => {
    try {
      await ctx.git.exec(root, ['checkout', 'HEAD', '--', file.rel]);
    } catch {
      // e.g. newly added file with no HEAD version: unstage it
      await ctx.git.exec(root, ['rm', '--cached', '-q', '--', file.rel]);
    }
  });
  if (doc?.isDirty) {
    // discard unsaved buffer changes too
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  }
}

// ---------------------------------------------------------------------------
// History (with a lightweight content provider for `git show sha:path`)
// ---------------------------------------------------------------------------

const SHOW_SCHEME = 'gitpopups-show';
let providerRegistered = false;

function ensureShowProvider(ctx: PopupContext) {
  if (providerRegistered) return;
  providerRegistered = true;
  const provider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent: async (uri) => {
      const q = JSON.parse(uri.query) as { root: string; ref: string; path: string };
      try { return await ctx.git.exec(q.root, ['show', `${q.ref}:${q.path}`]); }
      catch { return ''; }
    },
  };
  ctx.extension.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SHOW_SCHEME, provider));
}

function showUri(root: string, ref: string, rel: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: SHOW_SCHEME,
    path: `/${ref.slice(0, 12)}/${rel}`,
    query: JSON.stringify({ root, ref, path: rel }),
  });
}

export async function showHistory(ctx: PopupContext, root: string, file: ActiveFile): Promise<void> {
  if (await commandExists('git.viewFileHistory')) {
    await vscode.commands.executeCommand('git.viewFileHistory', file.uri);
    return;
  }
  ensureShowProvider(ctx);
  const SEP = '\x1f';
  const out = await withProgress(`Loading history for ${file.name}…`, () =>
    ctx.git.exec(root, ['log', '--follow', '-n', '500', `--format=%H${SEP}%h${SEP}%an${SEP}%ar${SEP}%s`, '--', file.rel]));
  const commits = out.split('\n').filter(Boolean).map(l => {
    const [sha, short, author, date, subject] = l.split(SEP);
    return { sha, short, author, date, subject };
  });
  if (!commits.length) { void vscode.window.showInformationMessage(`No history for ${file.name}`); return; }
  type CI = vscode.QuickPickItem & { sha: string };
  const picked = await vscode.window.showQuickPick<CI>(
    commits.map(c => ({ label: `$(git-commit) ${c.subject}`, description: `${c.short} · ${c.author} · ${c.date}`, sha: c.sha })),
    { title: `History for ${file.name}`, matchOnDescription: true, placeHolder: 'Select a commit to view its changes to this file' },
  );
  if (!picked) return;
  // Note: with --follow, renames may make the path differ in older commits; the provider shows empty content then.
  const left = showUri(root, `${picked.sha}~1`, file.rel);
  const right = showUri(root, picked.sha, file.rel);
  await vscode.commands.executeCommand('vscode.diff', left, right, `${file.name} (${picked.sha.slice(0, 8)})`);
}

// ---------------------------------------------------------------------------
// Annotate
// ---------------------------------------------------------------------------

export async function annotate(): Promise<void> {
  for (const id of ['git.blame.toggleEditorDecoration', 'gitlens.toggleFileBlame']) {
    if (await commandExists(id)) { await vscode.commands.executeCommand(id); return; }
  }
  void vscode.window.showInformationMessage(
    'Annotate is not available: update VS Code (1.96+) for built-in Git blame, or install a blame extension.');
}

// ---------------------------------------------------------------------------
// Show Diff
// ---------------------------------------------------------------------------

export async function showDiff(file: ActiveFile): Promise<void> {
  await vscode.commands.executeCommand('git.openChange', file.uri);
}

// ---------------------------------------------------------------------------
// Push / Fetch / Update
// ---------------------------------------------------------------------------

export async function push(ctx: PopupContext, root: string, state: RepoState): Promise<void> {
  const branch = state.currentBranch;
  if (!branch) { void vscode.window.showWarningMessage('Cannot push: HEAD is detached.'); return; }
  const info = (await ctx.git.listBranches(root)).find(b => b.kind === 'local' && b.name === branch);
  const upstream = info?.upstream;
  let detail: string;
  if (upstream) {
    const commits = await ctx.git.logBetween(root, branch, upstream);
    if (!commits.length) { void vscode.window.showInformationMessage(`Nothing to push: ${branch} is up to date with ${upstream}.`); return; }
    const shown = commits.slice(0, 20).join('\n');
    detail = `${commits.length} commit(s) to ${upstream}:\n\n${shown}${commits.length > 20 ? `\n… and ${commits.length - 20} more` : ''}`;
  } else {
    detail = `Branch has no upstream. It will be pushed and tracking will be set up.`;
  }
  const ok = await vscode.window.showInformationMessage(`Push ${branch}${upstream ? ` → ${upstream}` : ''}?`, { modal: true, detail }, 'Push');
  if (ok !== 'Push') return;
  await mutate(`Pushing ${branch}…`, () => ctx.git.push(root, branch, { setUpstream: !upstream }));
  void vscode.window.showInformationMessage(`Pushed ${branch}`);
}

export async function fetch(ctx: PopupContext, root: string): Promise<void> {
  await mutate('Fetching…', () => ctx.git.fetch(root));
  void vscode.window.showInformationMessage('Fetch finished');
}

export async function updateProject(ctx: PopupContext, root: string): Promise<void> {
  await mutate('Updating project…', () => ctx.git.updateProject(root));
  void vscode.window.showInformationMessage('Project updated');
}

// ---------------------------------------------------------------------------
// Stash
// ---------------------------------------------------------------------------

export async function stashChanges(ctx: PopupContext, root: string): Promise<void> {
  const message = await vscode.window.showInputBox({
    title: 'Stash Changes', prompt: 'Stash message (optional)', placeHolder: 'Message', ignoreFocusOut: true,
  });
  if (message === undefined) return;
  const choice = await vscode.window.showQuickPick(
    [{ label: 'Tracked files only', value: false }, { label: 'Include untracked files', value: true }],
    { title: 'Stash Changes', placeHolder: 'Include untracked files?' },
  );
  if (!choice) return;
  await vscode.workspace.saveAll(false);
  await mutate('Stashing changes…', () => ctx.git.stash(root, message.trim() || undefined, choice.value));
}

export async function unstashChildren(ctx: PopupContext, root: string): Promise<PopupItem[]> {
  const stashes = await ctx.git.listStashes(root);
  if (!stashes.length) return [{ label: 'No stashes', disabled: true }];
  return stashes.map((s: StashEntry): PopupItem => ({
    label: s.message || s.ref,
    description: s.ref,
    icon: 'archive',
    childrenTitle: s.ref,
    children: () => [
      { label: 'Pop', icon: 'export', run: () => mutate(`Popping ${s.ref}…`, () => ctx.git.stashPop(root, s.index)) },
      { label: 'Apply', icon: 'check', run: () => mutate(`Applying ${s.ref}…`, () => ctx.git.stashApply(root, s.index)) },
      {
        label: 'Drop…', icon: 'trash',
        run: async () => {
          const ok = await vscode.window.showWarningMessage(`Drop ${s.ref}?`, { modal: true, detail: s.message }, 'Drop');
          if (ok !== 'Drop') return;
          await mutate(`Dropping ${s.ref}…`, () => ctx.git.stashDrop(root, s.index));
        },
      },
    ],
  }));
}

// ---------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------

export async function worktreeChildren(ctx: PopupContext, root: string): Promise<PopupItem[]> {
  const wts = await ctx.git.listWorktrees(root);
  const norm = (p: string) => path.resolve(p);
  const items: PopupItem[] = wts.map((w: WorktreeInfo): PopupItem => {
    const isThis = norm(w.path) === norm(root);
    return {
      label: w.branch ?? `(detached ${w.head.slice(0, 8)})`,
      description: `${w.path}${w.isMain ? '  (main)' : ''}${isThis ? '  (current)' : ''}`,
      icon: isThis ? 'check' : 'folder',
      childrenTitle: w.path,
      children: () => [
        { label: 'Open in New Window', icon: 'empty-window', run: () => vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(w.path), { forceNewWindow: true }) },
        { label: 'Open in This Window', icon: 'folder-opened', disabled: isThis, run: () => vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(w.path), { forceNewWindow: false }) },
        {
          label: 'Remove Worktree…', icon: 'trash', disabled: w.isMain || isThis,
          run: async () => {
            const ok = await vscode.window.showWarningMessage(`Remove worktree ${w.path}?`, { modal: true }, 'Remove');
            if (ok !== 'Remove') return;
            await mutate('Removing worktree…', () => ctx.git.removeWorktree(root, w.path));
          },
        },
      ],
    };
  });
  items.push({ label: 'New Worktree…', icon: 'add', separatorBefore: true, run: () => newWorktree(ctx, root) });
  return items;
}

async function newWorktree(ctx: PopupContext, root: string): Promise<void> {
  const branches = (await ctx.git.listBranches(root)).filter(b => b.kind === 'local' || b.kind === 'remote');
  const base = await vscode.window.showQuickPick(
    branches.map(b => ({ label: b.name, description: b.kind === 'remote' ? 'remote' : b.isCurrent ? 'current' : '', b })),
    { title: 'New Worktree: base branch', placeHolder: 'Branch to check out in the new worktree' },
  );
  if (!base) return;
  const isRemote = base.b.kind === 'remote';
  const suggested = isRemote ? base.b.name.replace(/^[^/]+\//, '') : '';
  const newBranch = await vscode.window.showInputBox({
    title: 'New Worktree: new branch',
    prompt: isRemote ? 'Local branch name to create' : 'New branch name (leave empty to check out the existing branch)',
    value: suggested, ignoreFocusOut: true,
    validateInput: v => (isRemote && !v.trim() ? 'A local branch name is required for a remote branch' : /\s/.test(v.trim()) ? 'Branch name must not contain spaces' : undefined),
  });
  if (newBranch === undefined) return;
  const leaf = (newBranch.trim() || base.b.name).replace(/[\\/]/g, '-');
  const wtPath = await vscode.window.showInputBox({
    title: 'New Worktree: location', prompt: 'Worktree directory',
    value: path.join(path.dirname(root), `${path.basename(root)}-${leaf}`), ignoreFocusOut: true,
    validateInput: v => (v.trim() ? undefined : 'Path is required'),
  });
  if (!wtPath) return;
  await mutate('Creating worktree…', () => ctx.git.addWorktree(root, wtPath.trim(), base.b.name, newBranch.trim() || undefined));
  const open = await vscode.window.showInformationMessage(`Worktree created at ${wtPath}`, 'Open in New Window');
  if (open) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wtPath.trim()), { forceNewWindow: true });
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export async function copyBranchName(state: RepoState): Promise<void> {
  const name = state.currentBranch ?? state.detachedAt;
  if (!name) return;
  await vscode.env.clipboard.writeText(name);
  void vscode.window.showInformationMessage(`Copied "${name}" to clipboard`);
}

export async function showLocalHistory(): Promise<void> {
  await vscode.commands.executeCommand('timeline.focus');
}
