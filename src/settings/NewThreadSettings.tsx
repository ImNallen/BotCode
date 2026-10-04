// Rows follow pingdotgg/t3code v0.0.45 settings/ProjectDefaultsSettings.tsx and SettingsPanels.tsx,
// with the popover from SettingInheritance.tsx and classes from ui/popover.tsx (MIT).
import type { ReactNode } from "react";
import { CheckIcon, ChevronDownIcon, LayersIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { Button, Switch, selectItem, selectTrigger } from "../ui/controls";
import { Menu, MenuItem } from "../ui/menu";
import {
  builtInNewThread,
  checkoutModeLabels,
  newThreadDefaults,
  usePreferences,
  type NewThreadSetting,
  type NewThreadValues,
  type ProjectOverride,
} from "./preferences";
import { newThreadRows } from "./settingsCatalog";
import type { SettingsScope } from "./settingsScope";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

type WriteTarget =
  | { kind: "all" }
  | { kind: "project"; id: string }
  | { kind: "none" };

function writeTarget(scope: SettingsScope | undefined): WriteTarget {
  if (scope?.kind === "all") return scope;
  if (scope?.kind === "project" && scope.workspace.kind === "repository")
    return { kind: "project", id: scope.workspace.id };
  return { kind: "none" };
}

const controls: {
  [K in NewThreadSetting]: {
    format: (value: NewThreadValues[K]) => string;
    control: (
      value: NewThreadValues[K],
      set: (value: NewThreadValues[K]) => void,
      disabled: boolean,
    ) => ReactNode;
  };
} = {
  newThreadCheckout: {
    format: (mode) => checkoutModeLabels[mode],
    control: (value, set, disabled) => (
      <Menu
        align="end"
        trigger={(props) => (
          <button
            type="button"
            {...props}
            disabled={disabled}
            aria-label="Default workspace"
            className={selectTrigger()}
          >
            <span className="min-w-0 flex-1 truncate text-left">
              {checkoutModeLabels[value]}
            </span>
            <ChevronDownIcon
              aria-hidden
              className="-me-1 size-3 shrink-0 opacity-50"
            />
          </button>
        )}
      >
        {(["local", "worktree"] as const).map((mode) => (
          <MenuItem
            key={mode}
            role="menuitemradio"
            aria-checked={value === mode}
            data-selected={value === mode ? "" : undefined}
            className={selectItem}
            onClick={() => set(mode)}
          >
            {checkoutModeLabels[mode]}
          </MenuItem>
        ))}
      </Menu>
    ),
  },
  newWorktreesStartFromOrigin: {
    format: (on) => (on ? "On" : "Off"),
    control: (value, set, disabled) => (
      <Switch
        checked={value}
        disabled={disabled}
        onCheckedChange={set}
        aria-label="Start new worktrees from origin by default"
      />
    ),
  },
};

function SettingInheritance({
  summary,
  overridden,
  layers,
}: {
  summary: string;
  overridden: boolean;
  layers: { label: string; value: string; set: boolean; effective: boolean }[];
}) {
  return (
    <Menu
      align="start"
      popupKind={{ kind: "dialog", label: summary }}
      className="w-80 text-popover-foreground"
      contentClassName="rounded-[calc(var(--radius-lg)-1px)] p-0"
      trigger={(props) => (
        <Button
          {...props}
          size="icon-micro"
          variant="ghost-muted"
          aria-label={`${summary}. Show where this value comes from`}
          title={summary}
        >
          <LayersIcon className={cn("size-3", overridden && "text-primary")} />
        </Button>
      )}
    >
      <section className="px-3 py-2.5">
        <ol role="list" className="text-sm">
          {layers.map((layer) => (
            <li
              key={layer.label}
              className={cn(
                "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-2 py-1",
                layer.effective && "bg-foreground/[0.06]",
              )}
            >
              <span
                className={cn(
                  "min-w-0 truncate",
                  layer.effective
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {layer.label}
              </span>
              <span
                className={cn(
                  "flex items-center gap-1.5 tabular-nums",
                  layer.effective
                    ? "text-foreground"
                    : layer.set
                      ? "text-muted-foreground"
                      : "text-muted-foreground/60",
                )}
              >
                <span className="max-w-32 truncate">{layer.value}</span>
                {layer.effective ? (
                  <CheckIcon
                    aria-hidden
                    className="size-3.5 shrink-0 text-primary"
                  />
                ) : (
                  <span aria-hidden className="size-3.5 shrink-0" />
                )}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </Menu>
  );
}

export function NewThreadRow<K extends NewThreadSetting>({
  id,
  setting,
  scope,
}: {
  id: string;
  setting: K;
  scope: SettingsScope | undefined;
}) {
  const { preferences, update, patchProject } = usePreferences();
  const target = writeTarget(scope);
  const labels = newThreadRows[setting];
  const { format, control } = controls[setting];
  const resolved = newThreadDefaults(
    preferences,
    target.kind === "project" ? target.id : undefined,
  );
  const value = resolved.values[setting];
  const allValue: NewThreadValues[K] = preferences[setting];
  const overridden = resolved.overridden[setting];
  const write = (next: NewThreadValues[K] | undefined) => {
    const patch: ProjectOverride = {};
    patch[setting] = next;
    if (target.kind === "project") patchProject(target.id, patch);
    else if (target.kind === "all") update(patch);
  };
  const reset = () => {
    write(target.kind === "project" ? undefined : builtInNewThread[setting]);
    document.getElementById(id)?.focus();
  };
  if (target.kind === "none")
    return (
      <SettingsRow
        id={id}
        title={labels.title}
        description="Threads without a project start in their own folder."
        control={control(value, write, true)}
        disabled
      />
    );
  const scoped = target.kind === "project";
  return (
    <SettingsRow
      id={id}
      title={labels.title}
      description={scoped ? labels.project : labels.all}
      control={control(value, write, false)}
      inheritance={
        <SettingInheritance
          summary={
            overridden
              ? "Overridden for this project"
              : scoped
                ? "Inherited from All projects"
                : "Applies to all projects"
          }
          overridden={overridden}
          layers={[
            ...(scoped
              ? [
                  {
                    label: "This project",
                    value: overridden ? format(value) : "Inherits",
                    set: overridden,
                    effective: overridden,
                  },
                ]
              : []),
            {
              label: "All projects",
              value: format(allValue),
              set: true,
              effective: !overridden,
            },
          ]}
        />
      }
      resetAction={
        scoped ? (
          overridden ? (
            <SettingResetButton
              label={labels.title}
              tooltip="Reset to inherited value"
              onClick={reset}
            />
          ) : null
        ) : allValue !== builtInNewThread[setting] ? (
          <SettingResetButton label={labels.resetLabel} onClick={reset} />
        ) : null
      }
    />
  );
}
