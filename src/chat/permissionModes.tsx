// Ported from T3 Code v0.0.45 chat/runtimeModeConfig.ts and settings/ProjectDefaultsSettings.tsx (MIT).
import { useQuery } from "@tanstack/react-query";
import {
  LockIcon,
  LockOpenIcon,
  PenLineIcon,
  SparklesIcon,
} from "lucide-react";
import {
  ipc,
  type PermissionMode,
  type PermissionModeOption,
  type ProviderCapabilities,
  type SessionSettings,
} from "../ipc";

import { cn } from "../lib/cn";
import { selectItem } from "../ui/controls";
import { MenuItem } from "../ui/menu";

export const permissionModeIcons = {
  "approval-required": LockIcon,
  "auto-accept-edits": PenLineIcon,
  auto: SparklesIcon,
  "full-access": LockOpenIcon,
} satisfies Record<PermissionMode, typeof LockIcon>;

export function useProviderCapabilities() {
  return useQuery({
    queryKey: ["provider-capabilities"],
    queryFn: ipc.providerCapabilities,
    retry: false,
  });
}

export function resolvePermissionMode({
  capabilities,
  preferred,
}: {
  capabilities: ProviderCapabilities | undefined;
  preferred: PermissionMode | null;
}): PermissionMode | undefined {
  if (!capabilities) return undefined;
  const requested = preferred ?? capabilities.defaultPermissionMode;
  return capabilities.permissionModes.some(
    (option) => option.value === requested,
  )
    ? requested
    : capabilities.permissionModes.find(
        (option) => option.value === capabilities.defaultPermissionMode,
      )?.value;
}

export type DraftSessionSettings = Omit<SessionSettings, "permissionMode"> & {
  permissionMode: PermissionMode | null;
};

export function newDraftSettings(): DraftSessionSettings {
  return {
    model: null,
    effort: null,
    permissionMode: null,
    interactionMode: "default",
  };
}

export function finishDraftSettings({
  current,
  acceptedAsThread,
}: {
  current: DraftSessionSettings;
  acceptedAsThread: boolean;
}): DraftSessionSettings {
  return acceptedAsThread ? newDraftSettings() : current;
}

export function draftSessionSettings({
  draft,
  preferred,
  capabilities,
}: {
  draft: DraftSessionSettings;
  preferred: PermissionMode | null;
  capabilities: ProviderCapabilities | undefined;
}): SessionSettings | undefined {
  const permissionMode = resolvePermissionMode({
    capabilities,
    preferred: draft.permissionMode ?? preferred,
  });
  return permissionMode === undefined
    ? undefined
    : { ...draft, permissionMode };
}

export function captureDraftSettings({
  current,
  next,
  permissionModeSelected = false,
}: {
  current: DraftSessionSettings;
  next: SessionSettings;
  permissionModeSelected?: boolean;
}): DraftSessionSettings {
  return {
    ...next,
    permissionMode: permissionModeSelected
      ? next.permissionMode
      : current.permissionMode,
  };
}

export function PermissionModeOptions({
  options,
  selected,
  disabled = false,
  presentation = "settings",
  onSelect,
}: {
  options: PermissionModeOption[];
  selected: PermissionMode | undefined;
  disabled?: boolean;
  presentation?: "composer" | "settings";
  onSelect: (mode: PermissionMode) => void;
}) {
  return options.map((option) => {
    const Icon = permissionModeIcons[option.value];
    return (
      <MenuItem
        key={option.value}
        disabled={disabled}
        title={option.description}
        aria-label={option.label}
        role="menuitemradio"
        aria-checked={selected === option.value}
        data-selected={selected === option.value ? "" : undefined}
        className={
          presentation === "composer"
            ? "flex min-h-8 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-pointer items-center rounded-sm px-2 py-1 text-base outline-none data-selected:bg-foreground/[0.08] data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 min-w-64"
            : cn(selectItem, "min-w-64")
        }
        onClick={() => onSelect(option.value)}
      >
        {presentation === "composer" ? (
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid min-w-0 flex-1 gap-0.5">
              <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                {option.label}
              </span>
              <span className="text-muted-foreground text-xs leading-4">
                {option.description}
              </span>
            </div>
          </div>
        ) : (
          <div className="grid gap-0.5">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              {option.label}
            </span>
            <span className="text-xs leading-4 text-muted-foreground">
              {option.description}
            </span>
          </div>
        )}
      </MenuItem>
    );
  });
}
