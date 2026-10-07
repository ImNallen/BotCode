// Ported from T3 Code v0.0.45 components/chat/ChatComposer.tsx, ComposerControl.tsx, ComposerPrimaryActions.tsx, BranchToolbar.tsx, BranchToolbarEnvModeSelector.tsx, TraitsPicker.tsx and ui/badge.tsx (MIT).
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ChevronDownIcon,
  BotIcon,
  PencilRulerIcon,
  FolderGit2Icon,
  FolderGitIcon,
  FolderIcon,
  LockIcon,
  LockOpenIcon,
  PenLineIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { ipc } from "../ipc";
import {
  contextReference,
  pullRequestReference,
  truncateContextText,
  type ComposerContextRecord,
} from "./composerContext";
import { Menu, MenuItem } from "../ui/menu";
import type {
  Checkout,
  CheckoutRef,
  ContextUsage,
  ModelOption,
  Skill,
  SessionSettings,
} from "../ipc";
import { cn } from "../lib/cn";
import { checkoutModeLabels, type CheckoutMode } from "../settings/preferences";
import { Button, selectItem, selectTrigger } from "../ui/controls";
import { OpenAI } from "../ui/icons";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { ModelPicker } from "./ModelPicker";
import { ComposerSurface } from "./ComposerSurface";
import { shouldHandleComposerAttachmentPaste } from "./composerAttachmentFiles";
import { attachmentUrl, type ComposerImage } from "./composerImages";
import { makeWorkspaceFileDropHandlers } from "./workspaceFileDrop";
import {
  ComposerPromptEditor,
  type ComposerEditorHandle,
  type ComposerSnapshot,
} from "./ComposerPromptEditor";
import {
  ComposerCommandMenu,
  composerSuggestionOptionId,
  type ComposerCommandItem,
} from "./ComposerCommandMenu";
import { detectComposerTrigger, pathBasename } from "./composer-logic";
import {
  searchSlashCommandItems,
  skillCommandItems,
} from "./composerSlashCommandSearch";
import { useProjectSearch } from "../lib/projectSearch";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

const composerControl =
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-(--control-radius) border border-transparent text-base outline-none hover:bg-accent data-pressed:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 data-disabled:pointer-events-none data-disabled:opacity-64 pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 [&:active:not([aria-haspopup])]:scale-[0.97] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:-mx-0.5 [&_svg[data-composer-control-icon]]:mx-0 h-7 gap-1.5 px-2.5 font-medium text-secondary-label [&_svg:not([class*='text-'])]:text-muted-foreground hover:text-foreground sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 aria-pressed:bg-accent aria-pressed:text-accent-foreground aria-pressed:hover:bg-accent/80";

const contextControl =
  "inline-flex h-7 min-w-0 items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6";

export function Composer({
  value,
  records,
  pullRequestScope,
  onChange,
  images,
  onAddImages,
  onRemoveImage,
  onSubmit,
  onStop,
  canSend,
  running,
  canStop,
  stopping,
  followUpBehavior,
  placeholder,
  approval,
  notice,
  contextUsage,
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
  searchCheckout,
  filesError,
  skills,
  skillsLoading,
  onSkillsMenuOpen,
  planSupported,
  showPlanFollowUp,
  onImplementInNewThread,
  onUsageLimits,
}: {
  value: string;
  records: ComposerContextRecord[];
  pullRequestScope?: { workspaceId: string; threadId: string | undefined };
  onChange: (value: string, records?: ComposerContextRecord[]) => void;
  images: ComposerImage[];
  onAddImages: (files: File[]) => void;
  onRemoveImage: (key: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  canSend: boolean;
  running: boolean;
  canStop: boolean;
  stopping: boolean;
  followUpBehavior: "queue" | "steer";
  placeholder: string;
  approval: ReactNode;
  notice: ReactNode;
  contextUsage: ContextUsage | null;
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
  searchCheckout: CheckoutRef | undefined;
  filesError?: string;
  skills: Skill[];
  skillsLoading: boolean;
  onSkillsMenuOpen: () => void;
  planSupported: boolean;
  showPlanFollowUp: boolean;
  onImplementInNewThread: () => void;
  onUsageLimits: () => void;
}) {
  const editor = useRef<ComposerEditorHandle>(null);
  const listId = useId();
  const [selection, setSelection] = useState<ComposerSnapshot>({
    value,
    start: value.length,
    end: value.length,
    composing: false,
  });
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const detected =
    selection.value === value &&
    selection.start === selection.end &&
    !selection.composing
      ? detectComposerTrigger(value, selection.end)
      : null;
  const triggerKey = detected ? JSON.stringify(detected) : null;
  const trigger =
    !disabled && detected && dismissed !== triggerKey ? detected : null;
  const prQuery = trigger?.kind === "pull-request" ? trigger.query : "";
  const [debouncedPrQuery, setDebouncedPrQuery] = useState("");
  useEffect(() => {
    if (!prQuery) {
      setDebouncedPrQuery("");
      return;
    }
    const timer = setTimeout(() => setDebouncedPrQuery(prQuery), 180);
    return () => clearTimeout(timer);
  }, [prQuery]);
  const prSearch = useQuery({
    queryKey: [
      "composer-prs",
      pullRequestScope?.workspaceId,
      pullRequestScope?.threadId,
      debouncedPrQuery,
    ],
    queryFn: () =>
      pullRequestScope
        ? ipc.composerPullRequests(
            pullRequestScope.workspaceId,
            pullRequestScope.threadId,
            debouncedPrQuery,
          )
        : Promise.resolve([]),
    enabled: Boolean(pullRequestScope && trigger?.kind === "pull-request"),
    staleTime: 30_000,
    retry: false,
  });
  const fileSearch = useProjectSearch(
    searchCheckout,
    trigger?.kind === "path"
      ? { kind: "paths", query: trigger.query, limit: 50 }
      : null,
  );
  const pathResult =
    fileSearch.response?.kind === "paths" ? fileSearch.response.value : null;
  const pathItems: ComposerCommandItem[] = (pathResult?.paths ?? []).map(
    (path) => ({
      id: `path:${path}`,
      type: "path",
      path,
      label: pathBasename(path),
      description: path,
    }),
  );
  const items =
    trigger?.kind === "path"
      ? pathItems
      : trigger?.kind === "skill"
        ? skillCommandItems(skills, trigger.query)
        : trigger?.kind === "pull-request"
          ? prQuery === debouncedPrQuery
            ? (prSearch.data ?? []).slice(0, 12).map((pullRequest) => ({
                id: `pr:${pullRequest.url}`,
                type: "pull-request" as const,
                pullRequest,
                label: `#${pullRequest.number}`,
                description: pullRequest.title,
              }))
            : []
          : trigger
            ? searchSlashCommandItems(trigger.query, planSupported, skills)
            : [];
  const skillMenuOpen =
    trigger?.kind === "skill" || trigger?.kind === "slash-command";
  useEffect(() => {
    if (skillMenuOpen) onSkillsMenuOpen();
  }, [skillMenuOpen, onSkillsMenuOpen]);
  const active = items.find((item) => item.id === highlighted) ?? items[0];
  const selectSuggestion = (item: ComposerCommandItem) => {
    if (item.type === "path" && !pathResult?.paths.includes(item.path)) return;
    if (
      item.type === "skill" &&
      !skills.some(
        (skill) =>
          skill.name === item.skill.name &&
          skill.path === item.skill.path &&
          skill.enabled,
      )
    )
      return;
    if (
      !trigger ||
      (item.type === "slash-command" &&
        item.command !== "usage-limits" &&
        settingsDisabled)
    )
      return;
    const snapshot = editor.current?.readSnapshot();
    if (
      !snapshot ||
      snapshot.value !== value ||
      snapshot.start !== trigger.rangeEnd ||
      snapshot.start !== snapshot.end
    )
      return;
    const record: ComposerContextRecord | null =
      item.type === "pull-request"
        ? pullRequestReference(item.pullRequest)
        : item.type === "skill"
          ? {
              version: 1,
              contextId: crypto.randomUUID(),
              kind: "skill",
              label: truncateContextText(item.skill.name, 200),
              name: item.skill.name,
            }
          : item.type === "path"
            ? {
                version: 1,
                contextId: crypto.randomUUID(),
                kind: "mention",
                label: truncateContextText(item.label, 200),
                path: item.path,
              }
            : null;
    if (record && records.length >= 200) return;
    const changed = editor.current?.replaceRange({
      start: trigger.rangeStart,
      end: trigger.rangeEnd,
      expectedText: value.slice(trigger.rangeStart, trigger.rangeEnd),
      replacement: record ? `${contextReference(record)} ` : "",
      records: record ? [record] : [],
    });
    if (!changed) return;
    setHighlighted(null);
    if (item.type === "slash-command") {
      if (item.command === "model") setModelPickerOpen(true);
      else if (item.command === "usage-limits") onUsageLimits();
      else
        onSettingsChange({
          ...settings,
          interactionMode: item.command === "plan" ? "plan" : "default",
        });
    }
  };
  const keys = (event: KeyboardEvent) => {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey)
      return false;
    if (trigger && !event.shiftKey) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissed(triggerKey);
        return true;
      }
      if (
        items.length &&
        (event.key === "ArrowDown" || event.key === "ArrowUp")
      ) {
        event.preventDefault();
        const index = items.findIndex((item) => item === active);
        const next =
          items[
            (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
              items.length
          ];
        if (next) setHighlighted(next.id);
        return true;
      }
      if (active && (event.key === "Enter" || event.key === "Tab")) {
        event.preventDefault();
        selectSuggestion(active);
        return true;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
      return true;
    }
    return false;
  };
  useLayoutEffect(() => {
    if (focusRequest) editor.current?.focus();
  }, [focusRequest]);
  const approvalState = approval !== null;
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  // A cancelled drag can end without a dragleave on the hovered target.
  useEffect(() => {
    if (!isDragOverComposer) return;
    const onWindowDragEnd = () => setIsDragOverComposer(false);
    window.addEventListener("dragend", onWindowDragEnd);
    return () => window.removeEventListener("dragend", onWindowDragEnd);
  }, [isDragOverComposer]);
  const fileDrop = makeWorkspaceFileDropHandlers({
    setDragActive: (active) => setIsDragOverComposer(active && !disabled),
    addFiles: (files) => {
      if (!disabled) onAddImages(files);
    },
  });
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
            {notice}
            {approval}
            {trigger ? (
              <ComposerCommandMenu
                listId={listId}
                items={items}
                triggerKind={trigger.kind}
                isLoading={
                  trigger.kind === "path"
                    ? fileSearch.pending
                    : trigger.kind === "pull-request"
                      ? Boolean(pullRequestScope) &&
                        (prSearch.isFetching || prQuery !== debouncedPrQuery)
                      : skillsLoading
                }
                emptyStateText={
                  trigger.kind === "path"
                    ? (fileSearch.error ?? filesError)
                    : trigger.kind === "pull-request"
                      ? !pullRequestScope
                        ? "Pull requests require a project."
                        : prSearch.error?.message
                      : undefined
                }
                statusText={
                  trigger.kind === "path" &&
                  pathResult?.indexCoverage.kind === "limited"
                    ? pathResult.indexCoverage.reason
                    : undefined
                }
                activeItemId={active?.id ?? null}
                onHighlightedItemChange={setHighlighted}
                onSelect={selectSuggestion}
              />
            ) : null}
            <div className="relative">
              <ComposerSurface.Main>
                <div
                  data-chat-composer-surface="true"
                  className={cn(
                    "rounded-3xl transition-[background-color] duration-200",
                    isDragOverComposer
                      ? "bg-accent/45 ring-1 ring-primary/70"
                      : null,
                  )}
                  onDragEnter={fileDrop.onDragEnter}
                  onDragOver={fileDrop.onDragOver}
                  onDragLeave={fileDrop.onDragLeave}
                  onDrop={fileDrop.onDrop}
                >
                  <div
                    data-chat-composer-body="true"
                    className={cn(
                      "relative px-3 pb-2 sm:px-4",
                      "pt-3.5 sm:pt-4",
                      approvalState && "pb-3 sm:pb-4",
                    )}
                  >
                    {images.length > 0 ? (
                      <div className="mb-3 flex max-w-full gap-2 flex-wrap">
                        {images.map((image) => (
                          <div
                            key={image.key}
                            data-chat-composer-expanded-image="true"
                            className="group/attachment shrink-0 snap-start bg-background relative h-16 w-16 overflow-hidden rounded-lg border border-border/80"
                          >
                            {image.status === "ready" ? (
                              <img
                                src={attachmentUrl(image.attachment)}
                                alt={image.name}
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center px-1 text-center text-3xs text-secondary-label">
                                {image.name}
                              </div>
                            )}
                            <span className="absolute right-1 top-1 flex">
                              <Button
                                variant="media-close"
                                size="icon-xs"
                                onClick={() => onRemoveImage(image.key)}
                                aria-label={`Remove ${image.name}`}
                              >
                                <XIcon />
                              </Button>
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    <div className="relative">
                      <div className="relative flow-root font-(family-name:--font-composer,var(--font-sans)) text-(length:--font-size-prompt,var(--text-sm))">
                        <ComposerPromptEditor
                          ref={editor}
                          value={value}
                          records={records}
                          skills={skills}
                          onChange={onChange}
                          onSelectionChange={(next) => {
                            setSelection(next);
                            if (
                              next.value !== selection.value ||
                              next.start !== selection.start ||
                              next.end !== selection.end ||
                              next.composing !== selection.composing
                            )
                              setHighlighted(null);
                            if (
                              JSON.stringify(
                                detectComposerTrigger(next.value, next.end),
                              ) !== dismissed
                            )
                              setDismissed(null);
                          }}
                          onKeyDown={keys}
                          onPasteFiles={(event) => {
                            const files = Array.from(
                              event.clipboardData?.files ?? [],
                            );
                            if (
                              files.length &&
                              shouldHandleComposerAttachmentPaste({
                                files,
                                plainText:
                                  event.clipboardData?.getData("text/plain") ??
                                  "",
                              })
                            ) {
                              event.preventDefault();
                              event.stopPropagation();
                              onAddImages(files);
                              return true;
                            }
                            return false;
                          }}
                          disabled={disabled}
                          autoFocus={autoFocus}
                          placeholder={placeholder}
                          approvalState={approvalState}
                          suggestionListId={trigger ? listId : undefined}
                          activeSuggestionId={
                            trigger && active
                              ? composerSuggestionOptionId(listId, active.id)
                              : undefined
                          }
                        />
                      </div>
                    </div>
                  </div>
                  {
                    <div
                      data-chat-composer-footer="true"
                      className="flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-3 pb-3 sm:px-4 sm:pb-4 sm:gap-0"
                    >
                      <div
                        data-chat-composer-controls="left"
                        className="relative -m-1 -ms-3.5 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 ps-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                      >
                        <ModelPicker
                          open={modelPickerOpen}
                          onOpenChange={(open) => {
                            setModelPickerOpen(open);
                            if (!open)
                              requestAnimationFrame(() =>
                                editor.current?.focus(),
                              );
                          }}
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
                        {planSupported ? (
                          <button
                            type="button"
                            disabled={settingsDisabled}
                            className={cn(
                              composerControl,
                              "shrink-0 whitespace-nowrap",
                            )}
                            aria-pressed={settings.interactionMode === "plan"}
                            aria-label={
                              settings.interactionMode === "plan"
                                ? "Plan mode, click to return to normal build mode"
                                : "Default mode, click to enter plan mode"
                            }
                            onClick={() =>
                              onSettingsChange({
                                ...settings,
                                interactionMode:
                                  settings.interactionMode === "plan"
                                    ? "default"
                                    : "plan",
                              })
                            }
                          >
                            {settings.interactionMode === "plan" ? (
                              <PencilRulerIcon />
                            ) : (
                              <BotIcon />
                            )}
                            <span
                              data-composer-control-label
                              className="sr-only sm:not-sr-only"
                            >
                              {settings.interactionMode === "plan"
                                ? "Plan"
                                : "Build"}
                            </span>
                          </button>
                        ) : null}
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
                        {contextUsage ? (
                          <ContextWindowMeter
                            usage={contextUsage}
                            modelDisplayName={
                              selectedModel?.displayName ??
                              settings.model ??
                              null
                            }
                          />
                        ) : null}
                        <ComposerPrimaryActions
                          running={running}
                          canStop={canStop}
                          stopping={stopping}
                          canSend={canSend}
                          followUpBehavior={followUpBehavior}
                          showPlanFollowUp={showPlanFollowUp}
                          promptHasText={Boolean(value.trim())}
                          onStop={onStop}
                          onImplementInNewThread={onImplementInNewThread}
                        />
                      </div>
                    </div>
                  }
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
