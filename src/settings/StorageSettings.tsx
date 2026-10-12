// Ported from pingdotgg/t3code v0.0.45 settings/StorageSettings.tsx (MIT).
import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Switch, selectItem, selectTrigger } from "../ui/controls";
import { Menu, MenuItem } from "../ui/menu";
import {
  customWorktreeCleanup,
  resolveWorktreeCleanup,
  usePreferences,
  type StorageCleanup,
  type WorktreeCleanupRules,
} from "./preferences";
import { writeTarget } from "./ProjectSettingRow";
import { RetentionControl } from "./RetentionControl";
import type { SettingsRowInfo } from "./settingsCatalog";
import type { SettingsScope } from "./settingsScope";
import { SettingsRow } from "./settingsLayout";

const cleanupModes = {
  inherit: {
    label: "Inherit",
    description: "Use each machine's worktree cleanup settings.",
  },
  off: {
    label: "Off",
    description:
      "Keep this project's worktrees until you delete them manually.",
  },
  custom: {
    label: "Custom",
    description: "Use these rules for this project.",
  },
} as const;
type CleanupMode = keyof typeof cleanupModes;

export function StorageSettingsRow({
  info,
  scope,
}: {
  info: SettingsRowInfo;
  scope: SettingsScope | undefined;
}) {
  const { preferences, update, patchProject } = usePreferences();
  const target = writeTarget(scope, false);
  const rules = resolveWorktreeCleanup(
    preferences,
    target.kind === "project" ? target.id : undefined,
  );
  const updateStorage = (patch: Partial<StorageCleanup>) =>
    update({ storageCleanup: { ...preferences.storageCleanup, ...patch } });
  const updateWorktree = (patch: Partial<WorktreeCleanupRules>) => {
    if (target.kind === "all") updateStorage(patch);
    else if (target.kind === "project")
      patchProject(target.id, {
        worktreeCleanup: customWorktreeCleanup(preferences, target.id, patch),
      });
  };
  const row = (
    control: ReactNode,
    description: string = info.description,
    disabled = false,
  ) => (
    <SettingsRow
      id={info.id}
      title={info.title}
      description={description}
      control={control}
      disabled={disabled}
    />
  );
  switch (info.id) {
    case "automatic-worktree-cleanup": {
      const mode: CleanupMode =
        target.kind === "project"
          ? (preferences.projectOverrides[target.id]?.worktreeCleanup?.mode ??
            "inherit")
          : "inherit";
      const choose = (next: CleanupMode) => {
        if (target.kind !== "project") return;
        patchProject(target.id, {
          worktreeCleanup:
            next === "inherit"
              ? undefined
              : next === "off"
                ? { mode: "off" }
                : customWorktreeCleanup(preferences, target.id, {}),
        });
      };
      const disabled = target.kind !== "project";
      return row(
        <Menu
          align="end"
          trigger={(props) => (
            <button
              type="button"
              {...props}
              disabled={disabled}
              aria-label="Automatic worktree cleanup"
              className={selectTrigger()}
            >
              <span className="min-w-0 flex-1 truncate text-left">
                {cleanupModes[mode].label}
              </span>
              <ChevronDownIcon
                aria-hidden
                className="-me-1 size-3 shrink-0 opacity-50"
              />
            </button>
          )}
        >
          {(Object.keys(cleanupModes) as CleanupMode[]).map((option) => (
            <MenuItem
              key={option}
              role="menuitemradio"
              aria-checked={mode === option}
              className={selectItem}
              onClick={() => choose(option)}
            >
              {cleanupModes[option].label}
            </MenuItem>
          ))}
        </Menu>,
        disabled
          ? "Worktree cleanup requires a repository project."
          : cleanupModes[mode].description,
        disabled,
      );
    }
    case "worktree-on-delete":
      return row(
        <Switch
          aria-label="Delete worktrees with deleted threads"
          checked={rules.worktreeOnDelete}
          onCheckedChange={(worktreeOnDelete) =>
            updateWorktree({ worktreeOnDelete })
          }
        />,
      );
    case "worktree-after-days":
      return row(
        <RetentionControl
          label="Delete inactive worktrees"
          value={rules.worktreeAfterDays}
          onChange={(worktreeAfterDays) =>
            updateWorktree({ worktreeAfterDays })
          }
        />,
      );
    case "worktree-on-merge":
      return row(
        <Switch
          aria-label="Delete merged worktrees"
          checked={rules.worktreeOnMerge}
          onCheckedChange={(worktreeOnMerge) =>
            updateWorktree({ worktreeOnMerge })
          }
        />,
      );
    case "worktree-unchanged":
      return row(
        <Switch
          aria-label="Delete unchanged worktrees"
          checked={rules.worktreeUnchanged}
          onCheckedChange={(worktreeUnchanged) =>
            updateWorktree({ worktreeUnchanged })
          }
        />,
      );
    case "browser-artifacts-after-days":
      return row(
        <RetentionControl
          label="Delete old browser artifacts"
          value={preferences.storageCleanup.browserArtifactsAfterDays}
          onChange={(browserArtifactsAfterDays) =>
            updateStorage({ browserArtifactsAfterDays })
          }
        />,
      );
    case "logs-after-days":
      return row(
        <RetentionControl
          label="Delete old rotated logs"
          value={preferences.storageCleanup.logsAfterDays}
          onChange={(logsAfterDays) => updateStorage({ logsAfterDays })}
        />,
      );
    default:
      return null;
  }
}
