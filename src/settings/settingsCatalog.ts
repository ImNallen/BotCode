// Section order and labels follow pingdotgg/t3code v0.0.45 settings/settingsSearch.ts (MIT).
import {
  ActivityIcon,
  ArchiveIcon,
  GitBranchIcon,
  HardDriveIcon,
  KeyboardIcon,
  PaletteIcon,
  PanelsTopLeftIcon,
  Settings2Icon,
} from "lucide-react";
import { z } from "zod";
import { isMac } from "../permissions/platform";
import { actionIds, actions } from "../lib/actions";
import type { Preferences, ProjectSetting } from "./preferences";
import type { SettingsScope } from "./settingsScope";

export const settingsSection = z.enum([
  "projects",
  "general",
  "source-control",
  "appearance",
  "keybindings",
  "storage",
  "archived",
  "diagnostics",
]);
export type SettingsSection = z.infer<typeof settingsSection>;

export type SettingsRowInfo = {
  id: string;
  title: string;
  description: string;
  keywords?: string;
  // Rows for a project-scoped setting read and write the picked project's override.
  setting?: ProjectSetting;
  when?: "project" | "worktree-rules";
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
  defaultModelSelection: {
    title: "Model",
    all: "Default model for new threads. Projects can override it.",
    project: "Model for new threads in this project.",
    resetLabel: "default model",
    keywords: "default model new thread project provider reasoning effort",
  },
  textGenerationModelSelection: {
    title: "Text generation model",
    all: "Used for thread titles and other generated text on connected devices with this provider.",
    project:
      "Used for thread titles and other generated text on connected devices with this provider.",
    resetLabel: "text generation model",
    keywords: "generated thread titles source control content default provider",
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
// Search terms follow T3 Code v0.0.45 settings/settingsSearch.ts (MIT).
const worktreeCleanupKeywords =
  "worktree cleanup disk storage delete deleted archived threads old inactive merged unchanged worktrees retention days project inherit off custom";
const artifactsKeywords =
  "disk storage browser screenshots captures rotated logs cleanup retention";

export const projectRows = {
  model: {
    id: "project-model",
    title: projectSettingRows.defaultModelSelection.title,
    description: projectSettingRows.defaultModelSelection.project,
    keywords: projectSettingRows.defaultModelSelection.keywords,
  },
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
        rows: [projectRows.model, projectRows.workspace],
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
      ...(isMac
        ? [
            {
              id: "mac-permissions",
              title: "macOS permissions",
              hideTitle: true,
              rows: [
                {
                  id: "mac-permissions-controls",
                  title: "macOS permissions",
                  description:
                    "Screen Recording and Accessibility. Optional for Codex.",
                  keywords: "screen recording accessibility permissions",
                },
              ],
            },
          ]
        : []),
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
            id: "preferred-editor",
            title: "Preferred editor",
            description:
              "Open checkouts and files in this editor. Automatic uses the first installed editor.",
            keywords: "open in editor ide cursor vs code zed finder",
          },
          {
            id: "browser-link-target",
            title: "Open links in",
            description:
              "Where links in the chat and terminal open. Hold ⌘ or Ctrl while clicking a link to open it in your default browser either way.",
            keywords: "links default browser in-app browser external open",
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
            id: "default-model",
            title: projectSettingRows.defaultModelSelection.title,
            description: projectSettingRows.defaultModelSelection.all,
            keywords: projectSettingRows.defaultModelSelection.keywords,
            setting: "defaultModelSelection",
          },
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
          {
            id: "composer-rich-text",
            title: "Rich text composer",
            description: "Show formatted Markdown as you type.",
            keywords:
              "composer rich text tiptap bold italic markdown styled wysiwyg",
          },
          {
            id: "composer-collapse",
            title: "Collapse composer on scroll",
            description:
              "Rest the composer of an existing thread into a single line when you scroll the conversation. Focus the composer or start typing to expand it again.",
            keywords:
              "composer rest resting scroll wheel conversation timeline shrink minimize",
          },
          {
            id: "send-shortcut",
            title: "Send shortcut",
            description:
              "Choose when Enter sends a prompt or inserts a new line",
            keywords:
              "enter return command ctrl multiline prompt new line composer",
          },
          {
            id: "follow-up-behavior",
            title: "Follow-up behavior",
            description:
              "Queue follow-ups while the agent runs or steer the current run.",
            keywords: "queue steer running turn send default behavior composer",
          },
          ...(isMac
            ? [
                {
                  id: "quit-confirmation",
                  title: "Quit shortcut",
                  description: "Hold mode also quits on two quick presses.",
                  keywords:
                    "confirmation desktop app exit direct hold double click press twice",
                },
              ]
            : []),
        ],
      },
      {
        id: "text-generation",
        title: "Text generation",
        when: "available",
        rows: [
          {
            id: "text-generation-model",
            title: projectSettingRows.textGenerationModelSelection.title,
            description: projectSettingRows.textGenerationModelSelection.all,
            keywords: projectSettingRows.textGenerationModelSelection.keywords,
            setting: "textGenerationModelSelection",
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
              "Reset appearance, font sizes, follow-up behavior, the composer, the context window indicator, notifications, the quit shortcut, storage cleanup, new thread defaults, the text generation model, source control and auto-settle, including project overrides, on this device.",
          },
        ],
      },
      {
        id: "general-diagnostics",
        title: "Diagnostics",
        rows: [
          {
            id: "diagnostics",
            title: "Diagnostics",
            description:
              "Inspect processes, resource use, and logs on this device.",
            keywords:
              "logs traces processes resource history failures spans cpu memory",
          },
          {
            id: "open-source-licenses",
            title: "Open source licenses",
            description:
              "Notices for dependencies, assets, and code used by Bot Code.",
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
        id: "appearance-interface",
        title: "Interface",
        rows: [
          {
            id: "setting-appearance-contrast",
            title: "Contrast",
            description:
              "Adjust the contrast of colors and borders across the interface.",
            keywords: "colors borders interface",
          },
          {
            id: "setting-glass-opacity",
            title: "Glass opacity",
            description:
              "Higher values make menus, dialogs, and the composer more solid.",
            keywords: "transparent transparency solid menus dialogs composer",
          },
          {
            id: "diff-color-scheme",
            title: "Diff colors",
            description:
              "Choose colors for additions and deletions, including change counts.",
            keywords:
              "red green blue orange additions deletions changes counts palette colorblind",
          },
          {
            id: "chat-width",
            title: "Chat width",
            description:
              "Set how wide messages and the composer can grow on large screens.",
            keywords: "wide full width column layout messages composer monitor",
          },
        ],
      },
      {
        id: "motion",
        title: "Motion",
        rows: [
          {
            id: "panel-animations",
            title: "Panel animations",
            description: "Set how fast panels open and close.",
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
  diagnostics: {
    title: "Diagnostics",
    icon: ActivityIcon,
    scoped: false,
    groups: [],
  },
  storage: {
    title: "Storage",
    icon: HardDriveIcon,
    scoped: true,
    groups: [
      {
        id: "storage-worktrees",
        title: "Worktrees",
        when: "available",
        rows: [
          {
            id: "automatic-worktree-cleanup",
            title: "Automatic worktree cleanup",
            description: "Use each machine's worktree cleanup settings.",
            keywords: worktreeCleanupKeywords,
            when: "project",
          },
          {
            id: "worktree-on-delete",
            title: "Delete worktrees with deleted threads",
            description:
              "Remove unused worktrees when active or archived threads are deleted. Worktrees with local changes are kept.",
            keywords: worktreeCleanupKeywords,
            when: "worktree-rules",
          },
          {
            id: "worktree-after-days",
            title: "Delete inactive worktrees",
            description:
              "Remove worktrees after their threads have been inactive for this many days. Branches and thread history are kept.",
            keywords: worktreeCleanupKeywords,
            when: "worktree-rules",
          },
          {
            id: "worktree-on-merge",
            title: "Delete merged worktrees",
            description:
              "Remove worktrees whose pull request is merged and whose commits are included in the default branch.",
            keywords: worktreeCleanupKeywords,
            when: "worktree-rules",
          },
          {
            id: "worktree-unchanged",
            title: "Delete unchanged worktrees",
            description:
              "Remove worktrees with no commits beyond the default branch.",
            keywords: worktreeCleanupKeywords,
            when: "worktree-rules",
          },
        ],
      },
      {
        id: "storage-artifacts",
        title: "Artifacts and logs",
        when: "all-projects",
        rows: [
          {
            id: "browser-artifacts-after-days",
            title: "Delete old browser artifacts",
            description:
              "Delete saved browser captures after this many days. Older capture links will no longer open.",
            keywords: artifactsKeywords,
          },
          {
            id: "logs-after-days",
            title: "Delete old rotated logs",
            description:
              "Delete inactive rotated log files after this many days. Current logs are kept.",
            keywords: artifactsKeywords,
          },
        ],
      },
    ],
  },
};

export function visibleSections(scope: SettingsScope | undefined) {
  return settingsSection.options.filter(
    (section) =>
      section !== "diagnostics" &&
      (section !== "projects" || scope?.kind === "project"),
  );
}

function rowVisible(
  row: SettingsRowInfo,
  scope: SettingsScope | undefined,
  preferences: Preferences,
) {
  switch (row.when) {
    case undefined:
      return true;
    case "project":
      return scope?.kind === "project";
    case "worktree-rules":
      return (
        scope?.kind === "all" ||
        (scope?.kind === "project" &&
          scope.workspace.kind === "repository" &&
          preferences.projectOverrides[scope.workspace.id]?.worktreeCleanup
            ?.mode === "custom")
      );
  }
}

// The page and settings search both use this, so search never targets a row
// the page does not render. Undefined hides the group.
export function visibleRows(
  group: SettingsGroupInfo,
  scope: SettingsScope | undefined,
  preferences: Preferences,
): SettingsRowInfo[] | undefined {
  const rows = group.rows.filter((row) => rowVisible(row, scope, preferences));
  if (group.when === undefined) return rows;
  if (scope === undefined) return undefined;
  switch (group.when) {
    case "all-projects":
      return scope.kind === "all" ? rows : undefined;
    case "available":
      return scope.kind === "unavailable" ? [] : rows;
    case "repository":
      return scope.kind === "project" && scope.workspace.kind === "repository"
        ? rows
        : undefined;
  }
}
