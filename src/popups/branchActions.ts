import * as vscode from 'vscode';
import * as path from 'path';
import type { BranchInfo } from '../git/types';
import type { PopupContext } from './context';

export const REF_SCHEME = 'gitpopups-ref';

function errMsg(e: unknown): string {
  const anyE = e as any;
  return String(anyE?.stderr || anyE?.message || anyE);
}

async function refreshScm(): Promise<void> {
  try { await vscode.commands.executeCommand('git.refresh'); } catch { /* ignore */ }
}

/** Runs a git operation with a progress notification; reports errors; refreshes the git view afterwards. */
export async function runOp(title: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, () => fn());
    return true;
  } catch (e) {
    void vscode.window.showErrorMessage(`Git: ${errMsg(e)}`);
    return false;
  } finally {
    await refreshScm();
  }
}

/** Like runOp but rethrows errors (for callers that want to inspect them). */
async function withProgressRaw<T>(title: string, fn: () => Promise<T>): Promise<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, () => fn());
}

// ---------------------------------------------------------------- checkout

/**
 * Checkout with IntelliJ-style handling of local changes that would be overwritten:
 * offers Smart Checkout (stash, checkout, unstash) / Force Checkout.
 */
export async function checkoutWithSmartHandling(ctx: PopupContext, root: string, label: string, doCheckout: () => Promise<void>, ref: string): Promise<void> {
  try {
    await withProgressRaw(`Checking out ${label}…`, doCheckout);
  } catch (e) {
    const msg = errMsg(e);
    if (!/would be overwritten/i.test(msg)) {
      void vscode.window.showErrorMessage(`Git: ${msg}`);
      await refreshScm();
      return;
    }
    const SMART = 'Smart Checkout (stash, checkout, unstash)';
    const FORCE = 'Force Checkout';
    const choice = await vscode.window.showWarningMessage(
      `Checkout of '${label}' would overwrite your local changes.`,
      { modal: true, detail: msg }, SMART, FORCE);
    if (choice === SMART) {
      await runOp(`Smart checkout of ${label}…`, async () => {
        await ctx.git.stash(root, `gitpopups: smart checkout to ${label}`, false);
        try {
          await doCheckout();
        } catch (err) {
          // restore changes on the original branch
          await ctx.git.stashPop(root, 0).catch(() => undefined);
          throw err;
        }
        try {
          await ctx.git.stashPop(root, 0);
        } catch (err) {
          throw new Error(`Checked out '${label}', but unstashing produced conflicts. Resolve them; the stash was kept. ${errMsg(err)}`);
        }
      });
    } else if (choice === FORCE) {
      await runOp(`Force checkout of ${label}…`, () => ctx.git.exec(root, ['checkout', '-f', ref]));
    }
  }
  await refreshScm();
}

export async function checkoutLocal(ctx: PopupContext, root: string, b: BranchInfo): Promise<void> {
  await checkoutWithSmartHandling(ctx, root, b.name, () => ctx.git.checkout(root, b.name), b.name);
}

function remoteShortName(b: BranchInfo): string {
  if (b.remote && b.name.startsWith(b.remote + '/')) return b.name.slice(b.remote.length + 1);
  const i = b.name.indexOf('/');
  return i >= 0 ? b.name.slice(i + 1) : b.name;
}

function remoteOf(b: BranchInfo): string {
  return b.remote ?? b.name.split('/')[0];
}

export async function checkoutRemote(ctx: PopupContext, root: string, b: BranchInfo, all: BranchInfo[]): Promise<void> {
  const local = remoteShortName(b);
  const existing = all.find(x => x.kind === 'local' && x.name === local);
  if (!existing) {
    await checkoutWithSmartHandling(ctx, root, local, () => ctx.git.checkoutRemote(root, b.name, local), b.name);
    return;
  }
  const CHECKOUT = `Checkout Existing '${local}'`;
  const RESET = `Reset '${local}' to '${b.name}'`;
  const choice = await vscode.window.showWarningMessage(
    `Local branch '${local}' already exists.`, { modal: true }, CHECKOUT, RESET);
  if (choice === CHECKOUT) {
    await checkoutLocal(ctx, root, existing);
  } else if (choice === RESET) {
    await checkoutWithSmartHandling(ctx, root, local,
      async () => { await ctx.git.exec(root, ['checkout', '-B', local, '--track', b.name]); }, b.name);
  }
}

// ---------------------------------------------------------------- new branch / tag

async function validateBranchName(ctx: PopupContext, root: string, name: string): Promise<string | undefined> {
  if (!name) return 'Branch name is required';
  if (/\s/.test(name)) return 'Branch name must not contain spaces';
  try {
    await ctx.git.exec(root, ['check-ref-format', '--branch', name]);
    return undefined;
  } catch {
    return `'${name}' is not a valid branch name`;
  }
}

async function askBranchName(ctx: PopupContext, root: string, title: string, value = ''): Promise<string | undefined> {
  const name = await vscode.window.showInputBox({
    title,
    prompt: 'New branch name',
    value,
    validateInput: v => validateBranchName(ctx, root, v.trim()),
  });
  return name?.trim() || undefined;
}

export async function newBranch(ctx: PopupContext, root: string, from: string, fromLabel?: string): Promise<void> {
  const title = fromLabel ? `Create New Branch from '${fromLabel}'` : 'Create New Branch';
  const name = await askBranchName(ctx, root, title);
  if (!name) return;
  const yes: vscode.QuickPickItem = { label: '$(check) Checkout branch', description: `switch to '${name}' after creating` };
  const no: vscode.QuickPickItem = { label: '$(circle-large-outline) Do not checkout', description: 'only create the branch' };
  const pick = await vscode.window.showQuickPick([yes, no], { title: `${title}: '${name}'`, placeHolder: 'Checkout branch?' });
  if (!pick) return;
  const checkout = pick === yes;
  if (checkout) {
    await checkoutWithSmartHandling(ctx, root, name, () => ctx.git.createBranch(root, name, from, true), name);
  } else {
    await runOp(`Creating branch ${name}…`, () => ctx.git.createBranch(root, name, from, false));
  }
}

export async function checkoutTagOrRevision(ctx: PopupContext, root: string): Promise<void> {
  let tags: string[] = [];
  try {
    tags = (await ctx.git.exec(root, ['tag', '--sort=-creatordate'])).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch { /* no tags */ }
  type Item = vscode.QuickPickItem & { ref?: string };
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = 'Checkout Tag or Revision';
  qp.placeholder = 'Enter a tag, branch, or commit hash';
  const tagItems: Item[] = tags.map(t => ({ label: `$(tag) ${t}`, ref: t }));
  const render = () => {
    const v = qp.value.trim();
    const free: Item[] = v && !tags.includes(v)
      ? [{ label: `$(git-commit) ${v}`, description: 'revision', ref: v, alwaysShow: true }]
      : [];
    qp.items = [...free, ...(tagItems.length ? [{ label: 'Tags', kind: vscode.QuickPickItemKind.Separator } as Item] : []), ...tagItems];
  };
  render();
  const ref = await new Promise<string | undefined>(resolve => {
    let done = false;
    qp.onDidChangeValue(render);
    qp.onDidAccept(() => {
      done = true;
      resolve(qp.activeItems[0]?.ref ?? (qp.value.trim() || undefined));
      qp.hide();
    });
    qp.onDidHide(() => { if (!done) resolve(undefined); qp.dispose(); });
    qp.show();
  });
  if (!ref) return;
  await checkoutWithSmartHandling(ctx, root, ref, () => ctx.git.checkout(root, ref), ref);
}

// ---------------------------------------------------------------- compare / diff

export async function compareWithCurrent(ctx: PopupContext, root: string, branch: string, current: string): Promise<void> {
  let inBranch: string[] = [];
  let inCurrent: string[] = [];
  try {
    [inBranch, inCurrent] = await withProgressRaw(`Comparing ${branch} with ${current}…`, () => Promise.all([
      ctx.git.logBetween(root, branch, current),
      ctx.git.logBetween(root, current, branch),
    ]));
  } catch (e) {
    void vscode.window.showErrorMessage(`Git: ${errMsg(e)}`);
    return;
  }
  type Item = vscode.QuickPickItem & { sha?: string };
  const toItems = (lines: string[]): Item[] => lines.length
    ? lines.map(l => {
      const m = /^(\S+)\s+(.*)$/.exec(l);
      return m ? { label: `$(git-commit) ${m[2]}`, description: m[1], sha: m[1] } : { label: l };
    })
    : [{ label: '$(info) No commits' }];
  const items: Item[] = [
    { label: `Commits in '${branch}' that are not in '${current}' (${inBranch.length})`, kind: vscode.QuickPickItemKind.Separator },
    ...toItems(inBranch),
    { label: `Commits in '${current}' that are not in '${branch}' (${inCurrent.length})`, kind: vscode.QuickPickItemKind.Separator },
    ...toItems(inCurrent),
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title: `Compare '${branch}' with '${current}'`,
    placeHolder: 'Select a commit to show its changes',
    matchOnDescription: true,
  });
  if (!pick?.sha) return;
  try {
    const content = await ctx.git.exec(root, ['show', '--stat', '--patch', pick.sha]);
    const doc = await vscode.workspace.openTextDocument({ content, language: 'diff' });
    await vscode.window.showTextDocument(doc, { preview: true });
  } catch (e) {
    void vscode.window.showErrorMessage(`Git: ${errMsg(e)}`);
  }
}

export function refUri(root: string, ref: string, relPath: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: REF_SCHEME,
    path: '/' + relPath.replace(/\\/g, '/'),
    query: JSON.stringify({ root, ref, path: relPath }),
  });
}

export class RefContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly ctx: PopupContext) {}
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    try {
      const q = JSON.parse(uri.query) as { root: string; ref: string; path: string };
      if (!q.ref) return '';
      return await this.ctx.git.exec(q.root, ['show', `${q.ref}:${q.path}`]);
    } catch {
      return ''; // file does not exist in that revision
    }
  }
}

export async function showDiffWithWorkingTree(ctx: PopupContext, root: string, ref: string): Promise<void> {
  let files: string[];
  try {
    files = await withProgressRaw(`Collecting changes against ${ref}…`, () => ctx.git.diffNames(root, ref));
  } catch (e) {
    void vscode.window.showErrorMessage(`Git: ${errMsg(e)}`);
    return;
  }
  if (!files.length) {
    void vscode.window.showInformationMessage(`No differences between '${ref}' and the working tree.`);
    return;
  }
  type Item = vscode.QuickPickItem & { file: string };
  const items: Item[] = files.map(f => ({
    label: `$(file) ${path.basename(f)}`,
    description: path.dirname(f) === '.' ? '' : path.dirname(f),
    file: f,
  }));
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = `Diff '${ref}' with Working Tree (${files.length} files)`;
  qp.placeholder = 'Select a file to open the diff';
  qp.matchOnDescription = true;
  qp.items = items;
  qp.onDidAccept(async () => {
    const it = qp.activeItems[0];
    if (!it) return;
    const left = refUri(root, ref, it.file);
    const fileUri = vscode.Uri.file(path.join(root, it.file));
    let right: vscode.Uri = fileUri;
    try { await vscode.workspace.fs.stat(fileUri); } catch { right = refUri(root, '', it.file); }
    await vscode.commands.executeCommand('vscode.diff', left, right, `${it.file} (${ref} ↔ Working Tree)`, { preview: true, preserveFocus: true });
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}

// ---------------------------------------------------------------- other ops

export function merge(ctx: PopupContext, root: string, ref: string, current: string) {
  return runOp(`Merging ${ref} into ${current}…`, () => ctx.git.merge(root, ref));
}

export function rebase(ctx: PopupContext, root: string, onto: string, current: string) {
  return runOp(`Rebasing ${current} onto ${onto}…`, () => ctx.git.rebase(root, onto));
}

export function checkoutAndRebase(ctx: PopupContext, root: string, branch: string, current: string) {
  return runOp(`Checking out ${branch} and rebasing onto ${current}…`, () => ctx.git.checkoutAndRebaseOntoCurrent(root, branch));
}

export function updateBranch(ctx: PopupContext, root: string, b: BranchInfo) {
  return runOp(`Updating ${b.name}…`, () => ctx.git.updateBranch(root, b));
}

export function push(ctx: PopupContext, root: string, b: BranchInfo) {
  return runOp(`Pushing ${b.name}…`, () => ctx.git.push(root, b.name, { setUpstream: !b.upstream }));
}

export function pullIntoCurrentMerge(ctx: PopupContext, root: string, b: BranchInfo, current: string) {
  return runOp(`Pulling ${b.name} into ${current}…`,
    () => ctx.git.exec(root, ['pull', '--no-rebase', remoteOf(b), remoteShortName(b)]));
}

export async function rename(ctx: PopupContext, root: string, b: BranchInfo): Promise<void> {
  const name = await askBranchName(ctx, root, `Rename Branch '${b.name}'`, b.name);
  if (!name || name === b.name) return;
  await runOp(`Renaming ${b.name} to ${name}…`, () => ctx.git.renameBranch(root, b.name, name));
}

export async function deleteLocal(ctx: PopupContext, root: string, b: BranchInfo): Promise<void> {
  const ok = await vscode.window.showWarningMessage(`Delete branch '${b.name}'?`, { modal: true }, 'Delete');
  if (ok !== 'Delete') return;
  try {
    await withProgressRaw(`Deleting ${b.name}…`, () => ctx.git.deleteBranch(root, b.name, false));
    void vscode.window.showInformationMessage(`Deleted branch '${b.name}'.`);
  } catch (e) {
    const msg = errMsg(e);
    if (/not fully merged/i.test(msg)) {
      const force = await vscode.window.showWarningMessage(
        `Branch '${b.name}' is not fully merged.`,
        { modal: true, detail: 'Deleting it may lose commits that exist only on this branch.' }, 'Force Delete');
      if (force === 'Force Delete') {
        await runOp(`Force deleting ${b.name}…`, () => ctx.git.deleteBranch(root, b.name, true));
      }
    } else {
      void vscode.window.showErrorMessage(`Git: ${msg}`);
    }
  }
  await refreshScm();
}

export async function deleteRemote(ctx: PopupContext, root: string, b: BranchInfo): Promise<void> {
  const ok = await vscode.window.showWarningMessage(
    `Delete remote branch '${b.name}'?`, { modal: true, detail: 'The branch will be removed from the remote repository.' }, 'Delete');
  if (ok !== 'Delete') return;
  await runOp(`Deleting remote branch ${b.name}…`, () => ctx.git.deleteRemoteBranch(root, remoteOf(b), remoteShortName(b)));
}

export async function newWorktree(ctx: PopupContext, root: string, b: BranchInfo): Promise<void> {
  const repoName = path.basename(root);
  const branchForPath = b.kind === 'remote' ? remoteShortName(b) : b.name;
  const defaultPath = path.join(path.dirname(root), `${repoName}-${branchForPath.replace(/[\\/]/g, '-')}`);
  const target = await vscode.window.showInputBox({
    title: `New Worktree from '${b.name}'`,
    prompt: 'Worktree directory',
    value: defaultPath,
    validateInput: v => (v.trim() ? undefined : 'Path is required'),
  });
  if (!target) return;
  let newBranchName: string | undefined;
  if (b.kind === 'remote') {
    newBranchName = await askBranchName(ctx, root, `New Worktree: local branch for '${b.name}'`, branchForPath);
    if (!newBranchName) return;
  }
  const ok = await runOp(`Creating worktree at ${target}…`, () => ctx.git.addWorktree(root, target.trim(), b.name, newBranchName));
  if (!ok) return;
  const open = await vscode.window.showInformationMessage(`Worktree created at ${target}.`, 'Open in New Window');
  if (open) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target.trim()), { forceNewWindow: true });
}
