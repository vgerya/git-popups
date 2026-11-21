import * as vscode from 'vscode';
import * as path from 'path';
import type { BranchInfo, RepoState } from '../git/types';
import type { PopupContext } from './context';
import { getFavorites } from './favorites';
import * as A from './branchActions';

const INDENT = '  ';
const IS_MAC = process.platform === 'darwin';
const k = (mac: string, other: string) => (IS_MAC ? mac : other);

/** Collapsed folder rows, kept for the session. Key: "<group>:<folder path>". */
const collapsed = new Set<string>();

interface Row extends vscode.QuickPickItem {
  action?: () => unknown;
  branch?: BranchInfo;
  folderKey?: string;
}

interface Data {
  root: string;
  state: RepoState;
  branches: BranchInfo[];
  recent: string[];
  favorites: Set<string>;
}

async function loadData(ctx: PopupContext, root: string): Promise<Data> {
  const limit = vscode.workspace.getConfiguration('gitPopups').get<number>('recentBranchesLimit') ?? 5;
  const [state, branches, recent] = await Promise.all([
    ctx.git.getState(root),
    ctx.git.listBranches(root),
    limit > 0 ? ctx.git.recentBranches(root, limit).catch(() => [] as string[]) : Promise.resolve([] as string[]),
  ]);
  return { root, state, branches, recent, favorites: getFavorites(ctx.extension).get(root) };
}

// ------------------------------------------------------------------ rows

function aheadBehind(b: BranchInfo): string {
  const parts: string[] = [];
  if (b.ahead) parts.push(`↑${b.ahead}`);
  if (b.behind) parts.push(`↓${b.behind}`);
  return parts.join(' ');
}

function branchRow(d: Data, b: BranchInfo, label: string, level: number): Row {
  const fav = d.favorites.has(b.name);
  const icon = b.isCurrent ? 'check' : fav ? 'star-full' : 'git-branch';
  const desc: string[] = [];
  const ab = aheadBehind(b);
  if (ab) desc.push(ab);
  if (b.kind === 'local' && b.upstream) desc.push(b.upstream);
  if (b.isCurrent) desc.push('current');
  return {
    label: `${INDENT.repeat(level)}$(${icon}) ${label}`,
    description: desc.join('   '),
    branch: b,
    buttons: [{
      iconPath: new vscode.ThemeIcon(fav ? 'star-full' : 'star-empty'),
      tooltip: fav ? 'Remove from Favorites' : 'Add to Favorites',
    }],
  };
}

interface TreeNode { folders: Map<string, TreeNode>; branches: { leaf: string; b: BranchInfo }[]; }
const newNode = (): TreeNode => ({ folders: new Map(), branches: [] });

function buildTree(list: BranchInfo[]): TreeNode {
  const rootNode = newNode();
  for (const b of list) {
    const segs = b.name.split('/');
    let node = rootNode;
    for (const s of segs.slice(0, -1)) {
      let next = node.folders.get(s);
      if (!next) { next = newNode(); node.folders.set(s, next); }
      node = next;
    }
    node.branches.push({ leaf: segs[segs.length - 1], b });
  }
  return rootNode;
}

function renderTree(d: Data, node: TreeNode, group: string, prefix: string, level: number, out: Row[]): void {
  for (const name of [...node.folders.keys()].sort((a, b) => a.localeCompare(b))) {
    const p = prefix ? `${prefix}/${name}` : name;
    const key = `${group}:${p}`;
    const isCollapsed = collapsed.has(key);
    out.push({
      label: `${INDENT.repeat(level)}$(${isCollapsed ? 'chevron-right' : 'chevron-down'}) $(folder) ${name}`,
      folderKey: key,
    });
    if (!isCollapsed) renderTree(d, node.folders.get(name)!, group, p, level + 1, out);
  }
  for (const { leaf, b } of [...node.branches].sort((a, c) => a.leaf.localeCompare(c.leaf))) {
    out.push(branchRow(d, b, leaf, level));
  }
}

function groupRows(d: Data, list: BranchInfo[], group: string, flat: boolean): Row[] {
  const out: Row[] = [];
  const current = list.filter(b => b.isCurrent);
  const favs = list.filter(b => !b.isCurrent && d.favorites.has(b.name)).sort((a, b) => a.name.localeCompare(b.name));
  const rest = list.filter(b => !b.isCurrent && !d.favorites.has(b.name));
  for (const b of [...current, ...favs]) out.push(branchRow(d, b, b.name, 0));
  if (flat) {
    for (const b of rest.sort((a, c) => a.name.localeCompare(c.name))) out.push(branchRow(d, b, b.name, 0));
  } else {
    renderTree(d, buildTree(rest), group, '', 0, out);
  }
  return out;
}

function topActions(ctx: PopupContext, d: Data): Row[] {
  const { root, state } = d;
  const cur = state.currentBranch;
  const curInfo = d.branches.find(b => b.kind === 'local' && b.isCurrent);
  return [
    {
      label: '$(arrow-down) Update Project…', description: k('⌘T', 'Ctrl+T'),
      action: () => A.runOp('Updating project…', () => ctx.git.updateProject(root)),
    },
    {
      label: '$(check) Commit…', description: k('⌘K', 'Ctrl+K'),
      action: async () => {
        try { await vscode.commands.executeCommand('workbench.scm.focus'); }
        catch { await vscode.commands.executeCommand('workbench.view.scm'); }
      },
    },
    {
      label: '$(arrow-up) Push…', description: k('⇧⌘K', 'Ctrl+Shift+K'),
      action: () => {
        if (!cur || !curInfo) { void vscode.window.showWarningMessage('Cannot push: HEAD is detached.'); return; }
        return A.push(ctx, root, curInfo);
      },
    },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    {
      label: '$(add) New Branch…', description: k('⌥⌘N', 'Ctrl+Alt+N'),
      action: () => A.newBranch(ctx, root, 'HEAD'),
    },
    {
      label: '$(tag) Checkout Tag or Revision…',
      action: () => A.checkoutTagOrRevision(ctx, root),
    },
  ];
}

function buildRows(ctx: PopupContext, d: Data, filter: string): Row[] {
  const flat = filter.trim().length > 0;
  const rows: Row[] = topActions(ctx, d);
  const locals = d.branches.filter(b => b.kind === 'local');
  const remotes = d.branches.filter(b => b.kind === 'remote');

  const recent = d.recent
    .map(n => locals.find(b => b.name === n))
    .filter((b): b is BranchInfo => !!b && !b.isCurrent);
  if (recent.length) {
    rows.push({ label: 'Recent', kind: vscode.QuickPickItemKind.Separator });
    for (const b of recent) rows.push(branchRow(d, b, b.name, 0));
  }
  if (locals.length) {
    rows.push({ label: 'Local', kind: vscode.QuickPickItemKind.Separator });
    rows.push(...groupRows(d, locals, 'local', flat));
  }
  if (remotes.length) {
    rows.push({ label: 'Remote', kind: vscode.QuickPickItemKind.Separator });
    rows.push(...groupRows(d, remotes, 'remote', flat));
  }
  return rows;
}

// ------------------------------------------------------------------ main popup

async function resolveRoot(ctx: PopupContext): Promise<string | undefined> {
  const root = await ctx.git.getRepoRoot();
  if (!root) void vscode.window.showInformationMessage('No Git repository found in the current workspace.');
  return root;
}

export async function showBranchesPopup(ctx: PopupContext): Promise<void> {
  const root = await resolveRoot(ctx);
  if (!root) return;

  const qp = vscode.window.createQuickPick<Row>();
  qp.title = `Git Branches — ${path.basename(root)}`;
  qp.placeholder = 'Search for branches and actions';
  qp.matchOnDescription = false;
  qp.busy = true;
  qp.show();

  let data: Data;
  try {
    data = await loadData(ctx, root);
  } catch (e: any) {
    qp.hide();
    void vscode.window.showErrorMessage(`Git: ${e?.message ?? e}`);
    return;
  }
  const d = data;

  let lastFlat: boolean | undefined;
  const render = (keepActive?: Row) => {
    const flat = qp.value.trim().length > 0;
    lastFlat = flat;
    const rows = buildRows(ctx, d, qp.value);
    qp.items = rows;
    if (keepActive) {
      const same = rows.find(r =>
        (keepActive.folderKey && r.folderKey === keepActive.folderKey) ||
        (keepActive.branch && r.branch?.ref === keepActive.branch.ref));
      if (same) qp.activeItems = [same];
    }
  };
  render();
  qp.busy = false;

  const disposables: vscode.Disposable[] = [];
  disposables.push(
    qp.onDidChangeValue(v => {
      const flat = v.trim().length > 0;
      if (flat !== lastFlat) render();
    }),
    qp.onDidAccept(() => {
      const it = qp.activeItems[0];
      if (!it) return;
      if (it.folderKey) {
        if (collapsed.has(it.folderKey)) collapsed.delete(it.folderKey); else collapsed.add(it.folderKey);
        render(it);
        return;
      }
      if (it.branch) {
        const b = it.branch;
        qp.hide();
        void showBranchSubmenu(ctx, d, b);
        return;
      }
      if (it.action) {
        const act = it.action;
        qp.hide();
        Promise.resolve()
          .then(() => act())
          .catch(e => vscode.window.showErrorMessage(`Git: ${e?.message ?? e}`));
      }
    }),
    qp.onDidTriggerItemButton(async e => {
      const b = e.item.branch;
      if (!b) return;
      await getFavorites(ctx.extension).toggle(root, b.name);
      d.favorites = getFavorites(ctx.extension).get(root);
      render(e.item);
    }),
    qp.onDidHide(() => { disposables.forEach(x => x.dispose()); qp.dispose(); }),
  );
}

// ------------------------------------------------------------------ branch submenu

function branchSubmenuRows(ctx: PopupContext, d: Data, b: BranchInfo): Row[] {
  const { root } = d;
  const cur = d.state.currentBranch;
  const rows: Row[] = [];
  const add = (label: string, action: () => unknown, description?: string) => rows.push({ label, action, description });
  const sep = () => rows.push({ label: '', kind: vscode.QuickPickItemKind.Separator });

  if (b.kind === 'local') {
    if (!b.isCurrent) add('$(git-branch) Checkout', () => A.checkoutLocal(ctx, root, b));
    add(`$(add) New Branch from '${b.name}'…`, () => A.newBranch(ctx, root, b.name, b.name));
    if (!b.isCurrent && cur) add(`$(git-pull-request) Checkout and Rebase onto '${cur}'`, () => A.checkoutAndRebase(ctx, root, b.name, cur));
    sep();
    if (!b.isCurrent && cur) add(`$(git-compare) Compare with '${cur}'`, () => A.compareWithCurrent(ctx, root, b.name, cur));
    add('$(diff) Show Diff with Working Tree', () => A.showDiffWithWorkingTree(ctx, root, b.name));
    sep();
    if (!b.isCurrent && cur) {
      add(`$(git-pull-request) Rebase '${cur}' onto '${b.name}'`, () => A.rebase(ctx, root, b.name, cur));
      add(`$(git-merge) Merge '${b.name}' into '${cur}'`, () => A.merge(ctx, root, b.name, cur));
      sep();
    }
    add(`$(folder-library) New Worktree from '${b.name}'…`, () => A.newWorktree(ctx, root, b));
    if (b.upstream) add('$(arrow-down) Update', () => A.updateBranch(ctx, root, b));
    add('$(arrow-up) Push…', () => A.push(ctx, root, b), k('⇧⌘K', 'Ctrl+Shift+K'));
    sep();
    add('$(edit) Rename…', () => A.rename(ctx, root, b), 'F2');
    if (!b.isCurrent) add('$(trash) Delete', () => A.deleteLocal(ctx, root, b));
  } else {
    add('$(git-branch) Checkout', () => A.checkoutRemote(ctx, root, b, d.branches));
    add(`$(add) New Branch from '${b.name}'…`, () => A.newBranch(ctx, root, b.name, b.name));
    if (cur) add(`$(git-pull-request) Checkout and Rebase onto '${cur}'`, () => A.checkoutAndRebase(ctx, root, b.name, cur));
    sep();
    if (cur) add(`$(git-compare) Compare with '${cur}'`, () => A.compareWithCurrent(ctx, root, b.name, cur));
    add('$(diff) Show Diff with Working Tree', () => A.showDiffWithWorkingTree(ctx, root, b.name));
    sep();
    if (cur) {
      add(`$(git-pull-request) Rebase '${cur}' onto '${b.name}'`, () => A.rebase(ctx, root, b.name, cur));
      add(`$(git-merge) Merge '${b.name}' into '${cur}'`, () => A.merge(ctx, root, b.name, cur));
      add(`$(repo-pull) Pull into '${cur}' Using Merge`, () => A.pullIntoCurrentMerge(ctx, root, b, cur));
      sep();
    }
    add(`$(folder-library) New Worktree from '${b.name}'…`, () => A.newWorktree(ctx, root, b));
    sep();
    add('$(trash) Delete', () => A.deleteRemote(ctx, root, b));
  }
  // drop leading/trailing/double separators
  return rows.filter((r, i, arr) =>
    r.kind !== vscode.QuickPickItemKind.Separator ||
    (i > 0 && i < arr.length - 1 && arr[i - 1].kind !== vscode.QuickPickItemKind.Separator));
}

async function showBranchSubmenu(ctx: PopupContext, d: Data, b: BranchInfo): Promise<void> {
  const qp = vscode.window.createQuickPick<Row>();
  qp.title = b.name + (b.isCurrent ? ' (current)' : '');
  qp.placeholder = b.kind === 'local' ? 'Local branch actions' : 'Remote branch actions';
  qp.buttons = [vscode.QuickInputButtons.Back];
  qp.items = branchSubmenuRows(ctx, d, b);
  const disposables: vscode.Disposable[] = [];
  disposables.push(
    qp.onDidTriggerButton(btn => {
      if (btn === vscode.QuickInputButtons.Back) { qp.hide(); void showBranchesPopup(ctx); }
    }),
    qp.onDidAccept(() => {
      const act = qp.activeItems[0]?.action;
      if (!act) return;
      qp.hide();
      Promise.resolve()
        .then(() => act())
        .catch(e => vscode.window.showErrorMessage(`Git: ${e?.message ?? e}`));
    }),
    qp.onDidHide(() => { disposables.forEach(x => x.dispose()); qp.dispose(); }),
  );
  qp.show();
}

// ------------------------------------------------------------------ commands

/** Registers `gitPopups.toggleFavoriteBranch` and the `gitpopups-ref` content provider. */
export function registerBranchCommands(ctx: PopupContext): void {
  ctx.extension.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(A.REF_SCHEME, new A.RefContentProvider(ctx)),
    vscode.commands.registerCommand('gitPopups.toggleFavoriteBranch', async (arg?: unknown) => {
      const root = await resolveRoot(ctx);
      if (!root) return;
      const favs = getFavorites(ctx.extension);
      let name = typeof arg === 'string' ? arg : (arg as BranchInfo | undefined)?.name;
      if (!name) {
        let branches: BranchInfo[];
        try { branches = await ctx.git.listBranches(root); }
        catch (e: any) { void vscode.window.showErrorMessage(`Git: ${e?.message ?? e}`); return; }
        const set = favs.get(root);
        const pick = await vscode.window.showQuickPick(
          branches.map(b => ({
            label: `$(${set.has(b.name) ? 'star-full' : 'star-empty'}) ${b.name}`,
            description: b.kind === 'remote' ? 'remote' : b.isCurrent ? 'current' : '',
            name: b.name,
          })),
          { title: 'Toggle Favorite Branch', placeHolder: 'Select a branch' });
        name = pick?.name;
      }
      if (!name) return;
      const now = await favs.toggle(root, name);
      void vscode.window.setStatusBarMessage(`${name} ${now ? 'added to' : 'removed from'} favorites`, 3000);
    }),
  );
}
