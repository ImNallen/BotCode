// Ported from T3 Code v0.0.45 settings/SourceControlWritingSettings.tsx, SourceControlSettings.tsx and ui/textarea.tsx (MIT).
import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, MinusIcon, PlusIcon } from "lucide-react";
import { Menu, MenuItem } from "../ui/menu";
import { Switch, selectItem, selectTrigger } from "../ui/controls";
import {
  builtInProject,
  projectSetting,
  usePreferences,
  type SourceControlWritingStyle,
} from "./preferences";
import { SettingInheritance, writeTarget } from "./ProjectSettingRow";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import type { SettingsScope } from "./settingsScope";

const modeOptions = {
  repo_conventions: {
    label: "Repository conventions",
    description:
      "In each project, matches recent change descriptions and change request titles.",
  },
  conventional_commits: {
    label: "Conventional Commits",
    description:
      "Use Conventional Commit prefixes and keep change request text concise.",
  },
  custom: {
    label: "Custom instructions",
    description:
      "Use your instructions for change descriptions and change requests in every project.",
  },
};

export function SourceControlWritingRow({
  scope,
  templates = false,
}: {
  scope: SettingsScope | undefined;
  templates?: boolean;
}) {
  const { preferences, update, patchProject } = usePreferences();
  const target = writeTarget(scope, false);
  const { value: style, overridden } = projectSetting(
    preferences,
    target.kind === "project" ? target.id : undefined,
    "sourceControlWritingStyle",
  );
  const instructions = useRef<HTMLTextAreaElement>(null);
  const all = preferences.sourceControlWritingStyle;
  const inherited =
    target.kind === "project" ? all : builtInProject.sourceControlWritingStyle;
  const write = (patch: Partial<SourceControlWritingStyle>) => {
    const next = { ...style, ...patch };
    if (target.kind === "project")
      patchProject(target.id, {
        sourceControlWritingStyle:
          JSON.stringify(next) === JSON.stringify(all) ? undefined : next,
      });
    else if (target.kind === "all") update({ sourceControlWritingStyle: next });
  };
  const format = (value: SourceControlWritingStyle) =>
    templates
      ? value.followChangeRequestTemplates
        ? "On"
        : "Off"
      : modeOptions[value.mode].label;
  const inheritance =
    target.kind === "none" ? undefined : (
      <SettingInheritance
        summary={
          overridden
            ? "Overridden for this project"
            : target.kind === "project"
              ? "Inherited from All projects"
              : "Applies to all projects"
        }
        overridden={overridden}
        layers={[
          ...(target.kind === "project"
            ? [
                {
                  label: "This project",
                  value: overridden ? format(style) : "Inherits",
                  set: overridden,
                  effective: overridden,
                },
              ]
            : []),
          {
            label: "All projects",
            value: format(all),
            set: true,
            effective: !overridden,
          },
        ]}
      />
    );
  const dirty = templates
    ? style.followChangeRequestTemplates !==
      inherited.followChangeRequestTemplates
    : style.mode !== inherited.mode ||
      style.customInstructions !== inherited.customInstructions;
  const disabled = target.kind === "none";
  return (
    <SettingsRow
      id={
        templates
          ? "follow-change-request-templates"
          : "source-control-writing-style"
      }
      title={
        templates
          ? "Follow change request templates"
          : "Source control writing style"
      }
      description={
        disabled
          ? "Source control settings require a repository project."
          : templates
            ? "Use the repository's template for change request descriptions when available."
            : modeOptions[style.mode].description
      }
      disabled={disabled}
      inheritance={inheritance}
      resetAction={
        dirty && !disabled ? (
          <SettingResetButton
            label={
              templates
                ? "change request templates"
                : "source control writing style"
            }
            tooltip={
              target.kind === "project"
                ? "Reset to inherited value"
                : "Reset to default"
            }
            onClick={() =>
              write(
                templates
                  ? {
                      followChangeRequestTemplates:
                        inherited.followChangeRequestTemplates,
                    }
                  : {
                      mode: inherited.mode,
                      customInstructions: inherited.customInstructions,
                    },
              )
            }
          />
        ) : undefined
      }
      control={
        templates ? (
          <Switch
            disabled={disabled}
            checked={style.followChangeRequestTemplates}
            onCheckedChange={(followChangeRequestTemplates) =>
              write({ followChangeRequestTemplates })
            }
            aria-label="Follow change request templates"
          />
        ) : (
          <Menu
            align="end"
            trigger={(props) => (
              <button
                {...props}
                type="button"
                disabled={disabled}
                className={selectTrigger({
                  size: "sm",
                  className: "w-full sm:w-56",
                })}
                aria-label="Source control writing style"
              >
                <span className="min-w-0 flex-1 truncate text-left">
                  {modeOptions[style.mode].label}
                </span>
                <ChevronDownIcon
                  aria-hidden
                  className="-me-1 size-3 shrink-0 opacity-50"
                />
              </button>
            )}
          >
            {(
              ["repo_conventions", "conventional_commits", "custom"] as const
            ).map((mode) => (
              <MenuItem
                key={mode}
                className={selectItem}
                role="menuitemradio"
                aria-checked={style.mode === mode}
                onClick={() =>
                  write({
                    mode,
                    ...(instructions.current
                      ? {
                          customInstructions: instructions.current.value.trim(),
                        }
                      : {}),
                  })
                }
              >
                {modeOptions[mode].label}
              </MenuItem>
            ))}
          </Menu>
        )
      }
    >
      {!templates && style.mode === "custom" ? (
        <div className="mt-3 max-w-2xl pb-3.5">
          <span
            data-size="default"
            data-slot="textarea-control"
            className="relative inline-flex w-full rounded-lg border border-input bg-background not-dark:bg-clip-padding text-base text-foreground shadow-xs/5 ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 has-aria-invalid:border-destructive/36 has-focus-visible:border-ring has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none has-focus-visible:ring-[3px] not-has-disabled:has-not-focus-visible:not-has-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] sm:text-sm dark:bg-input/32 dark:has-aria-invalid:ring-destructive/24 dark:not-has-disabled:has-not-focus-visible:not-has-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)]"
          >
            <textarea
              key={style.customInstructions}
              ref={instructions}
              disabled={disabled}
              defaultValue={style.customInstructions}
              onBlur={(event) => {
                const customInstructions = event.target.value.trim();
                if (customInstructions !== style.customInstructions)
                  write({ customInstructions });
              }}
              rows={4}
              placeholder="Keep titles concise. Use short bullet points in descriptions."
              aria-label="Custom source control writing instructions"
              className="field-sizing-content min-h-17.5 max-h-64 w-full rounded-[inherit] px-[calc(--spacing(3)-1px)] py-[calc(--spacing(1.5)-1px)] outline-none max-sm:min-h-20.5"
            />
          </span>
        </div>
      ) : null}
    </SettingsRow>
  );
}

export function GitFetchIntervalSettings() {
  const { preferences, update } = usePreferences();
  const value = Math.round(preferences.automaticGitFetchInterval / 1000);
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = (seconds: number) => {
    if (Number.isFinite(seconds))
      update({
        automaticGitFetchInterval: Math.max(0, Math.round(seconds)) * 1000,
      });
  };
  return (
    <SettingsRow
      id="git-fetch-interval"
      title="Git fetch interval"
      description="Refresh remote branches in the background. Set to 0 to avoid automatic Git prompts. Applies to this device."
      resetAction={
        value !== 30 ? (
          <SettingResetButton
            label="fetch interval"
            onClick={() => update({ automaticGitFetchInterval: 30_000 })}
          />
        ) : undefined
      }
      control={
        <div className="flex shrink-0 items-center gap-2">
          <div
            data-size="sm"
            data-slot="number-field"
            className="flex w-32 flex-col items-start gap-2"
          >
            <div
              data-slot="number-field-group"
              className="relative flex w-full justify-between rounded-lg border border-input bg-background not-dark:bg-clip-padding text-base text-foreground shadow-xs/5 ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-data-disabled:not-focus-within:not-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] focus-within:border-ring focus-within:ring-[3px] has-aria-invalid:border-destructive/36 has-autofill:bg-foreground/4 focus-within:has-aria-invalid:border-destructive/64 focus-within:has-aria-invalid:ring-destructive/48 data-disabled:pointer-events-none data-disabled:opacity-64 sm:text-sm dark:bg-input/32 dark:has-autofill:bg-foreground/8 dark:has-aria-invalid:ring-destructive/24 dark:not-data-disabled:not-focus-within:not-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)] [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 [[data-disabled],:focus-within,[aria-invalid]]:shadow-none"
            >
              <button
                type="button"
                aria-label="Decrease fetch interval"
                disabled={value === 0}
                onClick={() => commit(value - 5)}
                data-slot="number-field-decrement"
                className="relative flex shrink-0 cursor-pointer items-center justify-center rounded-s-[calc(var(--radius-lg)-1px)] in-data-[size=sm]:px-[calc(--spacing(2.5)-1px)] px-[calc(--spacing(3)-1px)] transition-colors pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:bg-accent"
              >
                <MinusIcon />
              </button>
              <input
                type="text"
                inputMode="numeric"
                role="spinbutton"
                aria-valuemin={0}
                aria-valuenow={value}
                aria-label="Automatic Git fetch interval in seconds"
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  commit(
                    event.target.value === "" ? 0 : Number(event.target.value),
                  );
                }}
                onBlur={() => setDraft(String(value))}
                onKeyDown={(event) => {
                  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                    event.preventDefault();
                    commit(value + (event.key === "ArrowUp" ? 5 : -5));
                  }
                }}
                className="h-8.5 in-data-[size=lg]:h-9.5 in-data-[size=sm]:h-7.5 w-full min-w-0 grow bg-transparent in-data-[size=sm]:px-[calc(--spacing(2.5)-1px)] px-[calc(--spacing(3)-1px)] text-center tabular-nums in-data-[size=lg]:leading-9.5 in-data-[size=sm]:leading-7.5 leading-8.5 outline-none [transition:background-color_5000000s_ease-in-out_0s] sm:h-7.5 sm:in-data-[size=lg]:h-8.5 sm:in-data-[size=sm]:h-6.5 sm:in-data-[size=lg]:leading-8.5 sm:in-data-[size=sm]:leading-8.5 sm:leading-7.5"
              />
              <button
                type="button"
                aria-label="Increase fetch interval"
                onClick={() => commit(value + 5)}
                data-slot="number-field-increment"
                className="relative flex shrink-0 cursor-pointer items-center justify-center rounded-e-[calc(var(--radius-lg)-1px)] in-data-[size=sm]:px-[calc(--spacing(2.5)-1px)] px-[calc(--spacing(3)-1px)] transition-colors pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:bg-accent"
              >
                <PlusIcon />
              </button>
            </div>
          </div>
          <span className="text-xs text-muted-foreground">seconds</span>
        </div>
      }
    />
  );
}
