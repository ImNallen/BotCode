// Classes copied from pingdotgg/t3code v0.0.45 components/chat/ComposerControl.tsx, TraitsPicker.tsx, ProviderModelPicker.tsx and settings/settingsLayout.tsx (MIT).
import { ChevronDownIcon } from "lucide-react";
import type { ModelOption } from "../ipc";
import { cn } from "../lib/cn";
import { Menu, MenuItem } from "../ui/menu";
import { OpenAI } from "../ui/icons";
import { ModelPicker, type ModelPickerSelection } from "./ModelPicker";

export const composerControl =
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-(--control-radius) border border-transparent text-base outline-none hover:bg-accent data-pressed:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 data-disabled:pointer-events-none data-disabled:opacity-64 pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 [&:active:not([aria-haspopup])]:scale-[0.97] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:-mx-0.5 [&_svg[data-composer-control-icon]]:mx-0 h-7 gap-1.5 px-2.5 font-medium text-secondary-label [&_svg:not([class*='text-'])]:text-muted-foreground hover:text-foreground sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 aria-pressed:bg-accent aria-pressed:text-accent-foreground aria-pressed:hover:bg-accent/80";

export const SETTINGS_PICKER_TRIGGER_CLASSNAME = "min-w-0 max-w-none shrink-0";
const settingsPickerTrigger = cn(
  composerControl,
  "min-w-0 shrink justify-between whitespace-nowrap max-w-48 sm:max-w-56",
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
);

const effortLabels: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};
export const effortLabel = (value: string) => effortLabels[value] ?? value;

export function selectedModelOption(
  models: readonly ModelOption[],
  model: string | null,
): ModelOption | undefined {
  return model
    ? models.find((option) => option.model === model)
    : models.find((option) => option.isDefault);
}

export function EffortMenu({
  model,
  effort: selected,
  disabled,
  shortcut = false,
  triggerClassName,
  onSelect,
}: {
  model: ModelOption | undefined;
  effort: string | null;
  disabled: boolean;
  shortcut?: boolean;
  triggerClassName?: string;
  onSelect: (effort: string | null) => void;
}) {
  const effort = selected ?? model?.defaultReasoningEffort;
  return (
    <Menu
      side="top"
      trigger={(props) => (
        <button
          type="button"
          ref={props.ref}
          onClick={props.onClick}
          aria-haspopup={props["aria-haspopup"]}
          aria-expanded={props["aria-expanded"]}
          disabled={disabled || !model}
          aria-label={`Reasoning effort: ${effort ? effortLabel(effort) : "Unavailable"}`}
          data-composer-shortcut={shortcut ? "composer.effort" : undefined}
          className={cn(composerControl, triggerClassName)}
        >
          <span className="capitalize">
            {effort ? effortLabel(effort) : "Effort"}
          </span>
          <ChevronDownIcon className="size-3.5 text-icon-muted" />
        </button>
      )}
    >
      <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
        Reasoning effort
      </div>
      {model?.supportedReasoningEfforts.map((option) => (
        <MenuItem
          key={option.reasoningEffort}
          disabled={disabled}
          title={option.description}
          aria-label={effortLabel(option.reasoningEffort)}
          data-checked={effort === option.reasoningEffort ? "" : undefined}
          className="[&_svg]:-mx-0.5 flex min-h-8 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-pointer items-center rounded-sm px-2 py-1 text-base text-foreground outline-none data-checked:bg-foreground/[0.08] data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0"
          role="menuitemradio"
          aria-checked={effort === option.reasoningEffort}
          onClick={() =>
            onSelect(
              option.reasoningEffort === model.defaultReasoningEffort
                ? null
                : option.reasoningEffort,
            )
          }
        >
          <span className="flex w-full min-w-0 flex-col">
            <span className="flex w-full min-w-0 items-center justify-between gap-3">
              <span className="min-w-0 truncate">
                {effortLabel(option.reasoningEffort)}
                {option.reasoningEffort === model.defaultReasoningEffort ? (
                  <>
                    {" "}
                    <span
                      className={cn(
                        "relative inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-sm border border-transparent font-medium outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-3.5 sm:[&_svg:not([class*='size-'])]:size-3 [&_svg]:pointer-events-none [&_svg]:shrink-0 [button&,a&]:cursor-pointer [button&,a&]:pointer-coarse:after:absolute [button&,a&]:pointer-coarse:after:size-full [button&,a&]:pointer-coarse:after:min-h-11 [button&,a&]:pointer-coarse:after:min-w-11 h-5 min-w-5 rounded-[.25rem] px-[calc(--spacing(1)-1px)] text-xs leading-none sm:h-4 sm:min-w-4 sm:text-[.625rem] border-input bg-background text-foreground dark:bg-input/32 [button&,a&]:hover:bg-accent/50 dark:[button&,a&]:hover:bg-input/48 min-w-0",
                      )}
                    >
                      Default
                    </span>
                  </>
                ) : null}
              </span>
            </span>
            {option.description ? (
              <span className="max-w-56 text-pretty text-muted-foreground/80 text-xs">
                {option.description}
              </span>
            ) : null}
          </span>
        </MenuItem>
      ))}
    </Menu>
  );
}

export function ModelSelectionPicker({
  models,
  loading,
  error,
  selection,
  disabled,
  retry,
  onChange,
}: {
  models: ModelOption[];
  loading: boolean;
  error: string | undefined;
  selection: ModelPickerSelection;
  disabled: boolean;
  retry?: () => void;
  onChange: (selection: ModelPickerSelection) => void;
}) {
  const model = selectedModelOption(models, selection.model);
  const label = model?.displayName ?? selection.model ?? "Codex default";
  return (
    <>
      <ModelPicker
        models={models}
        selection={selection}
        loading={loading}
        error={error}
        disabled={disabled}
        onRetry={() => retry?.()}
        onChange={onChange}
        trigger={(props) => (
          <button
            type="button"
            ref={props.ref}
            onClick={props.onClick}
            aria-haspopup={props["aria-haspopup"]}
            aria-expanded={props["aria-expanded"]}
            disabled={disabled}
            aria-label={`Model: ${label}`}
            className={settingsPickerTrigger}
          >
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <OpenAI className="size-4" />
              <span className="min-w-0 flex-1 overflow-hidden truncate">
                {label}
              </span>
            </span>
            <ChevronDownIcon className="size-3.5 text-icon-muted" />
          </button>
        )}
      />
      <EffortMenu
        model={model}
        effort={selection.effort}
        disabled={disabled}
        triggerClassName={settingsPickerTrigger}
        onSelect={(effort) =>
          onChange({ model: model?.model ?? selection.model, effort })
        }
      />
    </>
  );
}
