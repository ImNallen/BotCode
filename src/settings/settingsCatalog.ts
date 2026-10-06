// Section order and labels follow pingdotgg/t3code v0.0.45 settings/settingsSearch.ts (MIT).
import {
  ArchiveIcon,
  HardDriveIcon,
  KeyboardIcon,
  PaletteIcon,
  PanelsTopLeftIcon,
  Settings2Icon,
} from "lucide-react";
import { z } from "zod";
import type { ProjectSetting } from "./preferences";
import type { SettingsScope } from "./settingsScope";

export const settingsSection = z.enum([
  "projects",
  "general",
  "appearance",
  "keybindings",
  "storage",
  "archived",
]);
export type SettingsSection = z.infer<typeof settingsSection>;

export type SettingsRowInfo = {
  id: string;
  title: string;
  description: string;
  keywords?: string;
  // Rows for a project-scoped setting read and write the picked project's override.
  setting?: ProjectSetting;
};
type SettingsGroupInfo = {
  id: string;
  title: string;
  hideTitle?: boolean;
  // Groups that depend on the picked project. "available" keeps the group
  // and empties it when the project is gone.
  when?: "all-projects" | "available" | "repository";
  rows: SettingsRowInfo[];
};
type SettingsCategory = {
  title: string;
  icon: typeof Settings2Icon;
  scoped: boolean;
  groups: SettingsGroupInfo[];
};

export const projectSettingRows = {
  newThreadCheckout: {
    title: "Workspace",
    all: "Where new threads start. Projects can override it.",
    project: "Where new threads in this project start.",
    resetLabel: "default workspace",
    keywords: "default mode draft current local checkout new worktree",
  },
  newWorktreesStartFromOrigin: {
    title: "Start from origin",
    all: "Creates the worktree from the latest matching branch on origin instead of your local branch.",
    project:
      "Creates this project's worktrees from the latest matching branch on origin instead of your local branch.",
    resetLabel: "new worktrees start from origin",
    keywords: "new worktrees latest matching remote branch local",
  },
  autoSettleOnMerge: {
    title: "Auto-settle merged pull requests",
    all: "Settle eligible threads after their linked pull requests merge. Projects can override it.",
    project: "Settle eligible threads after their linked pull requests merge.",
    resetLabel: "auto-settle on merge",
    keywords: "pull request PR merge merged automatic settlement",
  },
  sidebarAutoSettleAfterDays: {
    title: "Auto-settle inactive threads",
    all: "Sidebar threads with no activity for this long settle automatically. Projects can override it.",
    project:
      "Sidebar threads with no activity for this long settle automatically.",
    resetLabel: "auto-settle",
    keywords:
      "sidebar inactivity days no activity automatically days of inactivity before auto-settle thread timeout activity",
  },
} satisfies Record<
  ProjectSetting,
  {
    title: string;
    all: string;
    project: string;
    resetLabel: string;
    keywords: string;
  }
>;

export const autoSettleDaysRow = {
  id: "auto-settle-days",
  title: "Days of inactivity before auto-settle",
  description: "Any new activity un-settles a thread automatically.",
};
const worktreeCleanupKeywords =
  "worktree cleanup disk storage delete threads old inactive unchanged worktrees retention days off";

export const projectRows = {
  name: {
    id: "project-name",
    title: "Name",
    description: "The name for this project in the sidebar and thread lists.",
    keywords: "rename",
  },
  workspace: {
    id: "project-workspace",
    title: projectSettingRows.newThreadCheckout.title,
    description: projectSettingRows.newThreadCheckout.project,
    keywords: projectSettingRows.newThreadCheckout.keywords,
  },
  remove: {
    id: "project-remove",
    title: "Remove project",
    description:
      "Deletes the project entry and its threads. Files on disk are not touched.",
    keywords: "delete",
  },
} satisfies Record<string, SettingsRowInfo>;

export const categories: Record<SettingsSection, SettingsCategory> = {
  projects: {
    title: "Project",
    icon: PanelsTopLeftIcon,
    scoped: true,
    groups: [
      {
        id: "project-overview",
        title: "Project",
        hideTitle: true,
        when: "repository",
        rows: [projectRows.name],
      },
      {
        id: "project-new-threads",
        title: "New threads",
        rows: [projectRows.workspace],
      },
      { id: "project-danger", title: "Danger", rows: [projectRows.remove] },
    ],
  },
  general: {
    title: "General",
    icon: Settings2Icon,
    scoped: true,
    groups: [
      {
        id: "application",
        title: "Application",
        rows: [
          {
            id: "provider",
            title: "Provider",
            description: "Bot Code runs your conversations with Codex.",
          },
          {
            id: "approval",
            title: "Approval mode",
            description:
              "Choose Supervised, Auto-accept edits, Auto, or Full access in each conversation composer.",
          },
          {
            id: "context-window-indicator",
            title: "Context window indicator",
            description:
              "Shows context window usage as a circular indicator in the composer.",
          },
        ],
      },
      {
        id: "new-threads",
        title: "New threads",
        when: "available",
        rows: [
          {
            id: "workspace",
            title: projectSettingRows.newThreadCheckout.title,
            description: projectSettingRows.newThreadCheckout.all,
            keywords: projectSettingRows.newThreadCheckout.keywords,
            setting: "newThreadCheckout",
          },
          {
            id: "start-from-origin",
            title: projectSettingRows.newWorktreesStartFromOrigin.title,
            description: projectSettingRows.newWorktreesStartFromOrigin.all,
            keywords: projectSettingRows.newWorktreesStartFromOrigin.keywords,
            setting: "newWorktreesStartFromOrigin",
          },
        ],
      },
      {
        id: "organization",
        title: "Organization",
        when: "available",
        rows: [
          {
            id: "auto-settle-on-merge",
            title: projectSettingRows.autoSettleOnMerge.title,
            description: projectSettingRows.autoSettleOnMerge.all,
            keywords: projectSettingRows.autoSettleOnMerge.keywords,
            setting: "autoSettleOnMerge",
          },
          {
            id: "auto-settle",
            title: projectSettingRows.sidebarAutoSettleAfterDays.title,
            description: projectSettingRows.sidebarAutoSettleAfterDays.all,
            keywords: projectSettingRows.sidebarAutoSettleAfterDays.keywords,
            setting: "sidebarAutoSettleAfterDays",
          },
        ],
      },
      {
        id: "preferences",
        title: "Device preferences",
        when: "all-projects",
        rows: [
          {
            id: "restore",
            title: "Restore defaults",
            description:
              "Reset appearance, font sizes, the context window indicator, storage cleanup, new thread defaults and auto-settle, including project overrides, on this device.",
          },
        ],
      },
    ],
  },
  appearance: {
    title: "Appearance",
    icon: PaletteIcon,
    scoped: false,
    groups: [
      {
        id: "colors",
        title: "Colors",
        rows: [
          {
            id: "theme",
            title: "Appearance",
            description:
              "Use a light or dark interface, or follow your system.",
          },
        ],
      },
      {
        id: "typography",
        title: "Typography",
        rows: [
          {
            id: "prompt-font",
            title: "Prompt font size",
            description: "Set the font size of the message composer.",
          },
          {
            id: "code-font",
            title: "Code font size",
            description:
              "Set the font size of code blocks, tool output, file previews, diffs and the terminal.",
          },
        ],
      },
    ],
  },
  keybindings: {
    title: "Keyboard shortcuts",
    icon: KeyboardIcon,
    scoped: false,
    groups: [
      {
        id: "navigation",
        title: "Navigation",
        rows: [
          {
            id: "toggle-sidebar",
            title: "Toggle sidebar",
            description: "Show or hide the main sidebar.",
          },
          {
            id: "new-without-project",
            title: "New thread without a project",
            description:
              "Start a thread in its own folder instead of a project.",
            keywords: "scratch no project",
          },
          {
            id: "open-settings",
            title: "Open settings",
            description:
              "Open General settings from anywhere in the workbench.",
          },
          {
            id: "close-settings",
            title: "Back to conversation",
            description:
              "Leave settings. Search and open menus handle Escape first.",
          },
        ],
      },
      {
        id: "threads",
        title: "Threads",
        rows: [
          {
            id: "settle-thread",
            title: "Settle thread",
            description:
              "Move the open thread to the Settled shelf, or back to the active list.",
            keywords: "settled un-settle archive",
          },
          {
            id: "pin-thread",
            title: "Pin thread",
            description:
              "Keep the open thread at the top of the sidebar, or unpin it.",
            keywords: "pinned unpin",
          },
        ],
      },
      {
        id: "terminal",
        title: "Terminal",
        rows: [
          {
            id: "toggle-terminal",
            title: "Toggle terminal drawer",
            description:
              "Show or hide the terminal under the conversation, including from inside the terminal.",
            keywords: "shell console",
          },
          {
            id: "split-terminal",
            title: "Split terminal horizontally",
            description:
              "Add a terminal beside the focused one, up to four side by side.",
            keywords: "shell console",
          },
          {
            id: "split-terminal-vertical",
            title: "Split terminal vertically",
            description:
              "Add a terminal below the focused one, up to four stacked.",
            keywords: "shell console stacked",
          },
          {
            id: "new-terminal",
            title: "New terminal",
            description: "Open another terminal in its own tab.",
            keywords: "shell console tab",
          },
          {
            id: "close-terminal",
            title: "Close terminal",
            description:
              "Close the focused terminal after confirmation and stop its process.",
            keywords: "shell console kill",
          },
        ],
      },
    ],
  },
  archived: {
    title: "Archived",
    icon: ArchiveIcon,
    scoped: true,
    groups: [
      {
        id: "archived",
        title: "Archived threads",
        rows: [
          {
            id: "archive",
            title: "Archived threads",
            description: "View and restore archived threads.",
            keywords: "unarchive restore delete history",
          },
        ],
      },
    ],
  },
  storage: {
    title: "Storage",
    icon: HardDriveIcon,
    scoped: false,
    groups: [
      {
        id: "storage-worktrees",
        title: "Worktrees",
        rows: [
          {
            id: "worktree-on-delete",
            title: "Delete worktrees with deleted threads",
            description:
              "Remove unused worktrees when active or archived threads are deleted. Worktrees with local changes are kept.",
            keywords: worktreeCleanupKeywords,
          },
          {
            id: "worktree-after-days",
            title: "Delete inactive worktrees",
            description:
              "Remove worktrees after their threads have been inactive for this many days. Branches and thread history are kept.",
            keywords: worktreeCleanupKeywords,
          },
          {
            id: "worktree-unchanged",
            title: "Delete unchanged worktrees",
            description:
              "Remove worktrees with no commits beyond the default branch.",
            keywords: worktreeCleanupKeywords,
          },
        ],
      },
    ],
  },
};

export function visibleSections(scope: SettingsScope | undefined) {
  return settingsSection.options.filter(
    (section) => section !== "projects" || scope?.kind === "project",
  );
}

// The page and settings search both use this, so search never targets a row
// the page does not render. Undefined hides the group.
export function visibleRows(
  group: SettingsGroupInfo,
  scope: SettingsScope | undefined,
): SettingsRowInfo[] | undefined {
  if (group.when === undefined) return group.rows;
  if (scope === undefined) return undefined;
  switch (group.when) {
    case "all-projects":
      return scope.kind === "all" ? group.rows : undefined;
    case "available":
      return scope.kind === "unavailable" ? [] : group.rows;
    case "repository":
      return scope.kind === "project" && scope.workspace.kind === "repository"
        ? group.rows
        : undefined;
  }
}
