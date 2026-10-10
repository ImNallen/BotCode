// Bindings and action labels ported from pingdotgg/t3code v0.0.45 CommandPalette.tsx and shared/src/keybindings.ts (MIT).
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CircleCheckIcon,
  ClockIcon,
  CopyIcon,
  FolderIcon,
  FolderPlusIcon,
  FolderTreeIcon,
  FileSearchIcon,
  TextSearchIcon,
  GitBranchIcon,
  HashIcon,
  MessageSquareDashedIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PinIcon,
  SettingsIcon,
  SquareArrowOutUpRightIcon,
  SquarePenIcon,
  TerminalIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react";
import type { Arrange, OpenTarget, ThreadSummary, Workspace } from "../ipc";
import { workingSessions } from "./sessions";
import { resolveSnoozePresets, type SnoozePreset } from "./snooze";
import { keybindings } from "../keybindings/store";
import {
  DEFAULT_KEYBINDINGS,
  THREAD_JUMP_KEYBINDING_COMMANDS,
  type KeybindingRule,
} from "../keybindings/rules";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../keybindings/keyboard";
import { currentShortcutContext } from "./shortcutContext";
import { revealLabel } from "./editors";

export type SidebarOperation =
  | {
      kind:
        | "rename"
        | "archive"
        | "delete"
        | "wake"
        | "copyPath"
        | "copyBranch"
        | "copyId";
    }
  | { kind: "snooze"; preset: SnoozePreset["id"] };
export type SidebarRequest = {
  sequence: number;
  threadId: string;
  operation: SidebarOperation;
};
export type ChatRequest = {
  sequence: number;
  workspaceId: string;
  threadId: string | undefined;
  kind:
    | "terminal.toggle"
    | "rightPanel.toggle"
    | "filePicker.toggle"
    | "projectSearch.toggle";
};
export type PalettePage =
  | "root"
  | "snooze"
  | "copy"
  | "archived"
  | "new-thread-in"
  | "project-sources"
  | "project-local"
  | "project-new"
  | "project-clone"
  | "archive-actions";
export type ActionContext = {
  pageOpen: boolean;
  thread: ThreadSummary | undefined;
  workspace: Workspace | undefined;
  branch: string;
  scratchAvailable: boolean;
  terminalAvailable: boolean;
  projectSearchAvailable: boolean;
  renamePending: boolean;
  queued: boolean;
  archiveTarget: ThreadSummary | undefined;
  // The open conversation's checkout root, absent for a no-project draft or a removed worktree.
  checkoutTarget: OpenTarget | null;
  editorLabel: string | null;
  newThread: () => void;
  newThreadDirect: () => void;
  startScratch: () => void;
  openSettings: () => void;
  closePage: () => void;
  toggleSidebar: () => void;
  openPalette: () => void;
  openSubmenu: (page: PalettePage) => void;
  arrange: (threadId: string, action: Arrange) => void;
  requestSidebar: (threadId: string, operation: SidebarOperation) => void;
  requestChat: (kind: ChatRequest["kind"]) => void;
  restoreArchived: (thread: ThreadSummary) => void;
  deleteArchived: (thread: ThreadSummary) => void;
  openInEditor: (target: OpenTarget) => void;
  revealInFinder: (target: OpenTarget) => void;
};
export type KeyEventLike = Pick<
  KeyboardEvent,
  "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
> & {
  type?: string;
  isComposing?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
};
type ActionDefinition = {
  title: string;
  icon?: LucideIcon;
  label?: (context: ActionContext) => string;
  keywords?: string;
  shortcutDescription?: string;
  group: "Navigation" | "Threads" | "Terminal" | "Composer";
  submenu?: boolean;
  defaultBindings?: readonly Omit<KeybindingRule, "command">[];
  shortcutOwner?: "terminal" | "page" | "composer" | "palette";
  allowTerminal?: boolean;
  available: (context: ActionContext) => boolean;
} & (
  | { palette: PalettePage | false; run: (context: ActionContext) => void }
  | { palette: false; shortcutOwner: "terminal" | "composer"; run?: never }
);
const liveThread = (context: ActionContext) =>
  !context.pageOpen &&
  context.thread !== undefined &&
  context.thread.archivedAtMs === null;
const canArrange = (context: ActionContext) =>
  liveThread(context) && !context.thread?.awaitingApproval;
export function canParkThread(thread: ThreadSummary, queued: boolean) {
  return (
    thread.archivedAtMs === null &&
    !thread.awaitingApproval &&
    !workingSessions.has(thread.session.kind) &&
    !queued
  );
}
const sidebar = (operation: SidebarOperation) => (context: ActionContext) => {
  if (context.thread) context.requestSidebar(context.thread.id, operation);
};
const snooze = (
  preset: SnoozePreset["id"],
  title: string,
): ActionDefinition => ({
  title,
  icon: ClockIcon,
  group: "Threads",
  palette: "snooze",
  available: (context) =>
    canArrange(context) &&
    resolveSnoozePresets(new Date()).some((item) => item.id === preset),
  run: sidebar({ kind: "snooze", preset }),
});
const terminal = (
  title: string,
  shortcutDescription = "Clear the focused terminal without stopping its process.",
): ActionDefinition => ({
  title,
  shortcutDescription,
  group: "Terminal",
  palette: false,
  shortcutOwner: "terminal",
  available: () => false,
});
const local = (title: string): ActionDefinition => ({
  title,
  group: "Composer",
  palette: false,
  shortcutOwner: "composer",
  available: () => false,
});
const definitions = {
  "composer.stash": local("Stash prompt"),
  "modelPicker.toggle": local("Toggle model picker"),
  "composer.effort": local("Choose reasoning effort"),
  "composer.mode": local("Choose permissions"),
  "composer.workspace": local("Choose workspace"),
  "composer.branch": local("Choose branch"),
  "thread.stop": local("Stop thread"),
  "commandPalette.toggle": {
    shortcutDescription:
      "Search all thread titles, loaded messages, and commands. Command+K clears a focused terminal.",
    title: "Open command palette",
    keywords: "search commands threads",
    group: "Navigation",
    palette: false,
    available: () => true,
    run: (c) => c.openPalette(),
  },
  "chat.new": {
    icon: SquarePenIcon,
    title: "New thread",
    group: "Navigation",
    palette: "root",
    available: (c) => !!c.workspace || c.scratchAvailable,
    run: (c) => c.newThread(),
  },
  "chat.newLocal": {
    icon: SquarePenIcon,
    title: "New thread in current project",
    group: "Navigation",
    palette: false,
    available: (c) => !!c.workspace || c.scratchAvailable,
    run: (c) => c.newThreadDirect(),
  },
  "project.add": {
    icon: FolderPlusIcon,
    title: "Add project",
    keywords: "local folder repository",
    group: "Navigation",
    palette: "root",
    submenu: true,
    available: () => true,
    run: (c) => c.openSubmenu("project-sources"),
  },
  "project.new": {
    icon: FolderPlusIcon,
    title: "New project",
    keywords: "create empty repository git init",
    group: "Navigation",
    palette: "root",
    submenu: true,
    available: () => true,
    run: (c) => c.openSubmenu("project-new"),
  },
  "project.clone": {
    icon: GitBranchIcon,
    title: "Clone repository",
    keywords: "git URL local project",
    group: "Navigation",
    palette: "root",
    submenu: true,
    available: () => true,
    run: (c) => c.openSubmenu("project-clone"),
  },
  "chat.newWithoutProject": {
    icon: MessageSquareDashedIcon,
    shortcutDescription:
      "Start a thread in its own folder instead of a project.",
    title: "New thread without a project",
    keywords: "scratch no project",
    group: "Navigation",
    palette: "root",
    available: (c) => c.scratchAvailable,
    run: (c) => c.startScratch(),
  },
  "settings.open": {
    defaultBindings: [{ key: "mod+," }],
    icon: SettingsIcon,
    shortcutDescription:
      "Open General settings from anywhere in the workbench.",
    title: "Open settings",
    group: "Navigation",
    palette: "root",
    allowTerminal: true,
    available: () => true,
    run: (c) => c.openSettings(),
  },
  "page.close": {
    defaultBindings: [{ key: "esc" }],
    shortcutDescription:
      "Leave settings. Search and open menus handle Escape first.",
    title: "Back to conversation",
    group: "Navigation",
    palette: false,
    shortcutOwner: "page",
    available: (c) => c.pageOpen,
    run: (c) => c.closePage(),
  },
  "sidebar.toggle": {
    icon: PanelLeftIcon,
    shortcutDescription: "Show or hide the main sidebar.",
    title: "Toggle sidebar",
    group: "Navigation",
    palette: "root",
    allowTerminal: true,
    available: () => true,
    run: (c) => c.toggleSidebar(),
  },
  "filePicker.toggle": {
    icon: FileSearchIcon,
    title: "Go to file",
    keywords: "open file file picker find file quick open",
    shortcutDescription: "Find and open a file in the current checkout.",
    group: "Navigation",
    palette: "root",
    available: (c) => !c.pageOpen && c.projectSearchAvailable,
    run: (c) => c.requestChat("filePicker.toggle"),
  },
  "projectSearch.toggle": {
    icon: TextSearchIcon,
    title: "Search project contents",
    keywords: "search project find in files grep content search text search",
    shortcutDescription: "Search file contents in the current checkout.",
    group: "Navigation",
    palette: "root",
    available: (c) => !c.pageOpen && c.projectSearchAvailable,
    run: (c) => c.requestChat("projectSearch.toggle"),
  },
  "rightPanel.toggle": {
    icon: PanelRightIcon,
    title: "Toggle right panel",
    keywords: "tools files diff",
    group: "Navigation",
    palette: "root",
    available: (c) => !c.pageOpen && !!c.workspace,
    run: (c) => c.requestChat("rightPanel.toggle"),
  },
  "editor.openFavorite": {
    icon: SquareArrowOutUpRightIcon,
    shortcutDescription:
      "Open the conversation's checkout in the preferred editor.",
    title: "Open in preferred editor",
    label: (c) => `Open in ${c.editorLabel ?? "editor"}`,
    keywords: "editor ide cursor vscode zed",
    group: "Navigation",
    palette: "root",
    allowTerminal: true,
    available: (c) =>
      !c.pageOpen && c.checkoutTarget !== null && c.editorLabel !== null,
    run: (c) => {
      if (c.checkoutTarget) c.openInEditor(c.checkoutTarget);
    },
  },
  "editor.reveal": {
    icon: FolderTreeIcon,
    title: revealLabel,
    keywords: "folder file manager",
    group: "Navigation",
    palette: "root",
    available: (c) => !c.pageOpen && c.checkoutTarget !== null,
    run: (c) => {
      if (c.checkoutTarget) c.revealInFinder(c.checkoutTarget);
    },
  },
  "terminal.toggle": {
    icon: TerminalIcon,
    shortcutDescription:
      "Show or hide the terminal under the conversation, including from inside the terminal.",
    title: "Toggle terminal drawer",
    keywords: "shell console",
    group: "Terminal",
    palette: "root",
    shortcutOwner: "terminal",
    available: (c) => !c.pageOpen && c.terminalAvailable,
    run: (c) => c.requestChat("terminal.toggle"),
  },
  "thread.pin": {
    icon: PinIcon,
    shortcutDescription:
      "Keep the open thread at the top of the sidebar, or unpin it.",
    title: "Pin thread",
    label: (c) =>
      c.thread?.pinnedAtMs != null ? "Unpin thread" : "Pin thread",
    keywords: "unpin pinned",
    group: "Threads",
    palette: "root",
    available: liveThread,
    run: (c) => {
      if (c.thread)
        c.arrange(c.thread.id, {
          kind: c.thread.pinnedAtMs === null ? "pin" : "unpin",
        });
    },
  },
  "thread.settle": {
    icon: CircleCheckIcon,
    shortcutDescription:
      "Move the open thread to the Settled shelf, or back to the active list.",
    title: "Settle thread",
    label: (c) =>
      c.thread?.settledAtMs != null ? "Un-settle thread" : "Settle thread",
    keywords: "unsettle settled",
    group: "Threads",
    palette: "root",
    available: canArrange,
    run: (c) => {
      if (c.thread)
        c.arrange(c.thread.id, {
          kind: c.thread.settledAtMs === null ? "settle" : "unsettle",
        });
    },
  },
  "thread.snooze": {
    icon: ClockIcon,
    title: "Snooze thread",
    group: "Threads",
    palette: "root",
    submenu: true,
    available: (c) =>
      canArrange(c) &&
      !(c.thread?.snoozedUntilMs && c.thread.snoozedUntilMs > Date.now()),
    run: (c) => c.openSubmenu("snooze"),
  },
  "thread.wake": {
    icon: ClockIcon,
    title: "Wake thread",
    group: "Threads",
    palette: "root",
    available: (c) =>
      liveThread(c) && (c.thread?.snoozedUntilMs ?? 0) > Date.now(),
    run: sidebar({ kind: "wake" }),
  },
  "thread.rename": {
    icon: SquarePenIcon,
    title: "Rename thread",
    group: "Threads",
    palette: "root",
    available: (c) => liveThread(c) && !c.renamePending,
    run: sidebar({ kind: "rename" }),
  },
  "thread.copy": {
    icon: CopyIcon,
    title: "Copy",
    keywords: "path branch thread id",
    group: "Threads",
    palette: "root",
    submenu: true,
    available: liveThread,
    run: (c) => c.openSubmenu("copy"),
  },
  "thread.copyPath": {
    icon: FolderIcon,
    title: "Copy path",
    group: "Threads",
    palette: "copy",
    available: liveThread,
    run: sidebar({ kind: "copyPath" }),
  },
  "thread.copyBranch": {
    icon: GitBranchIcon,
    title: "Copy branch",
    group: "Threads",
    palette: "copy",
    available: (c) =>
      liveThread(c) && c.workspace?.kind === "repository" && !!c.branch,
    run: sidebar({ kind: "copyBranch" }),
  },
  "thread.copyId": {
    icon: HashIcon,
    title: "Copy thread ID",
    group: "Threads",
    palette: "copy",
    available: liveThread,
    run: sidebar({ kind: "copyId" }),
  },
  "thread.archive": {
    icon: ArchiveIcon,
    title: "Archive thread",
    group: "Threads",
    palette: "root",
    available: (c) =>
      liveThread(c) && !!c.thread && canParkThread(c.thread, c.queued),
    run: sidebar({ kind: "archive" }),
  },
  "thread.delete": {
    icon: Trash2Icon,
    title: "Delete thread",
    group: "Threads",
    palette: "root",
    available: (c) =>
      liveThread(c) && !!c.thread && canParkThread(c.thread, c.queued),
    run: sidebar({ kind: "delete" }),
  },
  "archive.open": {
    icon: ArchiveRestoreIcon,
    title: "Restore archived thread…",
    keywords: "unarchive history",
    group: "Threads",
    palette: "root",
    submenu: true,
    available: () => true,
    run: (c) => c.openSubmenu("archived"),
  },
  "archive.restore": {
    shortcutOwner: "palette",
    icon: ArchiveRestoreIcon,
    title: "Unarchive thread",
    group: "Threads",
    palette: "archive-actions",
    available: (c) => c.archiveTarget?.archivedAtMs != null,
    run: (c) => {
      if (c.archiveTarget) c.restoreArchived(c.archiveTarget);
    },
  },
  "archive.delete": {
    shortcutOwner: "palette",
    icon: Trash2Icon,
    title: "Delete thread",
    group: "Threads",
    palette: "archive-actions",
    available: (c) => c.archiveTarget?.archivedAtMs != null,
    run: (c) => {
      if (c.archiveTarget) c.deleteArchived(c.archiveTarget);
    },
  },
  "snooze.hour": snooze("hour", "In 1 hour"),
  "snooze.three-hours": snooze("three-hours", "In 3 hours"),
  "snooze.evening": snooze("evening", "This evening"),
  "snooze.tomorrow": snooze("tomorrow", "Tomorrow at 9 AM"),
  "snooze.next-week": snooze("next-week", "Next week on Monday at 9 AM"),
  "terminal.split": terminal(
    "Split terminal horizontally",
    "Add a terminal beside the focused one, up to four side by side.",
  ),
  "terminal.splitVertical": terminal(
    "Split terminal vertically",
    "Add a terminal below the focused one, up to four stacked.",
  ),
  "terminal.new": terminal(
    "New terminal",
    "Open another terminal in its own tab.",
  ),
  "terminal.close": terminal(
    "Close terminal",
    "Close the focused terminal after confirmation and stop its process.",
  ),
  "terminal.clear": {
    ...terminal("Clear terminal"),
    defaultBindings: [{ key: "meta+k", when: "terminalFocus && isMac" }],
  },
  "terminal.clearControl": {
    ...terminal("Clear terminal"),
    defaultBindings: [{ key: "ctrl+l", when: "terminalFocus" }],
  },
} satisfies Record<string, ActionDefinition>;
export type ActionId = keyof typeof definitions;
export const actions: Record<ActionId, ActionDefinition> = definitions;
export const actionIds = Object.keys(definitions).filter(
  (id): id is ActionId => id in definitions,
);
export function actionLabel(id: ActionId, context: ActionContext) {
  return actions[id].label?.(context) ?? actions[id].title;
}
export function runAction(id: ActionId, context: ActionContext) {
  const action = actions[id];
  if (!action.available(context) || !action.run) return false;
  action.run(context);
  return true;
}
export function matchesAction(
  event: KeyEventLike,
  id: ActionId,
  platform = navigator.platform,
  context = currentShortcutContext(platform),
) {
  return resolveCommand(event, platform, context) === id;
}
export function resolveCommand(
  event: KeyEventLike,
  platform = navigator.platform,
  context = currentShortcutContext(platform),
) {
  if (event.isComposing || (event.type && event.type !== "keydown"))
    return null;
  return resolveShortcutCommand(event, runnableBindings(), {
    platform,
    context,
  });
}
export const registerScriptCommands = keybindings.registerScriptCommands;
function runnableBindings() {
  const snapshot = keybindings.getSnapshot();
  return snapshot.bindings.filter(
    (binding) =>
      (isActionId(binding.command) &&
        actions[binding.command].shortcutOwner !== "palette") ||
      snapshot.scriptCommands.has(binding.command),
  );
}
export function paletteBindings() {
  const snapshot = keybindings.getSnapshot();
  return snapshot.bindings.filter(
    (binding) =>
      isActionId(binding.command) ||
      THREAD_JUMP_KEYBINDING_COMMANDS.includes(binding.command) ||
      snapshot.scriptCommands.has(binding.command),
  );
}
export function commandShortcutLabel(
  command: string,
  platform = navigator.platform,
  context = currentShortcutContext(platform),
) {
  return (
    shortcutLabelForCommand(runnableBindings(), command, {
      platform,
      context,
    }) ?? undefined
  );
}
export function matchAction(
  event: KeyEventLike,
  context: ActionContext,
  terminalFocused: boolean,
  platform = navigator.platform,
) {
  if (event.defaultPrevented || event.isComposing || event.repeat)
    return undefined;
  const command = resolveCommand(event, platform, {
    ...currentShortcutContext(platform),
    terminalFocus: terminalFocused,
  });
  if (!isActionId(command)) return undefined;
  const action = actions[command];
  return !action.shortcutOwner &&
    (!terminalFocused || action.allowTerminal) &&
    action.available(context)
    ? command
    : undefined;
}
export function isActionId(id: string | null | undefined): id is ActionId {
  return typeof id === "string" && Object.hasOwn(actions, id);
}
export function shortcutLabel(id: ActionId, platform = navigator.platform) {
  return commandShortcutLabel(id, platform, {
    ...currentShortcutContext(platform),
    terminalFocus: actions[id].shortcutOwner === "terminal",
  });
}

export const defaultKeybindings: readonly KeybindingRule[] = [
  ...DEFAULT_KEYBINDINGS.filter(
    (rule) =>
      isActionId(rule.command) ||
      THREAD_JUMP_KEYBINDING_COMMANDS.includes(rule.command),
  ),
  ...actionIds.flatMap((command) =>
    (actions[command].defaultBindings ?? []).map((binding) => ({
      ...binding,
      command,
    })),
  ),
];
keybindings.configure(
  defaultKeybindings,
  new Set([...actionIds, ...THREAD_JUMP_KEYBINDING_COMMANDS]),
);
