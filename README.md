# Git Popups (IntelliJ-style)

Расширение для VS Code, повторяющее два popup-окна IntelliJ IDEA:
**VCS Operations** (быстрое меню Git-операций) и **Branches** (меню веток).

## Возможности

### VCS Operations popup
Контекстное меню наиболее частых Git-операций, как в IntelliJ (`VCS Operations`):

- Commit, Push, Update Project (fetch + pull текущей ветки), Fetch;
- Stash Changes (только отслеживаемые / с неотслеживаемыми файлами) / Unstash Changes (Pop, Apply, Drop);
- операции над активным файлом, если он отслеживается Git: Commit File, Show Diff,
  Show History, Annotate with Git Blame, Rollback, Show Local History;
- Abort / Continue для незавершённых merge, rebase, cherry-pick, revert;
- переход в Branches и Worktrees (New Worktree, Open, Remove).

Набор пунктов зависит от состояния репозитория (есть ли изменения, staged-файлы, stash, идущая операция).

### Branches popup
- Поиск по веткам с фильтрацией по мере ввода;
- группы **Recent** (недавно извлечённые ветки по reflog), **Local**, **Remote**, **Worktrees**;
- вложенные ветки (`feature/x`) группируются по префиксу;
- избранные ветки (звёздочка) — всегда наверху;
- индикаторы ahead/behind (↑/↓) относительно upstream;
- **New Branch…**, **Checkout Tag or Revision…**;
- действия для ветки: Checkout, New Branch from…, Checkout and Rebase onto Current,
  Compare with Current, Show Diff with Working Tree, Rebase Current onto, Merge into Current,
  Update (fast-forward, в том числе для неизвлечённых веток через `git fetch remote src:dst`),
  Push, Rename, Delete (локальные и удалённые ветки);
- элемент строки состояния с текущей веткой — по клику открывает Branches popup.

## Горячие клавиши

| Команда                | macOS   | Windows / Linux  |
|------------------------|---------|------------------|
| VCS Operations popup   | `Ctrl+V` | `` Alt+` ``      |
| Branches popup         | `⇧⌘2`   | ``Ctrl+Shift+` `` |

> **Конфликт на macOS:** `Ctrl+V` в терминале — это вставка / «verbatim insert» в shell.
> Поэтому у привязки задано условие `when: !terminalFocus`: когда фокус в терминале,
> сочетание передаётся терминалу. Переназначить клавиши можно в
> *Preferences → Keyboard Shortcuts* (ищите `Git Popups`).
>
> На Windows/Linux ``Ctrl+Shift+` `` по умолчанию создаёт новый терминал в VS Code —
> привязка расширения его перекрывает; при необходимости переназначьте.

## Команды

- `Git Popups: VCS Operations Popup` (`gitPopups.vcsOperations`)
- `Git Popups: Branches Popup` (`gitPopups.branches`)
- `Git Popups: Toggle Favorite Branch` (`gitPopups.toggleFavoriteBranch`)

## Настройки

| Настройка                          | По умолчанию                    | Описание |
|------------------------------------|---------------------------------|----------|
| `gitPopups.favoriteBranches`       | `["main", "master", "develop"]` | Избранные ветки (со звёздочкой, наверху списка). |
| `gitPopups.recentBranchesLimit`    | `5`                             | Сколько недавних веток показывать в группе Recent. |
| `gitPopups.showStatusBarItem`      | `true`                          | Показывать текущую ветку в строке состояния. |

## Требования

- VS Code 1.85+
- `git` в `PATH` (расширение вызывает Git CLI напрямую)
- встроенное расширение `vscode.git` (включено по умолчанию)

## Сборка и установка

```bash
npm install
npm test                 # компиляция TypeScript + юнит/интеграционные тесты (mocha)
npm run package          # esbuild-бандл + vsce → git-popups-0.1.0.vsix
code --install-extension git-popups-0.1.0.vsix
```

Для отладки откройте папку проекта в VS Code и нажмите **F5**
(конфигурация *Run Extension* запускает Extension Development Host).

## Тесты

- `src/test/parse.test.ts` — юнит-тесты парсеров вывода Git (`for-each-ref`, `status --porcelain=v2`,
  reflog, `worktree list --porcelain`, `stash list`) на реальном выводе git из временного репозитория;
- `src/test/integration.test.ts` — интеграционные тесты `CliGitService` на временном репозитории
  с bare-remote (модуль `vscode` подменяется заглушкой, VS Code для запуска не нужен).

---

## English

**Git Popups** brings IntelliJ IDEA's **VCS Operations** and **Branches** popups to VS Code.

- **VCS Operations** (`Ctrl+V` on macOS, `` Alt+` `` on Windows/Linux): a context-aware quick menu
  with Commit, Push, Update Project, Fetch, Stash/Unstash, active-file actions and Abort/Continue for
  merge/rebase/cherry-pick/revert.
- **Branches** (`⇧⌘2` on macOS, ``Ctrl+Shift+` `` on Windows/Linux): searchable list with Recent,
  Local, Remote and Worktree groups, favorites, nested `feature/x` grouping, ahead/behind indicators
  and per-branch actions (checkout, new branch from, checkout and rebase onto current, compare,
  merge, rebase, update, push, rename, delete). The status bar item opens it too.

Settings: `gitPopups.favoriteBranches`, `gitPopups.recentBranchesLimit`, `gitPopups.showStatusBarItem`.

Note: on macOS `Ctrl+V` is paste in the terminal, so the binding is limited with `when: !terminalFocus`.

Build & install:

```bash
npm install && npm run package
code --install-extension git-popups-0.1.0.vsix
```

Press **F5** in VS Code to launch an Extension Development Host.
