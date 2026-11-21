import * as vscode from 'vscode';
import { CliGitService } from './git/gitService';
import { showVcsOperationsPopup } from './popups/vcsOperationsPopup';
import { showBranchesPopup, registerBranchCommands } from './popups/branchesPopup';

export function activate(context: vscode.ExtensionContext) {
  const git = new CliGitService();
  const ctx = { git, extension: context };
  registerBranchCommands(ctx);

  context.subscriptions.push(
    vscode.commands.registerCommand('gitPopups.vcsOperations', () => showVcsOperationsPopup(ctx)),
    vscode.commands.registerCommand('gitPopups.branches', () => showBranchesPopup(ctx)),
  );

  // Status bar: current branch, click -> Branches popup (like IntelliJ's branch widget)
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  item.command = 'gitPopups.branches';
  context.subscriptions.push(item);
  const refresh = async () => {
    if (!vscode.workspace.getConfiguration('gitPopups').get('showStatusBarItem')) { item.hide(); return; }
    const root = await git.getRepoRoot();
    if (!root) { item.hide(); return; }
    const st = await git.getState(root).catch(() => undefined);
    item.text = `$(git-branch) ${st?.currentBranch ?? st?.detachedAt ?? '?'}`;
    item.tooltip = 'Git Branches';
    item.show();
  };
  void refresh();
  const timer = setInterval(refresh, 5000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) },
    vscode.window.onDidChangeActiveTextEditor(() => void refresh()));
}

export function deactivate() {}
