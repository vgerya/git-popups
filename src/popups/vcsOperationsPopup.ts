import * as vscode from 'vscode';
import type { PopupContext } from './context';
import { showPopup, type PopupItem } from '../ui/popup';
import type { RepoState } from '../git/types';
import * as A from './vcsActions';

const { sc } = A;

/** IntelliJ IDEA "VCS Operations" quick popup (Ctrl+V on mac / Alt+` elsewhere). */
export async function showVcsOperationsPopup(ctx: PopupContext): Promise<void> {
  const root = await ctx.git.getRepoRoot();
  if (!root) { void vscode.window.showInformationMessage('No Git repository'); return; }

  await showPopup(() => buildItems(ctx, root), {
    title: 'VCS Operations',
    mnemonics: true,
  });
}

async function buildItems(ctx: PopupContext, root: string): Promise<PopupItem[]> {
  let state: RepoState;
  try {
    state = await ctx.git.getState(root);
  } catch (e: any) {
    void vscode.window.showErrorMessage(`Git: ${e?.message ?? e}`);
    state = { root, hasChanges: false, hasStagedChanges: false, hasStash: false };
  }
  const file = await A.getActiveFile(ctx, root, state);
  const fileName = file?.name ?? 'File';
  const notModified = !file?.modified;
  const notTracked = !file?.tracked;

  const items: PopupItem[] = [];

  if (state.operationInProgress) {
    items.push(...A.operationItems(ctx, root, state.operationInProgress));
  }

  items.push(
    {
      label: 'Commit…', mnemonic: '1', icon: 'check', shortcut: sc('⌘K', 'Ctrl+K'),
      run: () => A.commitAll(),
    },
    {
      label: 'Commit File…', mnemonic: '2', icon: 'git-commit',
      description: file ? file.name : undefined,
      disabled: notModified,
      run: () => A.commitFile(ctx, root, file!),
    },
    {
      label: 'Rollback…', mnemonic: '3', icon: 'discard', shortcut: sc('⌥⌘Z', 'Ctrl+Alt+Z'),
      disabled: notModified,
      run: () => A.rollbackFile(ctx, root, file!),
    },
    {
      label: `Show History for ${fileName}`, mnemonic: '4', icon: 'history',
      disabled: notTracked,
      run: () => A.showHistory(ctx, root, file!),
    },
    {
      label: 'Annotate with Git Blame', mnemonic: '5', icon: 'person',
      disabled: notTracked,
      run: () => A.annotate(),
    },
    {
      label: 'Show Diff', mnemonic: '6', icon: 'diff', shortcut: sc('⌘D', 'Ctrl+D'),
      disabled: notModified || notTracked,
      run: () => A.showDiff(file!),
    },
    {
      label: 'Branches…', mnemonic: '7', icon: 'git-branch', shortcut: sc('⇧⌘2', 'Ctrl+Shift+`'),
      separatorBefore: true,
      run: () => vscode.commands.executeCommand('gitPopups.branches'),
    },
    {
      label: 'Push…', mnemonic: '8', icon: 'repo-push', shortcut: sc('⇧⌘K', 'Ctrl+Shift+K'),
      disabled: !state.currentBranch,
      run: () => A.push(ctx, root, state),
    },
    {
      label: 'Update Project…', icon: 'repo-pull', shortcut: sc('⌘T', 'Ctrl+T'),
      run: () => A.updateProject(ctx, root),
    },
    {
      label: 'Fetch', icon: 'repo-fetch',
      run: () => A.fetch(ctx, root),
    },
    {
      label: 'Stash Changes…', mnemonic: '9', icon: 'archive',
      disabled: !state.hasChanges,
      run: () => A.stashChanges(ctx, root),
    },
    {
      label: 'Unstash Changes…', mnemonic: '0', icon: 'unarchive',
      disabled: !state.hasStash,
      childrenTitle: 'Unstash Changes',
      children: () => A.unstashChildren(ctx, root),
    },
    {
      label: 'Worktrees…', icon: 'list-tree',
      separatorBefore: true,
      childrenTitle: 'Worktrees',
      children: () => A.worktreeChildren(ctx, root),
    },
    {
      label: 'Copy Branch Name', icon: 'copy',
      disabled: !state.currentBranch && !state.detachedAt,
      run: () => A.copyBranchName(state),
    },
    {
      label: 'Show Local History…', icon: 'history',
      separatorBefore: true,
      run: () => A.showLocalHistory(),
    },
  );

  // Group header "Git" over the first item, like IntelliJ.
  items[0] = { ...items[0], separatorBefore: 'Git' };
  return items;
}
