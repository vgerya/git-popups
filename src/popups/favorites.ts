import * as vscode from 'vscode';

/**
 * Favorite branches, persisted per repository in workspaceState.
 * On first use for a repo the list is seeded from the `gitPopups.favoriteBranches` setting.
 */
export class Favorites {
  constructor(private readonly state: vscode.Memento) {}

  private key(root: string): string { return `gitPopups.favorites:${root}`; }

  get(root: string): Set<string> {
    const stored = this.state.get<string[]>(this.key(root));
    if (stored) return new Set(stored);
    const seed = vscode.workspace.getConfiguration('gitPopups').get<string[]>('favoriteBranches') ?? [];
    return new Set(seed);
  }

  isFavorite(root: string, name: string): boolean {
    return this.get(root).has(name);
  }

  /** Toggles and returns the new favorite state. */
  async toggle(root: string, name: string): Promise<boolean> {
    const set = this.get(root);
    const now = !set.has(name);
    if (now) set.add(name); else set.delete(name);
    await this.state.update(this.key(root), [...set]);
    return now;
  }
}

export function getFavorites(ext: vscode.ExtensionContext): Favorites {
  return new Favorites(ext.workspaceState);
}
