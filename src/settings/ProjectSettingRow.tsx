// Ported from T3 Code v0.0.45 settings/ProjectDefaultsSettings.tsx, SettingsPanels.tsx and SettingInheritance.tsx, with ui/popover.tsx and ui/input.tsx classes (MIT).
import { useEffect, useState, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon, LayersIcon } from "lucide-react";
import { cn } from "../lib/cn";
import type { ProviderCapabilities } from "../ipc";
import {
  PermissionModeOptions,
  permissionModeIcons,
  resolvePermissionMode,
  useProviderCapabilities,
} from "../chat/permissionModes";
import { Button, Switch, selectItem, selectTrigger } from "../ui/controls";
import { Menu, MenuItem } from "../ui/menu";
import {
  autoSettleDefaultDays,
  builtInProject,
  checkoutModeLabels,
  projectSetting,
  usePreferences,
  type ProjectOverride,
  type ProjectSetting,
  type ProjectValues,
} from "./preferences";
import { autoSettleDaysRow, projectSettingRows } from "./settingsCatalog";
import type { SettingsScope } from "./settingsScope";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

type WriteTarget =
  | { kind: "all" }
  | { kind: "project"; id: string }
  | { kind: "none" };

function writeTarget(
  scope: SettingsScope | undefined,
  scratch: boolean,
): WriteTarget {
  if (scope?.kind === "all") return scope;
  if (
    scope?.kind === "project" &&
    (scratch || scope.workspace.kind === "repository")
  )
    return { kind: "project", id: scope.workspace.id };
  return { kind: "none" };
}

function AutoSettleDaysInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (days: number) => void;
}) {
  // Local draft so the field can be emptied mid-edit; the setting only moves
  // on valid input and snaps back to the persisted value on blur.
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);
  return (
    <span
      data-size="sm"
      data-slot="input-control"
      className="relative inline-flex rounded-lg border border-input bg-background not-dark:bg-clip-padding text-base text-foreground shadow-xs/5 ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 has-aria-invalid:border-destructive/36 has-focus-visible:border-ring has-autofill:bg-foreground/4 has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none has-focus-visible:ring-[3px] sm:text-sm dark:bg-input/32 dark:has-autofill:bg-foreground/8 dark:has-aria-invalid:ring-destructive/24 dark:not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)] w-full sm:w-24"
    >
      <input
        data-slot="input"
        type="number"
        min={1}
        max={90}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          // Number(), not parseInt: "3.5" must be rejected, not committed as 3.
          const parsed = Number(event.target.value);
          if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 90)
            onCommit(parsed);
        }}
        onBlur={() => setDraft(String(value))}
        aria-label="Days of inactivity before auto-settle"
        className="w-full min-w-0 rounded-[inherit] outline-none placeholder:text-placeholder [transition:background-color_5000000s_ease-in-out_0s] h-7.5 px-[calc(--spacing(2.5)-1px)] leading-7.5 sm:h-6.5 sm:leading-6.5 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
    </span>
  );
}

const controls: {
  [K in ProjectSetting]: {
    format: (
      value: ProjectValues[K],
      capabilities: ProviderCapabilities | undefined,
    ) => string;
    control: (
      value: ProjectValues[K],
      set: (value: ProjectValues[K]) => void,
      disabled: boolean,
      capabilities: ProviderCapabilities | undefined,
    ) => ReactNode;
    // Whether No project can override it. New thread defaults cannot, because
    // those threads start in their own folder.
    scratch: boolean;
    // A second row that edits the same value, shown under the first.
    detail?: (
      value: ProjectValues[K],
      set: (value: ProjectValues[K]) => void,
      inheritance: ReactNode,
    ) => ReactNode;
  };
} = {
  defaultPermissionMode: {
    scratch: true,
    format: (preferred, capabilities) => {
      const value = resolvePermissionMode({ preferred, capabilities });
      return (
        capabilities?.permissionModes.find((option) => option.value === value)
          ?.label ?? "Loading permissions..."
      );
    },
    control: (preferred, set, disabled, capabilities) => {
      const value = resolvePermissionMode({ preferred, capabilities });
      const selected = capabilities?.permissionModes.find(
        (option) => option.value === value,
      );
      const Icon = selected ? permissionModeIcons[selected.value] : undefined;
      return (
        <Menu
          align="end"
          trigger={(props) => (
            <button
              type="button"
              {...props}
              disabled={disabled || !selected}
              aria-label="Default permissions"
              className={selectTrigger()}
            >
              {Icon ? (
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              ) : null}
              <span className="min-w-0 flex-1 truncate text-left">
                {selected?.label ?? "Loading permissions..."}
              </span>
              <ChevronDownIcon
                aria-hidden
                className="-me-1 size-3 shrink-0 opacity-50"
              />
            </button>
          )}
        >
          <PermissionModeOptions
            options={capabilities?.permissionModes ?? []}
            selected={value}
            disabled={disabled}
            onSelect={set}
          />
        </Menu>
      );
    },
  },
  newThreadCheckout: {
    scratch: false,
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
    scratch: false,
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
  autoSettleOnMerge: {
    scratch: true,
    format: (on) => (on ? "On" : "Off"),
    control: (value, set, disabled) => (
      <Switch
        checked={value}
        disabled={disabled}
        onCheckedChange={set}
        aria-label="Auto-settle merged pull requests"
      />
    ),
  },
  sidebarAutoSettleAfterDays: {
    scratch: true,
    format: (days) =>
      days === null ? "Never" : `${days} ${days === 1 ? "day" : "days"}`,
    control: (value, set, disabled) => (
      <Switch
        checked={value !== null}
        disabled={disabled}
        onCheckedChange={(checked) =>
          set(checked ? autoSettleDefaultDays : null)
        }
        aria-label="Auto-settle inactive threads"
      />
    ),
    detail: (value, set, inheritance) =>
      value === null ? null : (
        <SettingsRow
          id={autoSettleDaysRow.id}
          title={autoSettleDaysRow.title}
          description={autoSettleDaysRow.description}
          control={<AutoSettleDaysInput value={value} onCommit={set} />}
          inheritance={inheritance}
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

type ProjectSettingRowProps<K extends ProjectSetting = ProjectSetting> = {
  id: string;
  setting: K;
  scope: SettingsScope | undefined;
};

export function ProjectSettingRow<K extends ProjectSetting>(
  props: ProjectSettingRowProps<K>,
) {
  return props.setting === "defaultPermissionMode" ? (
    <PermissionSettingRow id={props.id} scope={props.scope} />
  ) : (
    <ScopedProjectSettingRow {...props} />
  );
}

function PermissionSettingRow({
  id,
  scope,
}: Omit<ProjectSettingRowProps, "setting">) {
  const query = useProviderCapabilities();
  return (
    <>
      <ScopedProjectSettingRow
        id={id}
        setting="defaultPermissionMode"
        scope={scope}
        capabilities={query.data}
      />
      {query.error && !query.data ? (
        <div role="alert" className="px-4 pb-3 text-sm text-muted-foreground">
          <p>{query.error.message}</p>
          <button
            type="button"
            className="mt-1 font-medium text-foreground hover:underline"
            onClick={() => void query.refetch()}
          >
            Retry permissions
          </button>
        </div>
      ) : null}
    </>
  );
}

function ScopedProjectSettingRow<K extends ProjectSetting>({
  id,
  setting,
  scope,
  capabilities,
}: ProjectSettingRowProps<K> & { capabilities?: ProviderCapabilities }) {
  const { preferences, update, patchProject } = usePreferences();
  const { format, control, scratch, detail } = controls[setting];
  const target = writeTarget(scope, scratch);
  const labels = projectSettingRows[setting];
  const { value, overridden } = projectSetting(
    preferences,
    target.kind === "project" ? target.id : undefined,
    setting,
  );
  const allValue: ProjectValues[K] = preferences[setting];
  const write = (next: ProjectValues[K] | undefined) => {
    const patch: ProjectOverride = {};
    patch[setting] = next;
    if (target.kind === "project") patchProject(target.id, patch);
    else if (target.kind === "all") update(patch);
  };
  const reset = () => {
    write(target.kind === "project" ? undefined : builtInProject[setting]);
    document.getElementById(id)?.focus();
  };
  if (target.kind === "none")
    return (
      <SettingsRow
        id={id}
        title={labels.title}
        description="Threads without a project start in their own folder."
        control={control(value, write, true, capabilities)}
        disabled
      />
    );
  const scoped = target.kind === "project";
  const inheritance = (
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
                value: overridden ? format(value, capabilities) : "Inherits",
                set: overridden,
                effective: overridden,
              },
            ]
          : []),
        {
          label: "All projects",
          value: format(allValue, capabilities),
          set: true,
          effective: !overridden,
        },
      ]}
    />
  );
  return (
    <>
      <SettingsRow
        id={id}
        title={labels.title}
        description={scoped ? labels.project : labels.all}
        control={control(value, write, false, capabilities)}
        inheritance={inheritance}
        resetAction={
          scoped ? (
            overridden ? (
              <SettingResetButton
                label={labels.title}
                tooltip="Reset to inherited value"
                onClick={reset}
              />
            ) : null
          ) : allValue !== builtInProject[setting] ? (
            <SettingResetButton label={labels.resetLabel} onClick={reset} />
          ) : null
        }
      />
      {detail?.(value, write, inheritance)}
    </>
  );
}
