// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/threadActionMenu.logic.ts (MIT).
import type { SnoozePreset } from "./lib/snooze";

export type ThreadActionMenuId =
  | "new-thread-on-branch"
  | "filter-by-project"
  | "project-settings"
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "auto-settle"
  | "auto-settle:enabled"
  | "auto-settle:disabled"
  | "snooze"
  | `snooze:${SnoozePreset["id"]}`
  | "snooze:custom"
  | "unsnooze"
  | "rename"
  | "regenerate-title"
  | "mark-unread"
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "copy-thread-id"
  | "archive"
  | "delete";

export type ThreadActionMenuIcon =
  | "message-square-plus"
  | "pin"
  | "pin-off"
  | "circle-check"
  | "clock"
  | "pencil"
  | "refresh-cw"
  | "mail-open"
  | "folder-tree"
  | "timer"
  | "copy"
  | "folder"
  | "git-branch"
  | "hash"
  | "settings"
  | "archive"
  | "trash";

export interface ThreadActionMenuItem {
  readonly id: ThreadActionMenuId;
  readonly label: string;
  readonly icon?: ThreadActionMenuIcon;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly separatorBefore?: boolean;
  readonly checked?: boolean;
  readonly children?: ReadonlyArray<ThreadActionMenuItem>;
}

export interface ThreadActionMenuState {
  readonly branch: string | null;
  readonly projectFilter: {
    readonly label: string;
    readonly isActive: boolean;
  } | null;
  readonly isPinned: boolean;
  readonly isSettled: boolean;
  readonly autoSettleEnabled: boolean;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  readonly isRegeneratingTitle: boolean;
  readonly isRenamePending: boolean;
  readonly isRunning: boolean;
  readonly supports: {
    readonly newThreadOnBranch: boolean;
    readonly autoSettleOptOut: boolean;
    readonly titleRegeneration: boolean;
  };
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
}

export const sidebarThreadMenuSupports: ThreadActionMenuState["supports"] = {
  newThreadOnBranch: false,
  autoSettleOptOut: true,
  titleRegeneration: true,
};

export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
): ReadonlyArray<ThreadActionMenuItem> {
  return [
    ...(state.supports.newThreadOnBranch && state.branch
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: `New thread on ${state.branch}`,
            icon: "message-square-plus" as const,
          },
        ]
      : []),
    state.isPinned
      ? { id: "unpin", label: "Unpin thread", icon: "pin-off" }
      : { id: "pin", label: "Pin thread", icon: "pin" },
    state.isSettled
      ? { id: "unsettle", label: "Un-settle thread", icon: "circle-check" }
      : { id: "settle", label: "Settle thread", icon: "circle-check" },
    state.isSnoozed
      ? { id: "unsnooze", label: "Wake thread", icon: "clock" }
      : {
          id: "snooze",
          label: "Snooze",
          icon: "clock",
          disabled: !state.canSnoozeNow,
          children: [
            ...state.snoozePresets.map((preset) => ({
              id: `snooze:${preset.id}` as const,
              label: `${preset.label} (${preset.whenLabel})`,
            })),
            {
              id: "snooze:custom" as const,
              label: "Custom…",
              separatorBefore: true,
            },
          ],
        },
    {
      id: "rename",
      label: "Rename thread",
      icon: "pencil",
      disabled: state.isRenamePending,
      separatorBefore: true,
    },
    ...(state.supports.titleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle
              ? "Regenerating…"
              : "Regenerate title",
            icon: "refresh-cw" as const,
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    { id: "mark-unread", label: "Mark unread", icon: "mail-open" },
    ...(state.projectFilter
      ? [
          {
            id: "filter-by-project" as const,
            label: state.projectFilter.isActive
              ? "Show all projects"
              : `Filter by ${state.projectFilter.label}`,
            icon: "folder-tree" as const,
          },
        ]
      : []),
    ...(state.supports.autoSettleOptOut
      ? [
          {
            id: "auto-settle" as const,
            label: "Auto-settle behavior",
            icon: "timer" as const,
            children: [
              {
                id: "auto-settle:enabled" as const,
                label: "Enabled",
                checked: state.autoSettleEnabled,
              },
              {
                id: "auto-settle:disabled" as const,
                label: "Disabled",
                checked: !state.autoSettleEnabled,
              },
            ],
          },
        ]
      : []),
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      separatorBefore: true,
      children: [
        { id: "copy-path", label: "Path", icon: "folder" },
        ...(state.branch
          ? [
              {
                id: "copy-branch" as const,
                label: "Branch",
                icon: "git-branch" as const,
              },
            ]
          : []),
        { id: "copy-thread-id", label: "Thread ID", icon: "hash" },
      ],
    },
    { id: "project-settings", label: "Project settings", icon: "settings" },
    {
      id: "archive",
      label: "Archive thread",
      icon: "archive",
      disabled: state.isRunning,
      separatorBefore: true,
    },
    {
      id: "delete",
      label: "Delete",
      destructive: true,
      icon: "trash",
      disabled: state.isRunning,
    },
  ];
}
