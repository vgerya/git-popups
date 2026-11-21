import * as vscode from 'vscode';

/**
 * IntelliJ-like popup built on QuickPick.
 * - Items can have a numeric/letter mnemonic: typing that single char triggers the item immediately.
 * - Disabled items are shown dimmed (description "unavailable") and cannot be accepted.
 * - Items with `children` open a nested popup (with a Back button) — emulates IntelliJ submenus.
 */
export interface PopupItem {
  label: string;
  /** codicon id without $( ) e.g. "git-commit" */
  icon?: string;
  /** single char shown as "1 " prefix and used as instant hotkey */
  mnemonic?: string;
  /** shortcut hint shown on the right, e.g. "⌘K" */
  shortcut?: string;
  detail?: string;
  description?: string;
  disabled?: boolean;
  separatorBefore?: string | true;
  /** action to run; may be async */
  run?: () => unknown | Promise<unknown>;
  /** nested popup items (lazy) */
  children?: () => PopupItem[] | Promise<PopupItem[]>;
  childrenTitle?: string;
  /** extra buttons shown on hover (e.g. star) */
  buttons?: { icon: string; tooltip: string; run: () => unknown }[];
  alwaysShow?: boolean;
}

interface QPItem extends vscode.QuickPickItem { src?: PopupItem; }

export interface PopupOptions {
  title: string;
  placeholder?: string;
  /** when false, digits typed go to the filter instead of triggering mnemonics (e.g. branch search) */
  mnemonics?: boolean;
  /** called when user clicks the title-bar back button */
  onBack?: () => void;
  /** title bar buttons */
  titleButtons?: { icon: string; tooltip: string; run: () => unknown }[];
  matchOnDescription?: boolean;
  matchOnDetail?: boolean;
}

function toQP(items: PopupItem[]): QPItem[] {
  const out: QPItem[] = [];
  for (const it of items) {
    if (it.separatorBefore) {
      out.push({ label: typeof it.separatorBefore === 'string' ? it.separatorBefore : '', kind: vscode.QuickPickItemKind.Separator });
    }
    const prefix = it.mnemonic ? `${it.mnemonic}  ` : '';
    const icon = it.icon ? `$(${it.icon}) ` : '';
    const descParts: string[] = [];
    if (it.description) descParts.push(it.description);
    if (it.shortcut) descParts.push(it.shortcut);
    if (it.disabled) descParts.push('(unavailable)');
    out.push({
      label: `${icon}${prefix}${it.label}${it.children ? '  ›' : ''}`,
      description: descParts.join('   '),
      detail: it.detail,
      alwaysShow: it.alwaysShow,
      buttons: it.buttons?.map(b => ({ iconPath: new vscode.ThemeIcon(b.icon), tooltip: b.tooltip })),
      src: it,
    });
  }
  return out;
}

export async function showPopup(items: PopupItem[] | (() => Promise<PopupItem[]>), opts: PopupOptions): Promise<void> {
  const qp = vscode.window.createQuickPick<QPItem>();
  qp.title = opts.title;
  qp.placeholder = opts.placeholder;
  qp.matchOnDescription = opts.matchOnDescription ?? false;
  qp.matchOnDetail = opts.matchOnDetail ?? false;
  const titleButtons: vscode.QuickInputButton[] = [];
  if (opts.onBack) titleButtons.push(vscode.QuickInputButtons.Back);
  const extraTitle = (opts.titleButtons ?? []).map(b => ({ iconPath: new vscode.ThemeIcon(b.icon), tooltip: b.tooltip, _run: b.run }));
  qp.buttons = [...titleButtons, ...extraTitle];

  let current: PopupItem[] = [];
  const load = async () => {
    qp.busy = true;
    try {
      current = typeof items === 'function' ? await items() : items;
      qp.items = toQP(current);
      const firstEnabled = qp.items.find(i => i.src && !i.src.disabled);
      if (firstEnabled) qp.activeItems = [firstEnabled];
    } finally { qp.busy = false; }
  };

  const accept = async (it: PopupItem | undefined) => {
    if (!it || it.disabled) return;
    if (it.children) {
      qp.hide();
      const kids = it.children;
      await showPopup(async () => kids(), {
        title: `${opts.title} › ${it.childrenTitle ?? it.label}`,
        mnemonics: opts.mnemonics,
        onBack: () => void showPopup(items, opts),
      });
      return;
    }
    qp.hide();
    try { await it.run?.(); }
    catch (e: any) { void vscode.window.showErrorMessage(`Git: ${e?.message ?? e}`); }
  };

  const disposables: vscode.Disposable[] = [];
  disposables.push(
    qp.onDidChangeValue(v => {
      if (opts.mnemonics === false || v.length !== 1) return;
      const hit = current.find(i => i.mnemonic && i.mnemonic.toLowerCase() === v.toLowerCase());
      if (hit && !hit.disabled) void accept(hit);
    }),
    qp.onDidAccept(() => void accept(qp.activeItems[0]?.src)),
    qp.onDidTriggerItemButton(e => {
      const idx = qp.items.indexOf(e.item);
      const btnIdx = e.item.buttons?.indexOf(e.button) ?? -1;
      const b = e.item.src?.buttons?.[btnIdx];
      if (b) Promise.resolve(b.run()).then(load);
      void idx;
    }),
    qp.onDidTriggerButton(b => {
      if (b === vscode.QuickInputButtons.Back) { qp.hide(); opts.onBack?.(); return; }
      const extra = extraTitle.find(x => x === (b as any));
      if (extra) { qp.hide(); void extra._run(); }
    }),
    qp.onDidHide(() => { disposables.forEach(d => d.dispose()); qp.dispose(); }),
  );
  qp.show();
  await load();
}
