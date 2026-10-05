// Structure and classes follow pingdotgg/t3code v0.0.45 components/chat/ChatComposer.tsx,
// ComposerControl.tsx, ComposerPrimaryActions.tsx, BranchToolbar.tsx, BranchToolbarEnvModeSelector.tsx,
// TraitsPicker.tsx and ui/badge.tsx (MIT).
import { useLayoutEffect, useRef, type ReactNode } from "react";
import {
  ChevronDownIcon,
  FolderGit2Icon,
  FolderGitIcon,
  FolderIcon,
  LockIcon,
  LockOpenIcon,
  PenLineIcon,
  SparklesIcon,
} from "lucide-react";
import { Menu, MenuItem } from "../ui/menu";
import type { Checkout, ModelOption, SessionSettings } from "../ipc";
import { cn } from "../lib/cn";
import { checkoutModeLabels, type CheckoutMode } from "../settings/preferences";
import { selectItem, selectTrigger } from "../ui/controls";
import { OpenAI } from "../ui/icons";
import { ModelPicker } from "./ModelPicker";
import { ComposerSurface } from "./ComposerSurface";

const composerControl =
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-(--control-radius) border border-transparent text-base outline-none hover:bg-accent data-pressed:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 data-disabled:pointer-events-none data-disabled:opacity-64 pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 [&:active:not([aria-haspopup])]:scale-[0.97] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:-mx-0.5 [&_svg[data-composer-control-icon]]:mx-0 h-7 gap-1.5 px-2.5 font-medium text-secondary-label [&_svg:not([class*='text-'])]:text-muted-foreground hover:text-foreground sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 aria-pressed:bg-accent aria-pressed:text-accent-foreground aria-pressed:hover:bg-accent/80";

const contextControl =
  "inline-flex h-7 min-w-0 items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6";

export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  canSend,
  running,
  canStop,
  stopping,
  placeholder,
  approval,
  disabled,
  context,
  autoFocus,
  focusRequest,
  settings,
  models,
  modelsLoading,
  modelsError,
  onRetryModels,
  onSettingsChange,
  settingsDisabled,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  canSend: boolean;
  running: boolean;
  canStop: boolean;
  stopping: boolean;
  placeholder: string;
  approval: ReactNode;
  disabled: boolean;
  context?: {
    checkout:
      | Checkout
      | {
          kind: "draft";
          mode: CheckoutMode;
          onChange: (mode: CheckoutMode) => void;
        }
      | undefined;
    branch: ReactNode;
  };
  autoFocus?: boolean;
  focusRequest?: number;
  settings: SessionSettings;
  models: ModelOption[];
  modelsLoading: boolean;
  modelsError?: string;
  onRetryModels: () => void;
  onSettingsChange: (settings: SessionSettings) => void;
  settingsDisabled: boolean;
}) {
  const editor = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (focusRequest) editor.current?.focus();
  }, [focusRequest]);
  useLayoutEffect(() => {
    const element = editor.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [value, approval]);
  const approvalState = approval !== null;
  const selectedModel = settings.model
    ? models.find((model) => model.model === settings.model)
    : models.find((model) => model.isDefault);
  const effort = settings.effort ?? selectedModel?.defaultReasoningEffort;
  const effortLabel = (value: string) =>
    ({
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "Extra high",
      max: "Max",
      ultra: "Ultra",
    })[value] ?? value;
  const modes = [
    {
      value: "approval-required",
      label: "Supervised",
      description: "Ask before commands and file changes.",
      icon: LockIcon,
    },
    {
      value: "auto-accept-edits",
      label: "Auto-accept edits",
      description: "Auto-approve edits, ask before other actions.",
      icon: PenLineIcon,
    },
    {
      value: "auto",
      label: "Auto",
      description:
        "Supported providers approve routine actions; others still ask.",
      icon: SparklesIcon,
    },
    {
      value: "full-access",
      label: "Full access",
      description: "Allow commands and edits without prompts.",
      icon: LockOpenIcon,
    },
  ] as const;
  const selectedMode =
    modes.find((mode) => mode.value === settings.permissionMode) ?? modes[0];
  const RuntimeIcon = selectedMode.icon;
  const checkout = context?.checkout;
  return (
    <ComposerSurface.Shell contextStrip={context !== undefined}>
      <ComposerSurface.Host>
        <div className="relative z-10">
          <form
            className="mx-auto w-full min-w-0 max-w-(--chat-max-width)"
            data-chat-composer-form="true"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit();
            }}
          >
            {approval}
            <div className="relative">
              <ComposerSurface.Main>
                <div
                  data-chat-composer-surface="true"
                  className="rounded-3xl transition-[background-color] duration-200"
                >
                  <div
                    data-chat-composer-body="true"
                    className={cn(
                      "relative px-3 pb-2 sm:px-4",
                      "pt-3.5 sm:pt-4",
                      approvalState && "pb-3 sm:pb-4",
                    )}
                  >
                    <div className="relative">
                      <div className="relative flow-root font-(family-name:--font-composer,var(--font-sans)) text-(length:--font-size-prompt,var(--text-sm))">
                        <textarea
                          ref={editor}
                          aria-label="Message"
                          rows={1}
                          autoFocus={autoFocus}
                          autoCapitalize="off"
                          autoCorrect="off"
                          spellCheck={false}
                          disabled={disabled}
                          value={approvalState ? "" : value}
                          placeholder={placeholder}
                          onChange={(event) => onChange(event.target.value)}
                          onKeyDown={(event) => {
                            if (
                              event.key === "Enter" &&
                              !event.shiftKey &&
                              !event.nativeEvent.isComposing
                            ) {
                              event.preventDefault();
                              onSubmit();
                            }
                          }}
                          className={cn(
                            "-m-1 block max-h-52 min-h-19.5 w-[calc(100%+0.5rem)] resize-none overflow-y-auto p-1 whitespace-pre-wrap wrap-break-word bg-transparent leading-relaxed text-foreground placeholder:text-placeholder/75 focus:outline-none disabled:cursor-default",
                            approvalState && "min-h-10",
                          )}
                        />
                      </div>
                    </div>
                  </div>
                  {approvalState ? null : (
                    <div
                      data-chat-composer-footer="true"
                      className="flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-3 pb-3 sm:px-4 sm:pb-4 sm:gap-0"
                    >
                      <div
                        data-chat-composer-controls="left"
                        className="relative -m-1 -ms-3.5 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 ps-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                      >
                        <ModelPicker
                          models={models}
                          settings={settings}
                          loading={modelsLoading}
                          error={modelsError}
                          disabled={settingsDisabled}
                          onRetry={onRetryModels}
                          onChange={onSettingsChange}
                          trigger={(props) => (
                            <button
                              type="button"
                              ref={props.ref}
                              onClick={props.onClick}
                              aria-haspopup={props["aria-haspopup"]}
                              aria-expanded={props["aria-expanded"]}
                              disabled={settingsDisabled}
                              aria-label={`Model: ${selectedModel?.displayName ?? settings.model ?? "Codex default"}`}
                              className={cn(
                                composerControl,
                                "-ms-2.5 min-w-0 shrink",
                              )}
                            >
                              <OpenAI className="size-4" />
                              <span className="max-w-36 truncate">
                                {selectedModel?.displayName ??
                                  settings.model ??
                                  "Codex default"}
                              </span>
                              <ChevronDownIcon className="size-3.5 text-icon-muted" />
                            </button>
                          )}
                        />
                        <Menu
                          side="top"
                          trigger={(props) => (
                            <button
                              type="button"
                              ref={props.ref}
                              onClick={props.onClick}
                              aria-haspopup={props["aria-haspopup"]}
                              aria-expanded={props["aria-expanded"]}
                              disabled={settingsDisabled || !selectedModel}
                              aria-label={`Reasoning effort: ${effort ? effortLabel(effort) : "Unavailable"}`}
                              className={composerControl}
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
                          {selectedModel?.supportedReasoningEfforts.map(
                            (option) => (
                              <MenuItem
                                key={option.reasoningEffort}
                                disabled={settingsDisabled}
                                title={option.description}
                                aria-label={effortLabel(option.reasoningEffort)}
                                data-checked={
                                  effort === option.reasoningEffort
                                    ? ""
                                    : undefined
                                }
                                className="[&_svg]:-mx-0.5 flex min-h-8 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-pointer items-center rounded-sm px-2 py-1 text-base text-foreground outline-none data-checked:bg-foreground/[0.08] data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0"
                                role="menuitemradio"
                                aria-checked={effort === option.reasoningEffort}
                                onClick={() =>
                                  onSettingsChange({
                                    ...settings,
                                    effort:
                                      option.reasoningEffort ===
                                      selectedModel.defaultReasoningEffort
                                        ? null
                                        : option.reasoningEffort,
                                  })
                                }
                              >
                                <span className="flex w-full min-w-0 flex-col">
                                  <span className="flex w-full min-w-0 items-center justify-between gap-3">
                                    <span className="min-w-0 truncate">
                                      {effortLabel(option.reasoningEffort)}
                                      {option.reasoningEffort ===
                                      selectedModel.defaultReasoningEffort ? (
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
                            ),
                          )}
                        </Menu>
                        <div
                          role="separator"
                          aria-orientation="vertical"
                          className="shrink-0 bg-border w-px mx-0.5 hidden sm:block h-4"
                        />
                        <Menu
                          side="top"
                          trigger={(props) => (
                            <button
                              type="button"
                              ref={props.ref}
                              onClick={props.onClick}
                              aria-haspopup={props["aria-haspopup"]}
                              aria-expanded={props["aria-expanded"]}
                              disabled={settingsDisabled}
                              title={selectedMode.description}
                              aria-label={`Access mode: ${selectedMode.label}`}
                              className={composerControl}
                            >
                              <RuntimeIcon
                                aria-hidden="true"
                                className="shrink-0 size-4"
                                data-composer-control-icon
                              />
                              <span data-composer-control-label>
                                {selectedMode.label}
                              </span>
                              <ChevronDownIcon className="size-3.5 text-icon-muted" />
                            </button>
                          )}
                        >
                          {modes.map((mode) => (
                            <MenuItem
                              key={mode.value}
                              disabled={settingsDisabled}
                              title={mode.description}
                              aria-label={mode.label}
                              data-selected={
                                settings.permissionMode === mode.value
                                  ? ""
                                  : undefined
                              }
                              className="flex min-h-8 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-pointer items-center rounded-sm px-2 py-1 text-base outline-none data-selected:bg-foreground/[0.08] data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 min-w-64"
                              role="menuitemradio"
                              aria-checked={
                                settings.permissionMode === mode.value
                              }
                              onClick={() =>
                                onSettingsChange({
                                  ...settings,
                                  permissionMode: mode.value,
                                })
                              }
                            >
                              <div className="flex min-w-0 items-center gap-3">
                                <div className="grid min-w-0 flex-1 gap-0.5">
                                  <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                                    <mode.icon className="size-3.5 shrink-0 text-muted-foreground" />
                                    {mode.label}
                                  </span>
                                  <span className="text-muted-foreground text-xs leading-4">
                                    {mode.description}
                                  </span>
                                </div>
                              </div>
                            </MenuItem>
                          ))}
                        </Menu>
                      </div>
                      <div
                        data-chat-composer-actions="right"
                        className="flex shrink-0 flex-nowrap items-center justify-end gap-2"
                      >
                        {running && canStop ? (
                          <button
                            type="button"
                            className="flex cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-2xs inset-shadow-white/16 transition-all duration-150 hover:bg-destructive hover:scale-105 active:inset-shadow-black/8 active:shadow-none disabled:pointer-events-none disabled:opacity-64 size-8 sm:h-8 sm:w-8"
                            onClick={onStop}
                            disabled={stopping}
                            aria-label="Stop generation"
                            title="Interrupt"
                          >
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 12 12"
                              fill="currentColor"
                              aria-hidden="true"
                            >
                              <rect x="2" y="2" width="8" height="8" rx="1.5" />
                            </svg>
                          </button>
                        ) : (
                          <button
                            type="submit"
                            className="relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-2xs enabled:inset-shadow-white/16 hover:scale-105 active:inset-shadow-black/8 active:shadow-none disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8 bg-message-action text-message-action-foreground enabled:shadow-message-action/24 hover:bg-message-action-hover"
                            disabled={!canSend}
                            aria-label="Send message"
                          >
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 14 14"
                              fill="none"
                              aria-hidden="true"
                            >
                              <path
                                d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </ComposerSurface.Main>
            </div>
          </form>
        </div>
      </ComposerSurface.Host>
      {context ? (
        <div className="min-h-0">
          <div className="relative z-0">
            <div className="pointer-events-auto">
              <ComposerSurface.ContextStrip className="gap-1 text-xs font-normal text-muted-foreground/70">
                <div className="min-h-7 min-w-10 items-center gap-1 sm:min-h-6 flex flex-1">
                  {checkout?.kind === "draft" ? (
                    <Menu
                      side="top"
                      trigger={(props) => (
                        <button
                          type="button"
                          {...props}
                          disabled={settingsDisabled}
                          aria-label="Workspace"
                          className={selectTrigger({
                            variant: "ghost",
                            size: "xs",
                            className: "min-w-0 shrink",
                          })}
                        >
                          <CheckoutModeIcon mode={checkout.mode} />
                          <span className="min-w-0 max-w-[240px] truncate">
                            {checkoutModeLabels[checkout.mode]}
                          </span>
                          <ChevronDownIcon
                            aria-hidden
                            className="-me-1 size-3 opacity-50"
                          />
                        </button>
                      )}
                    >
                      <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
                        Workspace
                      </div>
                      {(["local", "worktree"] as const).map((mode) => (
                        <MenuItem
                          key={mode}
                          role="menuitemradio"
                          aria-checked={checkout.mode === mode}
                          data-selected={
                            checkout.mode === mode ? "" : undefined
                          }
                          className={selectItem}
                          onClick={() => checkout.onChange(mode)}
                        >
                          <span className="inline-flex items-center gap-1.5 [&_svg:not([class*='text-'])]:text-muted-foreground">
                            <CheckoutModeIcon mode={mode} />
                            {checkoutModeLabels[mode]}
                          </span>
                        </MenuItem>
                      ))}
                    </Menu>
                  ) : checkout ? (
                    <span
                      className={contextControl}
                      title={
                        checkout.kind === "worktree" ? checkout.path : undefined
                      }
                    >
                      {checkout.kind === "worktree" ? (
                        <FolderGitIcon className="size-3 shrink-0" />
                      ) : (
                        <FolderIcon className="size-3 shrink-0" />
                      )}
                      <span className="min-w-0 max-w-[240px] truncate">
                        {checkout.kind === "worktree"
                          ? "Worktree"
                          : "Local checkout"}
                      </span>
                    </span>
                  ) : null}
                </div>
                <div className="flex min-w-0 items-center gap-1 min-w-0 flex-initial justify-end ml-auto">
                  {context.branch}
                </div>
              </ComposerSurface.ContextStrip>
            </div>
          </div>
        </div>
      ) : null}
    </ComposerSurface.Shell>
  );
}

function CheckoutModeIcon({ mode }: { mode: CheckoutMode }) {
  return mode === "worktree" ? (
    <FolderGit2Icon className="size-3" />
  ) : (
    <FolderIcon className="size-3" />
  );
}
