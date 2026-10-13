// Ported from T3 Code v0.0.45 components/chat/ChatComposer.tsx, ComposerControl.tsx, ComposerPrimaryActions.tsx, BranchToolbar.tsx, BranchToolbarEnvironmentSelector.tsx, BranchToolbarEnvModeSelector.tsx, TraitsPicker.tsx and ui/badge.tsx (MIT).
import type { SandboxState, Thread } from "../ipc";
import { sandboxLabel } from "../lib/sandbox";
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
  ContainerIcon,
  FolderIcon,
  LaptopIcon,
  XIcon,
  FileIcon,
  PaperclipIcon,
  PlayIcon,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { isMacPlatform } from "../lib/utils";
import { resolveCommand, useShortcutLabel } from "../lib/shortcuts";
import { isTerminalFocused } from "../terminal/terminalKeys";
import { ComposerStashBadge } from "./ComposerStashBadge";
import { ComposerStashMenu } from "./ComposerStashMenu";
import { composerTasks } from "./taskProgress";
import {
  ComposerTasksBadge,
  ComposerTasksContent,
  ComposerTasksDrawer,
} from "./ComposerTasksBadge";
import { ComposerBanner } from "./ComposerBanner";
import type { PromptStashEntry } from "./promptStash";
import {
  buildComposerPromptHistoryEntries,
  stepComposerPromptHistory,
  type ComposerPromptHistoryMessage,
  type ComposerPromptHistoryPosition,
} from "./composerPromptHistory";
import {
  isPasteAsTextShortcut,
  pastedTextDisposition,
  nextPastedTextFileName,
  replaceTextSelection,
} from "./textPaste";
import { MAX_FILE_BYTES } from "./composerAttachmentIngestion";
import { ipc, native } from "../ipc";
import {
  contextReference,
  pullRequestReference,
  truncateContextText,
  type ComposerContextRecord,
} from "./composerContext";
import { Menu, MenuItem } from "../ui/menu";
import type {
  Attachment,
  AttachmentSource,
  Checkout,
  CheckoutRef,
  RegisteredWorktree,
  ContextUsage,
  ModelOption,
  PermissionModeOption,
  Skill,
  SessionSettings,
} from "../ipc";
import { cn } from "../lib/cn";
import {
  checkoutModeLabels,
  usePreferences,
  type CheckoutMode,
} from "../settings/preferences";
import { Button, selectItem, selectTrigger } from "../ui/controls";
import { OpenAI } from "../ui/icons";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { ModelPicker } from "./ModelPicker";
import {
  EffortMenu,
  composerControl,
  selectedModelOption,
} from "./ModelSelectionControls";
import { ComposerSurface } from "./ComposerSurface";
import {
  placementLabels,
  type Placement,
  type SandboxOption,
} from "./draftCheckout";
import { shouldHandleComposerAttachmentPaste } from "./composerAttachmentFiles";
import {
  attachmentIdentity,
  attachmentMediaKind,
  attachmentUrl,
  type ComposerAttachment,
} from "./composerAttachments";
import {
  buildExpandedImagePreview,
  type ExpandedImagePreview,
} from "./ExpandedImagePreview";
import { prepareVideoFirstFrame } from "../lib/videoFirstFrame";
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
import {
  composerEnterIntent,
  detectComposerTrigger,
  pathBasename,
  type ComposerEnterIntent,
} from "./composer-logic";
import {
  searchSlashCommandItems,
  skillCommandItems,
} from "./composerSlashCommandSearch";
import { compactSlashCommandAvailable } from "./contextCompaction";
import { useProjectSearch } from "../lib/projectSearch";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { PermissionModeOptions, permissionModeIcons } from "./permissionModes";
import {
  COMPOSER_SCROLL_COLLAPSE_THRESHOLD_PX,
  COMPOSER_SCROLL_GESTURE_RESET_MS,
  canScrollCollapseComposer,
  createComposerScrollGestureState,
  getRestingComposerImagePreviewCounts,
  isTimelineScrollTarget,
  recordComposerScrollGestureEvent,
  resetComposerScrollGesture,
  shouldUseRestingComposerLayout,
  suppressActiveComposerScrollGesture,
  useComposerMultilinePrompt,
} from "./composerResting";

const contextControl =
  "inline-flex h-7 min-w-0 items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6";

export function Composer({
  scopeKey,
  activation,
  dropRequest,
  historyMessages,
  stashEntries,
  stashOpen,
  stashPulse,
  onStash,
  onToggleStash,
  onCloseStash,
  onRestoreStash,
  onDeleteStash,
  onAttachmentNotice,
  value,
  records,
  pullRequestScope,
  onChange,
  attachments,
  onAddAttachments,
  onRemoveAttachment,
  onExpandImage,
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
  taskTurn,
  contextUsage,
  disabled,
  context,
  autoFocus,
  focusRequest,
  settings,
  permissionModes,
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
  compactDisabledReason,
  onCompactContext,
  existingThread,
  onRestingChange,
}: {
  scopeKey: string;
  activation: number;
  dropRequest?: { id: string; scopeKey: string; files: File[] };
  historyMessages: ComposerPromptHistoryMessage[];
  stashEntries: PromptStashEntry[];
  stashOpen: boolean;
  stashPulse: number;
  onStash: () => void;
  onToggleStash: () => void;
  onCloseStash: () => void;
  onRestoreStash: (entry: PromptStashEntry) => void;
  onDeleteStash: (entry: PromptStashEntry) => void;
  onAttachmentNotice: (message: string) => void;
  value: string;
  records: ComposerContextRecord[];
  pullRequestScope?: { workspaceId: string; threadId: string | undefined };
  onChange: (value: string, records?: ComposerContextRecord[]) => void;
  attachments: ComposerAttachment[];
  onAddAttachments: (
    files: File[],
    source?: AttachmentSource,
  ) => Promise<Attachment[]>;
  onRemoveAttachment: (key: string) => void;
  onExpandImage: (preview: ExpandedImagePreview) => void;
  onSubmit: (intent: Exclude<ComposerEnterIntent, "newline">) => void;
  onStop: () => void;
  canSend: boolean;
  running: boolean;
  canStop: boolean;
  stopping: boolean;
  followUpBehavior: "queue" | "steer";
  placeholder: string;
  approval: ReactNode;
  notice: ReactNode;
  taskTurn: Thread["turns"][number] | undefined;
  contextUsage: ContextUsage | null;
  disabled: boolean;
  context?: {
    checkout:
      | Checkout
      | {
          kind: "draft";
          placement: Placement;
          sandbox: SandboxOption;
          onSandboxMenuOpen: () => void;
          onPlacementChange: (placement: Placement) => void;
          mode: CheckoutMode;
          onChange: (mode: CheckoutMode) => void;
          worktrees: RegisteredWorktree[];
          worktreesLoading: boolean;
          worktreesError: string | undefined;
          onSelectWorktree: (path: string) => void;
        }
      | undefined;
    sandboxState?: SandboxState;
    branch: ReactNode;
  };
  autoFocus?: boolean;
  focusRequest?: number;
  settings: SessionSettings;
  permissionModes: PermissionModeOption[];
  models: ModelOption[];
  modelsLoading: boolean;
  modelsError?: string;
  onRetryModels: () => void;
  onSettingsChange: (
    settings: SessionSettings,
    options?: { permissionModeSelected: boolean },
  ) => void;
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
  compactDisabledReason: string | null;
  onCompactContext: () => void;
  existingThread: boolean;
  onRestingChange: (resting: boolean) => void;
}) {
  const { preferences } = usePreferences();
  const editor = useRef<ComposerEditorHandle>(null);
  const composerElement = useRef<HTMLFormElement>(null);
  const stashShortcutLabel = useShortcutLabel("composer.stash");
  const listId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const historyPosition = useRef<ComposerPromptHistoryPosition | null>(null);
  const pasteAsTextUntil = useRef(0);
  const scope = useRef(`${activation}:${scopeKey}`);
  scope.current = `${activation}:${scopeKey}`;
  const [pulsing, setPulsing] = useState(false);
  const [scrollCollapsed, setScrollCollapsed] = useState(false);
  useEffect(() => {
    historyPosition.current = null;
    onCloseStash();
    pasteAsTextUntil.current = 0;
    setScrollCollapsed(false);
  }, [scopeKey, activation]);
  useEffect(() => {
    if (historyPosition.current?.recalled !== value)
      historyPosition.current = null;
  }, [value]);
  useEffect(() => {
    if (!stashPulse) return;
    setPulsing(true);
    const timer = setTimeout(() => setPulsing(false), 700);
    return () => clearTimeout(timer);
  }, [stashPulse]);

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
            ? searchSlashCommandItems(
                trigger.query,
                planSupported,
                skills,
                compactSlashCommandAvailable({
                  prompt: value,
                  trigger,
                  attachmentCount: attachments.length,
                  contextCount: records.length,
                  disabledReason: compactDisabledReason,
                }),
              )
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
    // T3 inserts a provider command such as /compact for the user to send.
    const command =
      item.type === "slash-command" && item.command === "compact"
        ? "/compact "
        : null;
    const end =
      command && value[trigger.rangeEnd] === " "
        ? trigger.rangeEnd + 1
        : trigger.rangeEnd;
    const changed = editor.current?.replaceRange({
      start: trigger.rangeStart,
      end,
      expectedText: value.slice(trigger.rangeStart, end),
      replacement: record ? `${contextReference(record)} ` : (command ?? ""),
      records: record ? [record] : [],
    });
    if (!changed) return;
    setHighlighted(null);
    if (item.type === "slash-command") {
      if (item.command === "model") setModelPickerOpen(true);
      else if (item.command === "usage-limits") onUsageLimits();
      else if (item.command !== "compact")
        onSettingsChange({
          ...settings,
          interactionMode: item.command === "plan" ? "plan" : "default",
        });
    }
  };
  const attachFiles = (
    files: File[],
    source?: AttachmentSource,
    pastedText?: string,
    fallbackInline = true,
  ) => {
    const captured = editor.current?.readSnapshot();
    const target = scope.current;
    void onAddAttachments(files, source).then((prepared) => {
      if (
        target !== scope.current ||
        !captured ||
        editor.current?.readSnapshot().value !== captured.value
      )
        return;
      const references = prepared.flatMap((attachment) =>
        attachment.kind === "file"
          ? [
              {
                kind: "file" as const,
                version: 1 as const,
                contextId: `ctx_${crypto.randomUUID().replaceAll("-", "")}`,
                label: truncateContextText(attachment.name, 200),
                attachmentId: attachment.id,
                name: attachment.name,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
              },
            ]
          : [],
      );
      if ((editor.current?.readRecords().length ?? 0) + references.length > 200)
        return;
      if (!references.length) {
        if (pastedText && fallbackInline)
          editor.current?.replaceRange({
            start: captured.start,
            end: captured.end,
            expectedText: captured.value.slice(captured.start, captured.end),
            replacement: pastedText,
          });
        return;
      }
      editor.current?.replaceRange({
        start: captured.start,
        end: captured.end,
        expectedText: captured.value.slice(captured.start, captured.end),
        replacement: `${references.map(contextReference).join(" ")} `,
        records: references,
      });
      if (pastedText && prepared[0])
        onAttachmentNotice(
          `Large paste attached as ${prepared[0].name}\n${formatAttachmentSize(prepared[0].sizeBytes)} · Use ${isMacPlatform(navigator.platform) ? "⌘⇧V" : "Ctrl+Shift+V"} to keep a large paste inline.`,
        );
    });
  };
  const consumedDrop = useRef<string | null>(null);
  useEffect(() => {
    if (
      !dropRequest ||
      dropRequest.scopeKey !== scopeKey ||
      consumedDrop.current === dropRequest.id ||
      disabled
    )
      return;
    consumedDrop.current = dropRequest.id;
    editor.current?.focus();
    attachFiles(dropRequest.files);
  }, [dropRequest, scopeKey, disabled]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        (event.target instanceof Element &&
          event.target.closest("[data-keybinding-capture]")) ||
        composerElement.current?.closest("[inert]")
      )
        return;
      if (
        isPasteAsTextShortcut(event, isMacPlatform(navigator.platform)) &&
        !event.isComposing &&
        !disabled &&
        editor.current?.containsFocus()
      ) {
        if (native) {
          event.preventDefault();
          event.stopPropagation();
          const captured = editor.current.readSnapshot();
          const target = scope.current;
          void ipc.clipboardText().then(
            (text) => {
              if (
                text === null ||
                target !== scope.current ||
                !editor.current?.containsFocus() ||
                editor.current.readSnapshot().value !== captured.value
              )
                return;
              editor.current.replaceRange({
                start: captured.start,
                end: captured.end,
                expectedText: captured.value.slice(
                  captured.start,
                  captured.end,
                ),
                replacement: text,
              });
            },
            (cause: unknown) => {
              if (target === scope.current)
                onAttachmentNotice(
                  `Could not paste clipboard text\n${cause instanceof Error ? cause.message : String(cause)}`,
                );
            },
          );
        } else pasteAsTextUntil.current = Date.now() + 1000;
      }
      const command = resolveCommand(event);
      if (isTerminalFocused() || !command) return;
      if (document.querySelector("dialog[open], [data-command-palette]"))
        return;
      if (command === "modelPicker.toggle") {
        if (settingsDisabled) return;
        flushSync(() => setScrollCollapsed(false));
        setModelPickerOpen((open) => !open);
      } else if (command === "thread.stop") {
        if (!canStop || stopping) return;
        onStop();
      } else if (command === "composer.stash") {
        if (disabled || approval !== null) return;
        onStash();
      } else if (
        [
          "composer.effort",
          "composer.mode",
          "composer.workspace",
          "composer.branch",
        ].includes(command)
      ) {
        flushSync(() => setScrollCollapsed(false));
        const button = document.querySelector<HTMLButtonElement>(
          `[data-composer-shortcut="${command}"]`,
        );
        if (!button || button.disabled) return;
        button.click();
      } else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [
    onStash,
    disabled,
    approval,
    onAttachmentNotice,
    settingsDisabled,
    canStop,
    stopping,
    onStop,
  ]);
  const keys = (event: KeyboardEvent) => {
    if (event.isComposing || event.altKey) return false;
    const modifierKey = event.metaKey || event.ctrlKey;
    if (
      trigger &&
      active &&
      modifierKey &&
      !event.shiftKey &&
      event.key === "Enter"
    ) {
      event.preventDefault();
      selectSuggestion(active);
      return true;
    }
    if (modifierKey) return enter(event, true);
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
    if (
      !event.shiftKey &&
      !trigger &&
      !approvalState &&
      !disabled &&
      !attachments.length &&
      !records.length &&
      (event.key === "ArrowUp" || event.key === "ArrowDown") &&
      (historyPosition.current || !value)
    ) {
      const direction = event.key === "ArrowUp" ? "backward" : "forward";
      if (
        editor.current?.isCaretOnVisualEdge(
          direction === "backward" ? "start" : "end",
        )
      ) {
        const step = stepComposerPromptHistory({
          direction,
          entries: buildComposerPromptHistoryEntries(historyMessages),
          position: historyPosition.current,
          currentPrompt: value,
        });
        if (step) {
          event.preventDefault();
          event.stopPropagation();
          historyPosition.current = step.position;
          onChange(step.prompt, []);
          return true;
        }
      }
    }
    return enter(event, false);
  };
  const enter = (event: KeyboardEvent, modifierKey: boolean) => {
    if (event.key !== "Enter") return false;
    const intent = composerEnterIntent({
      shiftKey: event.shiftKey,
      modifierKey,
      running,
      sendShortcut: preferences.sendShortcut,
      prompt: value,
    });
    if (intent === "newline") return false;
    event.preventDefault();
    onSubmit(intent);
    return true;
  };
  useLayoutEffect(() => {
    if (focusRequest) editor.current?.focus();
  }, [focusRequest]);
  const approvalState = approval !== null;
  useEffect(() => {
    if (trigger || value !== selection.value) onCloseStash();
  }, [triggerKey, value]);
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  // A cancelled drag can end without a dragleave on the hovered target.
  useEffect(() => {
    if (!isDragOverComposer) return;
    const onWindowDragEnd = () => setIsDragOverComposer(false);
    window.addEventListener("dragend", onWindowDragEnd);
    return () => window.removeEventListener("dragend", onWindowDragEnd);
  }, [isDragOverComposer]);
  // The chat column around the composer adds the dropped files.
  const fileDrop = makeWorkspaceFileDropHandlers({
    disabled,
    setDragActive: setIsDragOverComposer,
  });
  const expand = (attachment: Attachment) => {
    const preview = buildExpandedImagePreview(
      attachments.flatMap((slot) =>
        slot.status === "ready" ? [slot.attachment] : [],
      ),
      attachmentIdentity(attachment),
    );
    if (preview) onExpandImage(preview);
  };
  const selectedModel = selectedModelOption(models, settings.model);
  const tasks = approval ? null : composerTasks(taskTurn);
  const [tasksExpanded, setTasksExpanded] = useState(false);
  useEffect(() => {
    setTasksExpanded(false);
  }, [tasks === null, taskTurn?.id]);
  const toggleTasks = () => setTasksExpanded((open) => !open);
  const selectedMode = permissionModes.find(
    (mode) => mode.value === settings.permissionMode,
  );
  const RuntimeIcon = permissionModeIcons[settings.permissionMode];
  const checkout = context?.checkout;
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const wrappedPrompt = useComposerMultilinePrompt(body);
  const hasMultilinePrompt = value.includes("\n") || wrappedPrompt;
  const hasExpandedChrome =
    approval !== null ||
    stashOpen ||
    tasksExpanded ||
    trigger !== null ||
    isDragOverComposer ||
    attachments.some((slot) => slot.status === "staging");
  const canCollapse = canScrollCollapseComposer({
    isExistingThread: existingThread,
    collapseOnScroll: preferences.composerCollapseOnScroll,
    hasMultilinePrompt,
    hasExpandedChrome,
    showsInlineTasksBadge:
      tasks !== null && !tasksExpanded && Boolean(stashOpen || notice),
  });
  const [timelineOverflows, setTimelineOverflows] = useState(false);
  const resting = shouldUseRestingComposerLayout({
    isExistingThread: existingThread,
    isScrollCollapsed: scrollCollapsed,
    hasExpandedChrome,
    hasMultilinePrompt,
    timelineOverflows,
  });
  const collapseEligible = useRef(false);
  collapseEligible.current = canCollapse && !resting;
  useEffect(() => {
    if (!canCollapse) setScrollCollapsed(false);
  }, [canCollapse]);
  useLayoutEffect(() => {
    onRestingChange(resting);
  }, [resting, onRestingChange]);
  const scrollGesture = useRef(createComposerScrollGestureState());
  const windowRefocus = useRef(false);
  useEffect(() => {
    if (!scrollCollapsed) return;
    let frame: number | null = null;
    const onWindowFocus = () => {
      windowRefocus.current = true;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        windowRefocus.current = false;
      });
    };
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener("focus", onWindowFocus);
      if (frame !== null) cancelAnimationFrame(frame);
      windowRefocus.current = false;
    };
  }, [scrollCollapsed]);
  useEffect(() => {
    if (!existingThread) return;
    // The timeline mounts after the thread loads, so find it per event.
    const timeline = () =>
      document.querySelector<HTMLElement>("[data-chat-timeline-scroller]");
    const atEnd = (scroller: HTMLElement) =>
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 2;
    const measure = (scroller: HTMLElement) =>
      setTimelineOverflows(scroller.scrollHeight > scroller.clientHeight + 1);
    let intent: "toward-end" | "away-from-end" | null = null;
    let resetTimer: number | null = null;
    const finishGesture = () => {
      if (resetTimer !== null) clearTimeout(resetTimer);
      resetTimer = null;
      resetComposerScrollGesture(scrollGesture.current);
    };
    const onWheel = (event: WheelEvent) => {
      const scroller = timeline();
      if (event.ctrlKey || !scroller || !(event.target instanceof Element))
        return;
      measure(scroller);
      const targetsTimeline = isTimelineScrollTarget(
        event.target,
        scroller,
        event.deltaY,
      );
      if (targetsTimeline) {
        intent = event.deltaY > 0 ? "toward-end" : "away-from-end";
        if (event.deltaY > 0 && atEnd(scroller)) setScrollCollapsed(false);
      }
      if (
        !scroller.contains(event.target) &&
        !scrollGesture.current.collapseSuppressed
      )
        return;
      if (resetTimer !== null) clearTimeout(resetTimer);
      resetTimer = window.setTimeout(
        finishGesture,
        COMPOSER_SCROLL_GESTURE_RESET_MS,
      );
      const canScrollInGestureDirection =
        targetsTimeline &&
        (event.deltaY < 0
          ? scroller.scrollTop > 0
          : scroller.scrollTop < scroller.scrollHeight - scroller.clientHeight);
      const deltaPx =
        Math.abs(event.deltaY) *
        (event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? scroller.clientHeight
            : 1);
      if (
        recordComposerScrollGestureEvent(scrollGesture.current, {
          now: performance.now(),
          deltaPx,
          collapseThresholdPx: COMPOSER_SCROLL_COLLAPSE_THRESHOLD_PX,
          collapseEligible: targetsTimeline && collapseEligible.current,
          canScrollInGestureDirection,
          scrollsTowardLogicalEnd: event.deltaY > 0 && atEnd(scroller),
        })
      )
        setScrollCollapsed(true);
    };
    // Reaching the end lifts a scroll collapse, unless the last gesture was
    // reading upward. Any pointer interaction, such as Scroll to end, counts.
    const onPointerDown = () => {
      intent = null;
    };
    const onScroll = (event: Event) => {
      const scroller = timeline();
      if (!scroller || event.target !== scroller) return;
      measure(scroller);
      if (atEnd(scroller) && intent !== "away-from-end")
        setScrollCollapsed(false);
    };
    document.addEventListener("wheel", onWheel, {
      capture: true,
      passive: true,
    });
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", onScroll, {
      capture: true,
      passive: true,
    });
    return () => {
      document.removeEventListener("wheel", onWheel, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", onScroll, true);
      finishGesture();
    };
  }, [existingThread, scopeKey]);
  const expandForEditorChange = () => {
    // Editor changes win over the momentum tail of the active scroll gesture.
    suppressActiveComposerScrollGesture(
      scrollGesture.current,
      performance.now(),
      COMPOSER_SCROLL_GESTURE_RESET_MS,
    );
    setScrollCollapsed(false);
  };
  const readyImages = attachments.flatMap((slot) =>
    slot.status === "ready" && slot.attachment.kind === "image" ? [slot] : [],
  );
  const restingImageCounts = getRestingComposerImagePreviewCounts(
    readyImages.length,
  );
  return (
    <ComposerSurface.Shell contextStrip={context !== undefined}>
      <ComposerSurface.Host>
        <div className="relative z-10">
          <form
            ref={composerElement}
            className="mx-auto w-full min-w-0 max-w-(--chat-max-width)"
            data-chat-composer-form="true"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit("send");
            }}
            onPointerDownCapture={(event) => {
              const target = event.target;
              if (
                !(target instanceof Element) ||
                target.closest(
                  'button, a, input, select, [role="button"], [role="menuitem"]',
                )
              )
                return;
              setScrollCollapsed(false);
              if (
                resting &&
                !target.closest('[data-testid="composer-editor"]')
              ) {
                // Clicking resting-surface padding would otherwise blur the editor.
                event.preventDefault();
                requestAnimationFrame(() => editor.current?.focus());
              }
            }}
            onFocusCapture={() => {
              // Focus returning from another window lands on the element that
              // already held it, which is not a request to expand.
              if (!windowRefocus.current) setScrollCollapsed(false);
            }}
          >
            <ComposerBanner.Dock>
              <ComposerBanner.Column>
                {stashOpen ? (
                  <ComposerBanner.Attachment>
                    <ComposerStashMenu
                      entries={stashEntries}
                      stashShortcutLabel={stashShortcutLabel ?? null}
                      onRestore={onRestoreStash}
                      onDelete={onDeleteStash}
                      onClose={onCloseStash}
                    />
                  </ComposerBanner.Attachment>
                ) : null}
                {tasks ? (
                  tasksExpanded ? (
                    <ComposerTasksDrawer
                      progress={tasks.progress}
                      steps={tasks.steps}
                      onCollapse={toggleTasks}
                    />
                  ) : stashOpen || notice ? (
                    <ComposerBanner.Attachment>
                      <ComposerBanner.Root>
                        <ComposerTasksContent
                          expanded={false}
                          onToggle={toggleTasks}
                          progress={tasks.progress}
                          steps={tasks.steps}
                        />
                      </ComposerBanner.Root>
                    </ComposerBanner.Attachment>
                  ) : (
                    <ComposerBanner.Attachment>
                      <ComposerTasksBadge
                        expanded={false}
                        onToggle={toggleTasks}
                        progress={tasks.progress}
                        steps={tasks.steps}
                      />
                    </ComposerBanner.Attachment>
                  )
                ) : null}
              </ComposerBanner.Column>
              <ComposerStashBadge
                count={stashEntries.length}
                menuOpen={stashOpen}
                pulseKey={stashPulse}
                pulsing={pulsing}
                onToggleMenu={onToggleStash}
              />
            </ComposerBanner.Dock>
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
                    ref={setBody}
                    data-chat-composer-body="true"
                    className={cn(
                      "relative px-3 pb-2 sm:px-4",
                      "pt-3.5 sm:pt-4",
                      approvalState && "pb-3 sm:pb-4",
                      resting && "py-2 sm:py-2",
                    )}
                  >
                    {attachments.some(
                      (slot) =>
                        slot.status === "staging" ||
                        (attachmentMediaKind(slot.attachment) !== null &&
                          !(resting && slot.attachment.kind === "image")),
                    ) ? (
                      <div className="mb-3 flex max-w-full gap-2 flex-wrap">
                        {attachments
                          .filter(
                            (slot) =>
                              slot.status === "staging" ||
                              (slot.attachment.kind === "image" && !resting),
                          )
                          .map((image) => (
                            <div
                              key={image.key}
                              data-chat-composer-expanded-image="true"
                              className="group/attachment shrink-0 snap-start bg-background relative h-16 w-16 overflow-hidden rounded-lg border border-border/80"
                            >
                              {image.status === "ready" ? (
                                <button
                                  type="button"
                                  className="h-full w-full cursor-zoom-in"
                                  aria-label={`Preview ${image.name}`}
                                  onClick={() => expand(image.attachment)}
                                >
                                  <img
                                    src={attachmentUrl(image.attachment)}
                                    alt={image.name}
                                    className="h-full w-full object-cover"
                                  />
                                </button>
                              ) : (
                                <div className="flex h-full w-full items-center justify-center px-1 text-center text-3xs text-secondary-label">
                                  {image.name}
                                </div>
                              )}
                              <span className="absolute right-1 top-1 flex">
                                <Button
                                  variant="media-close"
                                  size="icon-xs"
                                  onClick={() => onRemoveAttachment(image.key)}
                                  aria-label={`Remove ${image.name}`}
                                >
                                  <XIcon />
                                </Button>
                              </span>
                            </div>
                          ))}
                        {attachments.map((slot) =>
                          slot.status === "ready" &&
                          attachmentMediaKind(slot.attachment) === "video" ? (
                            <div
                              key={slot.key}
                              className="relative h-16 w-16 shrink-0 snap-start overflow-hidden rounded-lg border border-border/80 bg-black"
                            >
                              <button
                                type="button"
                                className="flex h-full w-full cursor-zoom-in flex-col items-center justify-center gap-1 px-1 text-white"
                                aria-label={`Play ${slot.name}`}
                                onClick={() => expand(slot.attachment)}
                              >
                                <video
                                  src={attachmentUrl(slot.attachment)}
                                  muted
                                  playsInline
                                  preload="metadata"
                                  aria-hidden="true"
                                  onLoadedMetadata={(event) =>
                                    prepareVideoFirstFrame(event.currentTarget)
                                  }
                                  className="pointer-events-none absolute inset-0 size-full object-cover"
                                />
                                <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-black/10" />
                                <PlayIcon className="relative z-10 size-4 fill-current drop-shadow-md" />
                              </button>
                              <Button
                                variant="media-close"
                                size="icon-xs"
                                className="absolute right-1 top-1"
                                onClick={() => onRemoveAttachment(slot.key)}
                                aria-label={`Remove ${slot.name}`}
                              >
                                <XIcon />
                              </Button>
                            </div>
                          ) : null,
                        )}
                      </div>
                    ) : null}
                    <div className="mb-3 flex flex-col gap-1 empty:hidden">
                      {attachments
                        .filter(
                          (slot) =>
                            slot.status === "ready" &&
                            slot.attachment.kind === "file" &&
                            attachmentMediaKind(slot.attachment) === null &&
                            !records.some(
                              (record) =>
                                record.kind === "file" &&
                                record.attachmentId === slot.attachment.id &&
                                record.name === slot.attachment.name,
                            ),
                        )
                        .map((slot) =>
                          slot.status === "ready" ? (
                            <div
                              key={slot.key}
                              className="flex min-w-0 items-center gap-2 py-1 text-sm text-foreground"
                            >
                              <FileIcon className="size-4 shrink-0" />
                              <span className="min-w-0 flex-1 truncate text-left">
                                {slot.name}
                              </span>
                              <span className="shrink-0 text-xs text-secondary-label">
                                {formatAttachmentSize(
                                  slot.attachment.sizeBytes,
                                )}
                              </span>
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                onClick={() => onRemoveAttachment(slot.key)}
                                aria-label={`Remove ${slot.name}`}
                              >
                                <XIcon />
                              </Button>
                            </div>
                          ) : null,
                        )}
                    </div>
                    <div
                      className={cn(
                        "relative",
                        resting && "flex min-w-0 items-center gap-1",
                        resting && (contextUsage ? "pr-28" : "pr-20"),
                      )}
                    >
                      <div
                        className={cn(
                          "relative flow-root font-(family-name:--font-composer,var(--font-sans)) text-(length:--font-size-prompt,var(--text-sm))",
                          resting && "min-w-0 flex-1",
                        )}
                      >
                        <ComposerPromptEditor
                          ref={editor}
                          richText={preferences.composerRichTextEnabled}
                          className={cn(
                            resting &&
                              "my-0 max-h-8 min-h-8 overflow-hidden py-0 whitespace-pre! leading-8",
                          )}
                          placeholderClassName={cn(
                            resting &&
                              "flex items-center overflow-hidden whitespace-nowrap leading-8",
                          )}
                          value={value}
                          records={records}
                          skills={skills}
                          onChange={(next, nextRecords) => {
                            expandForEditorChange();
                            onChange(next, nextRecords);
                          }}
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
                          onBlur={() => {
                            pasteAsTextUntil.current = 0;
                          }}
                          onPasteFiles={(event, structured) => {
                            const bypass =
                              pasteAsTextUntil.current > Date.now();
                            pasteAsTextUntil.current = 0;
                            if (structured) return false;
                            const files = Array.from(
                              event.clipboardData?.files ?? [],
                            );
                            const text =
                              event.clipboardData?.getData("text/plain") ?? "";
                            if (
                              files.length &&
                              shouldHandleComposerAttachmentPaste({
                                files,
                                plainText: text,
                              })
                            ) {
                              event.preventDefault();
                              event.stopPropagation();
                              attachFiles(files);
                              return true;
                            }
                            const captured = editor.current?.readSnapshot();
                            if (!captured) return false;
                            const bytes = new TextEncoder().encode(
                              text,
                            ).byteLength;
                            const exceeds =
                              new TextEncoder().encode(
                                replaceTextSelection({
                                  value: captured.value,
                                  selection: captured,
                                  text,
                                }).value,
                              ).byteLength > 100_000;
                            const disposition = pastedTextDisposition({
                              text,
                              canAttach:
                                attachments.length < 100 &&
                                records.length < 200,
                              bypassAutoAttachment: bypass,
                              wouldExceedInputLimit: exceeds,
                            });
                            if (disposition === "inline") {
                              if (!exceeds || bypass) return false;
                              event.preventDefault();
                              onAttachmentNotice(
                                "Pasted text is too large for this message\nRemove some text or an attachment, then paste again.",
                              );
                              return true;
                            }
                            if (bytes > MAX_FILE_BYTES) {
                              if (!exceeds) return false;
                              event.preventDefault();
                              onAttachmentNotice(
                                "Pasted text is too large to attach\nReduce the clipboard contents or save a smaller excerpt as a file.",
                              );
                              return true;
                            }
                            event.preventDefault();
                            event.stopPropagation();
                            const name = nextPastedTextFileName(
                              attachments.map((slot) => slot.name),
                            );
                            attachFiles(
                              [
                                new File([text], name, {
                                  type: "text/plain;charset=utf-8",
                                }),
                              ],
                              { _tag: "pasted-text" },
                              text,
                              !exceeds,
                            );
                            return true;
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
                      {resting && readyImages.length > 0 ? (
                        <div
                          data-chat-composer-resting-images="true"
                          className="flex shrink-0 items-center gap-1 ps-1"
                        >
                          {readyImages
                            .slice(0, restingImageCounts.visibleCount)
                            .map((image) => (
                              <button
                                key={image.key}
                                type="button"
                                className="relative size-7 shrink-0 cursor-zoom-in overflow-hidden rounded-md border border-border/70 bg-muted/60"
                                aria-label={`Preview ${image.name}`}
                                onPointerDown={(event) =>
                                  event.preventDefault()
                                }
                                onClick={() => expand(image.attachment)}
                              >
                                <img
                                  src={attachmentUrl(image.attachment)}
                                  alt=""
                                  className="size-full object-cover"
                                />
                              </button>
                            ))}
                          {restingImageCounts.overflowCount > 0 ? (
                            <button
                              type="button"
                              className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border/70 bg-muted/60 font-medium text-secondary-label text-xs tabular-nums outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                              aria-label={`Show ${String(restingImageCounts.overflowCount)} more image attachments`}
                              onPointerDown={(event) => event.preventDefault()}
                              onClick={() => {
                                setScrollCollapsed(false);
                                editor.current?.focus();
                              }}
                            >
                              +{restingImageCounts.overflowCount}
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  {
                    <div
                      data-chat-composer-footer="true"
                      className={cn(
                        "flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-3 pb-3 sm:px-4 sm:pb-4 sm:gap-0",
                        resting &&
                          "absolute bottom-px right-px z-10 h-12 w-auto gap-0 py-0 sm:gap-0 sm:py-0",
                      )}
                    >
                      <div
                        data-chat-composer-controls="left"
                        className={cn(
                          "relative -m-1 -ms-3.5 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 ps-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
                          resting && "hidden",
                        )}
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
                          selection={settings}
                          loading={modelsLoading}
                          error={modelsError}
                          disabled={settingsDisabled}
                          onRetry={onRetryModels}
                          onChange={(selection) =>
                            onSettingsChange({ ...settings, ...selection })
                          }
                          trigger={(props) => (
                            <button
                              type="button"
                              ref={props.ref}
                              onClick={props.onClick}
                              aria-haspopup={props["aria-haspopup"]}
                              aria-expanded={props["aria-expanded"]}
                              disabled={settingsDisabled}
                              aria-label={`Model: ${selectedModel?.displayName ?? settings.model ?? "Codex default"}`}
                              data-model-picker-open={modelPickerOpen}
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
                        <EffortMenu
                          model={selectedModel}
                          effort={settings.effort}
                          disabled={settingsDisabled}
                          shortcut
                          onSelect={(effort) =>
                            onSettingsChange({ ...settings, effort })
                          }
                        />
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
                              disabled={
                                settingsDisabled || permissionModes.length === 0
                              }
                              title={selectedMode?.description}
                              aria-label={`Access mode: ${selectedMode?.label ?? settings.permissionMode}`}
                              data-composer-shortcut="composer.mode"
                              className={composerControl}
                            >
                              <RuntimeIcon
                                aria-hidden="true"
                                className="shrink-0 size-4"
                                data-composer-control-icon
                              />
                              <span data-composer-control-label>
                                {selectedMode?.label ?? settings.permissionMode}
                              </span>
                              <ChevronDownIcon className="size-3.5 text-icon-muted" />
                            </button>
                          )}
                        >
                          <PermissionModeOptions
                            options={permissionModes}
                            selected={settings.permissionMode}
                            disabled={settingsDisabled}
                            presentation="composer"
                            onSelect={(permissionMode) =>
                              onSettingsChange(
                                { ...settings, permissionMode },
                                { permissionModeSelected: true },
                              )
                            }
                          />
                        </Menu>
                      </div>
                      <div
                        data-chat-composer-actions="right"
                        className="flex shrink-0 flex-nowrap items-center justify-end gap-2"
                      >
                        {contextUsage ? (
                          <ContextWindowMeter
                            usage={contextUsage}
                            onCompact={onCompactContext}
                            compactDisabled={compactDisabledReason !== null}
                            compactDisabledReason={compactDisabledReason}
                            modelDisplayName={
                              selectedModel?.displayName ??
                              settings.model ??
                              null
                            }
                          />
                        ) : null}
                        <input
                          ref={fileInput}
                          type="file"
                          multiple
                          className="hidden"
                          onChange={(event) => {
                            const files = Array.from(
                              event.currentTarget.files ?? [],
                            );
                            event.currentTarget.value = "";
                            if (files.length) attachFiles(files);
                          }}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Attach files"
                          title="Attach files"
                          disabled={disabled}
                          onClick={() => fileInput.current?.click()}
                        >
                          <PaperclipIcon />
                        </Button>
                        <ComposerPrimaryActions
                          compact={resting}
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
                    <PlacementMenu
                      placement={checkout.placement}
                      sandbox={checkout.sandbox}
                      disabled={settingsDisabled}
                      onOpen={checkout.onSandboxMenuOpen}
                      onChange={checkout.onPlacementChange}
                    />
                  ) : null}
                  {checkout?.kind === "draft" &&
                  checkout.placement === "mac" ? (
                    <Menu
                      side="top"
                      trigger={(props) => (
                        <button
                          type="button"
                          {...props}
                          disabled={settingsDisabled}
                          aria-label="Workspace"
                          data-composer-shortcut="composer.workspace"
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
                      {checkout.worktrees.length ? (
                        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
                          Existing worktrees
                        </div>
                      ) : null}
                      {checkout.worktrees.map((worktree) => (
                        <MenuItem
                          key={worktree.path}
                          className={selectItem}
                          disabled={Boolean(worktree.unavailable)}
                          title={worktree.unavailable ?? worktree.path}
                          onClick={() =>
                            checkout.onSelectWorktree(worktree.path)
                          }
                        >
                          <FolderGitIcon className="mt-1 size-3.5 shrink-0 self-start" />
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate">
                              {worktree.branch ?? "Detached HEAD"}
                            </span>
                            <span className="truncate text-xs text-muted-foreground">
                              {worktree.path}
                            </span>
                            {worktree.unavailable ? (
                              <span className="text-xs text-muted-foreground">
                                {worktree.unavailable}
                              </span>
                            ) : null}
                          </span>
                        </MenuItem>
                      ))}
                      {checkout.worktreesLoading ? (
                        <div className="px-2 py-1.5 text-xs text-muted-foreground">
                          Loading worktrees...
                        </div>
                      ) : null}
                      {checkout.worktreesError ? (
                        <div className="px-2 py-1.5 text-xs text-muted-foreground">
                          {checkout.worktreesError}
                        </div>
                      ) : null}
                    </Menu>
                  ) : checkout && checkout.kind !== "draft" ? (
                    <span
                      className={contextControl}
                      title={
                        checkout.kind === "worktree" ? checkout.path : undefined
                      }
                    >
                      <FixedCheckoutLabel
                        checkout={checkout}
                        sandboxState={context.sandboxState}
                      />
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

function FixedCheckoutLabel({
  checkout,
  sandboxState,
}: {
  checkout: Checkout;
  sandboxState: SandboxState | undefined;
}) {
  const [Icon, label] =
    checkout.kind !== "worktree"
      ? [FolderIcon, "Local checkout"]
      : checkout.sandbox
        ? [ContainerIcon, sandboxLabel(sandboxState)]
        : [FolderGitIcon, "Worktree"];
  return (
    <>
      <Icon className="size-3 shrink-0" />
      <span className="min-w-0 max-w-[240px] truncate">{label}</span>
    </>
  );
}

function PlacementIcon({ placement }: { placement: Placement }) {
  return placement === "sandbox" ? (
    <ContainerIcon className="size-3" />
  ) : (
    <LaptopIcon className="size-3" />
  );
}

function PlacementMenu({
  placement,
  sandbox,
  disabled,
  onOpen,
  onChange,
}: {
  placement: Placement;
  sandbox: SandboxOption;
  disabled: boolean;
  onOpen: () => void;
  onChange: (placement: Placement) => void;
}) {
  const sandboxDetail =
    sandbox.kind === "checking"
      ? "Checking Docker…"
      : sandbox.kind === "unavailable"
        ? sandbox.reason
        : sandbox.note;
  return (
    <>
      <Menu
        side="top"
        onOpenChange={(open) => {
          if (open) onOpen();
        }}
        trigger={(props) => (
          <button
            type="button"
            {...props}
            disabled={disabled}
            aria-label="Run on"
            title={
              placement === "sandbox" ? (sandboxDetail ?? undefined) : undefined
            }
            className={selectTrigger({
              variant: "ghost",
              size: "xs",
              className: "min-w-0 shrink",
            })}
          >
            <PlacementIcon placement={placement} />
            <span className="min-w-0 max-w-[240px] truncate">
              {placementLabels[placement]}
            </span>
            <ChevronDownIcon aria-hidden className="-me-1 size-3 opacity-50" />
          </button>
        )}
      >
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
          Run on
        </div>
        {(["mac", "sandbox"] as const).map((option) => {
          const unavailable = option === "sandbox" && sandbox.kind !== "ready";
          const detail = option === "sandbox" ? sandboxDetail : null;
          return (
            <MenuItem
              key={option}
              role="menuitemradio"
              aria-checked={placement === option}
              data-selected={placement === option ? "" : undefined}
              disabled={unavailable}
              className={selectItem}
              onClick={() => onChange(option)}
            >
              <span className="flex min-w-0 flex-col">
                <span className="inline-flex items-center gap-1.5 [&_svg:not([class*='text-'])]:text-muted-foreground">
                  <PlacementIcon placement={option} />
                  {placementLabels[option]}
                </span>
                {detail ? (
                  <span className="max-w-64 text-xs text-muted-foreground">
                    {detail}
                  </span>
                ) : null}
              </span>
            </MenuItem>
          );
        })}
      </Menu>
      {placement === "mac" ? (
        <span aria-hidden className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />
      ) : null}
    </>
  );
}

function CheckoutModeIcon({ mode }: { mode: CheckoutMode }) {
  return mode === "worktree" ? (
    <FolderGit2Icon className="size-3" />
  ) : (
    <FolderIcon className="size-3" />
  );
}

function formatAttachmentSize(bytes: number): string {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
