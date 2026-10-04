// Section order and labels follow pingdotgg/t3code v0.0.45 settings/settingsSearch.ts (MIT).
import {
  KeyboardIcon,
  PaletteIcon,
  PanelsTopLeftIcon,
  Settings2Icon,
} from "lucide-react";
import { z } from "zod";
import type { SettingsScope } from "./settingsScope";

export const settingsSection = z.enum([
  "projects",
  "general",
  "appearance",
  "keybindings",
]);
export type SettingsSection = z.infer<typeof settingsSection>;

export type SettingsRowInfo = {
  id: string;
  title: string;
  description: string;
  keywords?: string;
};
type SettingsGroupInfo = {
  id: string;
  title: string;
  hideTitle?: boolean;
  // Groups that depend on the picked project.
  when?: "all-projects" | "repository";
  rows: SettingsRowInfo[];
};
type SettingsCategory = {
  title: string;
  icon: typeof Settings2Icon;
  scoped: boolean;
  groups: SettingsGroupInfo[];
};

export const projectRows = {
  name: {
    id: "project-name",
    title: "Name",
    description: "The name for this project in the sidebar and thread lists.",
    keywords: "rename",
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
            description: "Z1 Code runs your conversations with Codex.",
          },
          {
            id: "approval",
            title: "Approval mode",
            description:
              "Choose Supervised, Auto-accept edits, Auto, or Full access in each conversation composer.",
          },
        ],
      },
      {
        id: "new-threads",
        title: "New threads",
        when: "all-projects",
        rows: [
          {
            id: "workspace",
            title: "Workspace",
            description: "Where new threads start.",
            keywords: "default mode draft current local checkout new worktree",
          },
          {
            id: "start-from-origin",
            title: "Start from origin",
            description:
              "Creates the worktree from the latest matching branch on origin instead of your local branch.",
            keywords: "new worktrees latest matching remote branch local",
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
              "Reset appearance, font sizes and new thread defaults on this device.",
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
              "Set the font size of code blocks, tool output, file previews and diffs.",
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
    case "repository":
      return scope.kind === "project" && scope.workspace.kind === "repository"
        ? group.rows
        : undefined;
  }
}
