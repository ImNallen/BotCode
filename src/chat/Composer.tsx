// Structure and classes follow pingdotgg/t3code v0.0.45 components/chat/ChatComposer.tsx,
// ComposerControl.tsx, ComposerPrimaryActions.tsx and BranchToolbar.tsx (MIT).
import { useLayoutEffect, useRef, type ReactNode } from "react";
import {
  ChevronDownIcon,
  FolderIcon,
  GitBranchIcon,
  LockIcon,
  LockOpenIcon,
  PenLineIcon,
  SparklesIcon,
} from "lucide-react";
import { Menu, MenuItem } from "../ui/menu";
import type { ModelOption, SessionSettings } from "../ipc";
import { cn } from "../lib/cn";
import { OpenAI } from "../ui/icons";
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
  branch,
  autoFocus,
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
  branch: string | undefined;
  autoFocus?: boolean;
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
  return (
    <ComposerSurface.Shell contextStrip>
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
                        >
                          {modelsLoading ? (
                            <div className="px-2 py-1.5 text-sm text-muted-foreground">
                              Loading models…
                            </div>
                          ) : null}
                          {settings.model &&
                          !selectedModel &&
                          !modelsLoading &&
                          !modelsError ? (
                            <div className="px-2 py-1.5 text-sm text-error-foreground">
                              Selected model is unavailable. Choose another
                              model.
                            </div>
                          ) : null}
                          {modelsError ? (
                            <div className="px-2 py-1.5 text-sm text-error-foreground">
                              {modelsError}
                            </div>
                          ) : null}
                          {modelsError ? (
                            <MenuItem onClick={onRetryModels}>Retry</MenuItem>
                          ) : null}
                          {!modelsLoading && !models.length ? (
                            <div className="px-2 py-1.5 text-sm text-muted-foreground">
                              Use Codex default
                            </div>
                          ) : null}
                          {!modelsLoading && !modelsError ? (
                            <MenuItem onClick={onRetryModels}>
                              Reload models
                            </MenuItem>
                          ) : null}
                          {models.map((model) => (
                            <MenuItem
                              key={model.model}
                              disabled={settingsDisabled}
                              title={model.description}
                              role="menuitemradio"
                              aria-checked={
                                settings.model === model.model ||
                                (settings.model === null && model.isDefault)
                              }
                              onClick={() =>
                                onSettingsChange({
                                  ...settings,
                                  model: model.isDefault ? null : model.model,
                                  effort:
                                    settings.effort &&
                                    model.supportedReasoningEfforts.some(
                                      (option) =>
                                        option.reasoningEffort ===
                                        settings.effort,
                                    )
                                      ? settings.effort
                                      : null,
                                })
                              }
                            >
                              <span className="flex-1 truncate">
                                {model.displayName}
                              </span>
                              {settings.model === model.model ||
                              (settings.model === null && model.isDefault) ? (
                                <span aria-hidden="true">✓</span>
                              ) : null}
                            </MenuItem>
                          ))}
                        </Menu>
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
                          {selectedModel?.supportedReasoningEfforts.map(
                            (option) => (
                              <MenuItem
                                key={option.reasoningEffort}
                                disabled={settingsDisabled}
                                title={option.description}
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
                                <span className="flex-1 capitalize">
                                  {effortLabel(option.reasoningEffort)}
                                </span>
                                {effort === option.reasoningEffort ? (
                                  <span aria-hidden="true">✓</span>
                                ) : null}
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
                              <mode.icon className="size-4" />
                              <span className="flex-1">{mode.label}</span>
                              {settings.permissionMode === mode.value ? (
                                <span aria-hidden="true">✓</span>
                              ) : null}
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
      <div className="min-h-0">
        <div className="relative z-0">
          <div className="pointer-events-auto">
            <ComposerSurface.ContextStrip className="gap-1 text-xs font-normal text-muted-foreground/70">
              <div className="min-h-7 min-w-10 items-center gap-1 sm:min-h-6 flex flex-1">
                <span className={contextControl}>
                  <FolderIcon className="size-3 shrink-0" />
                  <span className="min-w-0 max-w-[240px] truncate">
                    Local checkout
                  </span>
                </span>
              </div>
              {branch ? (
                <div className="flex min-w-0 items-center gap-1 min-w-0 flex-initial justify-end ml-auto">
                  <span className={cn(contextControl, "max-w-full")}>
                    <GitBranchIcon className="size-3 shrink-0 opacity-70" />
                    <span className="min-w-0 max-w-[240px] truncate">
                      {branch}
                    </span>
                  </span>
                </div>
              ) : null}
            </ComposerSurface.ContextStrip>
          </div>
        </div>
      </div>
    </ComposerSurface.Shell>
  );
}
