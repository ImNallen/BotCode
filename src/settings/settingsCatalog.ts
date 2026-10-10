// Section order and labels follow pingdotgg/t3code v0.0.45 settings/settingsSearch.ts (MIT).
import {
  ArchiveIcon,
  GitBranchIcon,
  HardDriveIcon,
  KeyboardIcon,
  PaletteIcon,
  PanelsTopLeftIcon,
  Settings2Icon,
} from "lucide-react";
import { z } from "zod";
import { actionIds, actions } from "../lib/actions";
import type { ProjectSetting } from "./preferences";
import type { SettingsScope } from "./settingsScope";

export const settingsSection = z.enum([
  "projects",
  "general",
  "source-control",
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
  sourceControlWritingStyle: {
    title: "Source control writing style",
    all: "In each project, matches recent change descriptions and change request titles.",
    project:
      "In each project, matches recent change descriptions and change request titles.",
    resetLabel: "source control writing style",
    keywords:
      "source control writing style conventional commits custom instructions",
  },
  defaultAutoPull: {
    title: "Automatically pull",
    all: "Keeps the default branch current when the checkout has no local changes or commits. Projects can override it.",
    project:
      "Keeps this project's default branch current when the checkout has no local changes or commits.",
    resetLabel: "default automatic pull",
    keywords: "automatic pull default branch git",
  },
  pullRequestMergeMethod: {
    title: "Default merge method",
    all: "Pull requests start with this method. Last selected reuses whatever you chose most recently on this device.",
    project: "Pull requests in this project start with this method.",
    resetLabel: "default merge method",
    keywords: "pull request merge squash rebase last selected",
  },
  defaultPermissionMode: {
    title: "Permissions",
    all: "Default permissions for new threads. Projects can override them.",
    project: "Permissions for new threads in this project.",
    resetLabel: "default permissions",
    keywords:
      "approval supervised auto accept edits full access sandbox permissions",
  },
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
  icon: {
    id: "project-icon",
    title: "Project icon",
    description: "Choose an icon, emoji, monogram, or image file.",
    keywords: "favicon badge color",
  },
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
        rows: [projectRows.name, projectRows.icon],
      },
      {
        id: "project-new-threads",
        title: "New threads",
        rows: [projectRows.workspace],
      },
      {
        id: "project-actions",
        title: "Actions",
        when: "repository",
        rows: [
          {
            id: "project-actions-list",
            title: "Actions",
            description:
              "Commands that run in this project's checkout or its worktree, with optional shortcuts.",
            keywords:
              "scripts t3.json setup preview command add edit delete action import",
          },
        ],
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
              "Choose the permissions supported by your provider in each conversation composer.",
          },
          {
            id: "follow-up-behavior",
            title: "Follow-up behavior",
            description:
              "Queue follow-ups while the agent runs or steer the current run.",
          },
          {
            id: "preferred-editor",
            title: "Preferred editor",
            description:
              "Open checkouts and files in this editor. Automatic uses the first installed editor.",
            keywords: "open in editor ide cursor vs code zed finder",
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
            id: "default-permissions",
            title: projectSettingRows.defaultPermissionMode.title,
            description: projectSettingRows.defaultPermissionMode.all,
            keywords: projectSettingRows.defaultPermissionMode.keywords,
            setting: "defaultPermissionMode",
          },
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
            id: "working-shelf",
            title: "Working section (beta)",
            description:
              "Fold working and monitoring threads into a Working section. They return to the top of the inbox when they need you.",
            keywords:
              "hide fold running monitoring threads inbox sidebar shelf",
          },
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
        id: "behavior",
        title: "Behavior",
        rows: [
          {
            id: "thread-notifications",
            title: "Thread notifications",
            description:
              "System alerts when a thread finishes, fails, or needs approval. Applies to this device while Bot Code is open.",
            keywords:
              "notification sound alert completion input approval desktop",
          },
          {
            id: "in-app-notifications",
            title: "In-app notifications",
            description:
              "Show a toast when another thread finishes, fails, or needs approval while this app has focus.",
            keywords:
              "notification toast popup completion input approval failure",
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
              "Reset appearance, font sizes, follow-up behavior, the context window indicator, notifications, storage cleanup, new thread defaults, source control and auto-settle, including project overrides, on this device.",
          },
        ],
      },
    ],
  },
  "source-control": {
    title: "Source Control",
    icon: GitBranchIcon,
    scoped: true,
    groups: [
      {
        id: "source-control-defaults",
        title: "Defaults",
        when: "available",
        rows: [
          {
            id: "automatic-pull",
            title: projectSettingRows.defaultAutoPull.title,
            description: projectSettingRows.defaultAutoPull.all,
            keywords: projectSettingRows.defaultAutoPull.keywords,
            setting: "defaultAutoPull",
          },
          {
            id: "pull-request-merge-method",
            title: projectSettingRows.pullRequestMergeMethod.title,
            description: projectSettingRows.pullRequestMergeMethod.all,
            keywords: projectSettingRows.pullRequestMergeMethod.keywords,
            setting: "pullRequestMergeMethod",
          },
        ],
      },
      {
        id: "version-control",
        title: "Version Control",
        rows: [
          {
            id: "git-fetch-interval",
            title: "Git fetch interval",
            description:
              "Refresh remote branches in the background. Set to 0 to avoid automatic Git prompts.",
          },
        ],
      },
      {
        id: "source-control-providers",
        title: "Source Control Providers",
        rows: [
          {
            id: "github-provider",
            title: "GitHub",
            description:
              "Source control provider authentication and repository publishing.",
            keywords: "gh login auth account rescan publish repository",
          },
        ],
      },
      {
        id: "source-control-text-generation",
        title: "Text generation",
        when: "available",
        rows: [
          {
            id: "source-control-writing-style",
            title: "Source control writing style",
            description: projectSettingRows.sourceControlWritingStyle.all,
            keywords: projectSettingRows.sourceControlWritingStyle.keywords,
            setting: "sourceControlWritingStyle",
          },
          {
            id: "follow-change-request-templates",
            title: "Follow change request templates",
            description:
              "Use the repository's template for change request descriptions when available.",
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
    groups: ["Navigation", "Threads", "Terminal", "Composer"].map((group) => ({
      id: group.toLowerCase(),
      title: group,
      hideTitle: true,
      rows: actionIds
        .filter(
          (id) =>
            actions[id].group === group &&
            !actions[id].submenu &&
            actions[id].shortcutOwner !== "palette",
        )
        .map((id) => ({
          id,
          title: actions[id].title,
          description: actions[id].shortcutDescription ?? "",
          keywords: actions[id].keywords,
        })),
    })),
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
