import * as vscode from 'vscode';
import type { GitService } from '../git/types';

export interface PopupContext {
  git: GitService;
  extension: vscode.ExtensionContext;
}
