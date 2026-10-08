// Ported from T3 Code v0.0.45 apps/web/src/components/ChatView.tsx, chat/ChatHeader.tsx, chat/PanelLayoutControls.tsx and DraftHeroHeadline.tsx at 6b286ae8a (MIT).
import { Toast, ToastViewport, type ToastType } from "../ui/toast";
import { Dialog } from "../ui/dialog";
import { ProjectFilePicker } from "../search/ProjectFilePicker";
import { ProjectContentSearchDialog } from "../search/ProjectContentSearchDialog";
import type { ChatRequest } from "../lib/actions";
import { ErrorView } from "../errors/ErrorView";
import { RenderErrorBoundary } from "../errors/RenderErrorBoundary";
import {
  type ComponentProps,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Maximize2Icon,
  Minimize2Icon,
  PanelBottomIcon,
  PanelRightIcon,
} from "lucide-react";
import {
  checkoutKey,
  invalidateCheckouts,
  ipc,
  native,
  readThreadSnapshot,
  setThreadSnapshot,
  workspaceTarget,
} from "../ipc";
import type {
  ApprovalDecision,
  CheckoutRef,
  Attachment,
  AttachmentSource,
  Thread,
  Workspace,
  SessionSettings,
  UserQuestionAnswers,
} from "../ipc";
import { cn } from "../lib/cn";
import { workingSessions } from "../lib/sessions";
import { useShortcutLabel } from "../lib/shortcuts";
import {
  type CheckoutMode,
  projectSetting,
  usePreferences,
} from "../settings/preferences";
import { WorkspaceBadge } from "../ProjectBadge";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { Toggle } from "../ui/controls";
import {
  RightPanel,
  emptyPanel,
  type PanelState,
  type Surface,
} from "../panel/RightPanel";
import {
  closeFiles,
  openFile,
  openSurface,
  pullRequestSurface,
  reconcileTerminalSurfaces,
} from "../panel/panelState";
import type { ThreadPrSummary } from "../panel/pullRequests";
import {
  appendReviewDraft,
  canAcceptReviewDraft,
  type ReviewDraftRequest,
  type ReviewDraftTarget,
} from "../panel/reviews";
import { FileLinkProvider, type FileLinks } from "./ChatMarkdown";
import { parseChatFileLink } from "./chatFileLinks";
import { OpenInPicker } from "./OpenInPicker";
import { useFileContextMenu } from "../fileContextMenu";
import { GitActionsControl } from "./GitActionsControl";
import { ApprovalDrawer } from "./ApprovalDrawer";
import { BranchPicker, startsFromOrigin } from "./BranchPicker";
import { Composer } from "./Composer";
import {
  captureDraftSettings,
  draftSessionSettings,
  finishDraftSettings,
  newDraftSettings,
  useProviderCapabilities,
  type DraftSessionSettings,
} from "./permissionModes";
import { sidebarPendingFileDrops } from "./sidebarPendingFileDrops";
import {
  promptStash,
  composerHasContent,
  type PromptStashEntry,
} from "./promptStash";
import { threadPromptHistoryMessages } from "./composerPromptHistory";
import {
  reserveAttachments,
  prepareComposerFile,
  totalImageBytes,
  MAX_TOTAL_IMAGE_BYTES,
  IMAGE_TOTAL_ERROR,
} from "./composerAttachmentIngestion";
import {
  finishComposerStaging,
  readyAttachments,
  type SendAttempt,
  sendAttempt,
  activateComposer,
  acceptsCompletion,
  clearAcceptedInput,
  mergeRecoveredInput,
  recoveryFit,
  restoreFollowUps,
  type ComposerInput,
} from "./composerAttachments";
import { ComposerUsageLimits } from "./ComposerUsageLimits";
import { isUsageLimitsCommand, usageNoticeKey } from "../usage/limits";
import { Timeline } from "./Timeline";
import { followUps, immediateIntent } from "./followUps";
import { sendFollowUpNow } from "./FollowUpSender";
import { EditFromHereDialog } from "./EditFromHereDialog";
import { useTurnRevert } from "./useTurnRevert";
import { DraftHeadline } from "./DraftHeadline";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { useCheckoutSkills } from "./useCheckoutSkills";
import {
  resolvePlanFollowUpSubmission,
  buildPlanImplementationPrompt,
} from "./proposedPlan";
import { standaloneComposerCommand } from "./composerSlashCommandSearch";
import {
  selectedCheckpointTurn,
  type TurnDiffSelection,
} from "../panel/turnDiffSelection";
import {
  composerDraftKey,
  readComposerDraft,
  writeComposerDraft,
} from "./composerDrafts";
import {
  appendContext,
  contextReferences,
  referencedContext,
  type ComposerContextRecord,
} from "./composerContext";
import { ComposerContextProvider } from "./ComposerContextProvider";
import { PersistentThreadTerminalDrawer } from "../terminal/ThreadTerminalDrawer";
import {
  terminalScopeKey,
  toggleTerminalOpen,
} from "../terminal/terminalState";
import {
  updateTerminalState,
  useTerminalState,
} from "../terminal/terminalStore";

import { resolveThreadEnvMode } from "./projectScripts";
import { ProjectScriptsControl } from "./ProjectScriptsControl";
import type { ProjectScript } from "../ipc";
import { createPanelTerminal } from "../terminal/terminalStore";
import { previewIpc, subscribePreview } from "../preview/ipc";
import {
  acceptsPreviewEvent,
  previewScopeKey,
  scopeForPreview,
} from "../preview/model";
import { openProjectScriptPreview } from "../preview/projectScriptPreview";

type DraftCheckout = {
  mode: CheckoutMode;
  base: string | null;
  fromOrigin: boolean;
};

export function ChatView({
  workspaceId,
  threadId,
  prPanelRequest,
  commandRequest,
  workspaces,
  scratch,
  scratchAvailable,
  onSelectWorkspace,
  onStartScratch,
  onOpenRepository,
}: {
  workspaceId: string;
  threadId: string | undefined;
  commandRequest?: ChatRequest;
  prPanelRequest?: { threadId: string; surface: Surface; nonce: number };
  workspaces: Workspace[];
  scratch: Workspace | undefined;
  scratchAvailable: boolean;
  onSelectWorkspace: (workspaceId: string) => void;
  onStartScratch: () => void;
  onOpenRepository: () => void;
}) {
  const isScratch = scratch?.id === workspaceId;
  const client = useQueryClient();
  const terminalToggleShortcut = useShortcutLabel("terminal.toggle");
  const navigate = useNavigate({ from: "/" });
  const [panelOpen, setPanelOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [panel, setPanel] = useState<PanelState>(emptyPanel);
  const previewScope = scopeForPreview(workspaceId, threadId);
  const previewScopeRef = useRef(previewScope);
  previewScopeRef.current = previewScope;
  const previewActive = useRef(false);
  useEffect(() => {
    previewActive.current = true;
    if (!native)
      return () => {
        previewActive.current = false;
      };
    let disposed = false;
    let off: (() => void) | undefined;
    void subscribePreview((event) => {
      if (
        disposed ||
        !event.openPanel ||
        !acceptsPreviewEvent(previewScopeRef.current, event)
      )
        return;
      setPanel((current) => openSurface(current, { kind: "preview" }));
      setPanelOpen(true);
      setMaximized(false);
    }).then(
      (unsubscribe) => {
        if (disposed) unsubscribe();
        else off = unsubscribe;
      },
      (cause: unknown) => {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      disposed = true;
      previewActive.current = false;
      off?.();
    };
  }, []);
  const [turnSelection, setTurnSelection] = useState<TurnDiffSelection | null>(
    null,
  );
  useEffect(() => {
    if (prPanelRequest && prPanelRequest.threadId === threadId) {
      setPanel((current) => openSurface(current, prPanelRequest.surface));
      setPanelOpen(true);
    }
  }, [prPanelRequest, threadId]);
  const draftKey = composerDraftKey(workspaceId, threadId);
  const [composer, setComposer] = useState<ComposerInput>(() => ({
    ...activateComposer(threadId),
    ...readComposerDraft(draftKey),
    scopeKey: draftKey,
  }));
  if (composer.scopeKey !== draftKey)
    setComposer({
      ...activateComposer(threadId, composer.activation + 1),
      ...readComposerDraft(draftKey),
      scopeKey: draftKey,
    });
  const composerRef = useRef(composer);
  composerRef.current = composer;
  const updateComposer = (
    update: (current: ComposerInput) => ComposerInput,
  ) => {
    const next = update(composerRef.current);
    composerRef.current = next;
    setComposer(next);
  };
  const { text: draft, attachments: slots, records } = composer;
  useSyncExternalStore(
    followUps.subscribe,
    followUps.snapshot,
    followUps.snapshot,
  );
  const queued = threadId ? followUps.rows(threadId) : [];
  const setDraft = (
    update: string | ((text: string) => string),
    changedRecords?: ComposerContextRecord[],
  ) =>
    updateComposer((current) => ({
      ...current,
      text: typeof update === "function" ? update(current.text) : update,
      records: changedRecords ?? current.records,
      generation: current.generation + 1,
    }));
  const [dropRequest, setDropRequest] = useState<{
    id: string;
    scopeKey: string;
    files: File[];
  }>();
  const dropVersion = useSyncExternalStore(
    sidebarPendingFileDrops.subscribe,
    sidebarPendingFileDrops.snapshot,
    sidebarPendingFileDrops.snapshot,
  );
  const stashEntries = useSyncExternalStore(
    promptStash.subscribe,
    promptStash.snapshot,
    promptStash.snapshot,
  );
  const [stashOpen, setStashOpen] = useState(false);
  const [stashPulse, setStashPulse] = useState(0);
  const stashBusy = useRef(false);
  const restoreStash = async (entry: PromptStashEntry) => {
    if (stashBusy.current) return;
    const started = composerRef.current;
    stashBusy.current = true;
    try {
      if (
        await promptStash.restore(
          entry.id,
          started,
          () => composerRef.current,
          (input) => updateComposer(() => input),
        )
      ) {
        setStashOpen(false);
        setComposerFocusRequest((current) => current + 1);
      }
    } catch (cause) {
      if (acceptsCompletion(composerRef.current, started))
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      stashBusy.current = false;
    }
  };
  const stashPrompt = async () => {
    if (stashBusy.current) return;
    const started = composerRef.current;
    if (!composerHasContent(started)) {
      const entries = promptStash.snapshot();
      if (entries.length === 1 && entries[0]) await restoreStash(entries[0]);
      else setStashOpen((current) => !current);
      return;
    }
    stashBusy.current = true;
    try {
      const result = await promptStash.stash(started);
      if (!result) return;
      updateComposer((current) => clearAcceptedInput(current, started));
      if (acceptsCompletion(composerRef.current, started)) {
        setStashOpen(false);
        setStashPulse((current) => current + 1);
        setComposerFocusRequest((current) => current + 1);
        if (result.evicted)
          setAttachmentNotice({
            title: "Oldest stashed prompt discarded",
            description:
              "The stash holds 20 prompts; the oldest was removed to make room.",
            type: "warning",
          });
      }
    } catch (cause) {
      if (acceptsCompletion(composerRef.current, started))
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      stashBusy.current = false;
    }
  };
  const [attachmentNotice, setAttachmentNotice] = useState<{
    title: string;
    description: string;
    type: ToastType;
  }>();
  const lastAttempt = useRef<SendAttempt | null>(null);
  const [usageNotice, setUsageNotice] = useState<{
    key: string;
    now: number;
  } | null>(null);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const [createdDraft, setCreatedDraft] = useState<Thread>();
  const [draftSettings, setDraftSettings] =
    useState<DraftSessionSettings>(newDraftSettings);
  const { preferences } = usePreferences();
  const capabilities = useProviderCapabilities();
  const defaultPermissionMode = projectSetting(
    preferences,
    workspaceId,
    "defaultPermissionMode",
  ).value;
  const configQuery = useQuery({
    queryKey: ["project-config", workspaceId],
    queryFn: () => ipc.projectConfig(workspaceId),
    enabled: !isScratch,
    refetchInterval: 5000,
  });
  const checkoutPreference = projectSetting(
    preferences,
    workspaceId,
    "newThreadCheckout",
  );
  const newThreadCheckout = resolveThreadEnvMode({
    preference: checkoutPreference.value,
    configured: preferences.newThreadCheckoutConfigured,
    overridden: checkoutPreference.overridden,
    projectDefault: configQuery.data?.defaultThreadEnvMode,
  });
  const newWorktreesStartFromOrigin = projectSetting(
    preferences,
    workspaceId,
    "newWorktreesStartFromOrigin",
  ).value;
  const draftDefaults = (): DraftCheckout => ({
    mode: newThreadCheckout,
    base: null,
    fromOrigin: newWorktreesStartFromOrigin,
  });
  const [draftCheckout, setDraftCheckout] = useState(draftDefaults);
  useLayoutEffect(
    () => setDraftCheckout(draftDefaults()),
    [threadId, newThreadCheckout, newWorktreesStartFromOrigin],
  );
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!composer.scopeKey) return;
    void writeComposerDraft(composer.scopeKey, composer).catch(
      (error: unknown) => {
        if (composerRef.current.scopeKey === composer.scopeKey)
          setError(
            error instanceof Error
              ? error.message
              : "Unable to save composer draft.",
          );
      },
    );
  }, [composer]);
  const overlay = useRef<HTMLDivElement>(null);
  const [clearance, setClearance] = useState(0);
  useEffect(() => {
    const element = overlay.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setClearance(element.getBoundingClientRect().height),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setCreatedDraft(undefined);
  }, [threadId]);
  const query = useQuery({
    queryKey: ["thread", threadId],
    queryFn: () => readThreadSnapshot(client, threadId ?? ""),
    enabled: Boolean(threadId),
  });
  const thread = threadId ? query.data : undefined;
  const recovery =
    thread?.lastRevert && thread.turns.length === thread.lastRevert.turnCount
      ? thread.lastRevert
      : null;
  const recoveryNotice =
    recovery && composer.appliedRevertId !== recovery.requestId
      ? recoveryFit(slots, recovery, records)
      : null;
  useEffect(() => {
    updateComposer((current) => {
      if (current.threadId !== thread?.id) return current;
      if (recovery) return mergeRecoveredInput(current, recovery);
      return current.appliedRevertId === null
        ? current
        : { ...current, appliedRevertId: null };
    });
  }, [thread?.id, recovery, slots, records]);
  useEffect(() => {
    if (composer.appliedRevertId)
      setComposerFocusRequest((current) => current + 1);
  }, [composer.activation, composer.appliedRevertId]);
  const selectTurnDiff = (turnId: string | null, filePath?: string) => {
    setTurnSelection(
      turnId && threadId
        ? { threadId, turnId, filePath: filePath ?? null, request: Date.now() }
        : null,
    );
  };
  const openTurnDiff = (turnId: string, filePath?: string) => {
    selectTurnDiff(turnId, filePath);
    setPanel((current) => openSurface(current, { kind: "diff" }));
    setPanelOpen(true);
  };
  const checkout: CheckoutRef = {
    workspaceId,
    threadId:
      thread && thread.checkout.kind !== "local" ? thread.id : undefined,
  };
  const [panelCheckout, setPanelCheckout] = useState(checkout.threadId);
  if (panelCheckout !== checkout.threadId) {
    setPanelCheckout(checkout.threadId);
    setPanel(closeFiles);
  }
  const workspaceQuery = useQuery({
    queryKey: checkoutKey("workspace", checkout),
    queryFn: () => ipc.workspace(checkout),
  });
  const view = workspaceQuery.data;
  const skillsRoot =
    view && !view.unavailable && (!threadId || thread)
      ? view.workspace.root
      : undefined;
  const skills = useCheckoutSkills(skillsRoot);
  const checkoutOpenable = Boolean(
    view && !view.unavailable && (threadId ? thread : !isScratch),
  );
  const gitThread = !isScratch && !view?.unavailable ? thread : undefined;
  const fileContextMenu = useFileContextMenu();
  const pullRequests =
    view?.threads.find((row) => row.id === threadId)?.pullRequests.links ?? [];
  const { data: branches } = useQuery({
    queryKey: checkoutKey("branches", checkout),
    queryFn: () => ipc.branches(checkout),
    enabled: !isScratch,
  });
  const base =
    draftCheckout.base ??
    (
      branches?.branches.find((branch) => branch.default) ??
      branches?.branches.find((branch) => branch.current)
    )?.name ??
    null;
  const baseFromOrigin = startsFromOrigin(
    branches,
    base,
    draftCheckout.fromOrigin,
  );
  const settings =
    thread?.settings ??
    draftSessionSettings({
      draft: draftSettings,
      preferred: defaultPermissionMode,
      capabilities: capabilities.data,
    });
  const models = useQuery({
    queryKey: ["models"],
    queryFn: ipc.models,
    retry: false,
  });
  const collaborationModes = useQuery({
    queryKey: ["collaboration-modes"],
    queryFn: ipc.collaborationModes,
    retry: false,
  });
  const planSupported =
    collaborationModes.data?.includes("plan") === true &&
    collaborationModes.data.includes("default");
  const implementationTarget = useRef<{
    sourceId: string;
    text: string;
    target: string;
  } | null>(null);
  const saveSettings = useMutation({
    mutationFn: async (next: SessionSettings) => {
      if (!threadId) {
        setDraftSettings((current) => captureDraftSettings({ current, next }));
        return;
      }
      const snapshot = await ipc.settings(threadId, next);
      setThreadSnapshot(client, snapshot);
    },
    onError: (e) => setError(e.message),
  });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["thread", threadId] });
    void client.invalidateQueries({ queryKey: ["workspace"] });
    void client.invalidateQueries({ queryKey: ["file"] });
    void client.invalidateQueries({ queryKey: ["diff"] });
  };
  const sessionKind = thread?.session.kind;
  useEffect(() => {
    if (sessionKind === "ready") {
      void client.invalidateQueries({ queryKey: ["workspace"] });
      void client.invalidateQueries({ queryKey: ["file"] });
      void client.invalidateQueries({ queryKey: ["diff"] });
      void client.invalidateQueries({ queryKey: ["git"] });
    }
  }, [sessionKind, client]);
  const send = useMutation({
    mutationFn: async ({
      text,
      attachments,
      started,
      settings: submittedSettings,
      newThreadSource,
    }: {
      text: string;
      attachments: Attachment[];
      started: ComposerInput;
      settings: SessionSettings;
      newThreadSource?: Thread;
    }) => {
      let target = threadId ?? createdDraft?.id;
      if (newThreadSource) {
        const existing = implementationTarget.current;
        if (existing?.sourceId === newThreadSource.id && existing.text === text)
          target = existing.target;
        else {
          const created = await ipc.create(newThreadSource.workspaceId, {
            kind: "existing",
            threadId: newThreadSource.id,
          });
          target = created.id;
          implementationTarget.current = {
            sourceId: newThreadSource.id,
            text,
            target,
          };
          setThreadSnapshot(client, created);
        }
      }
      if (!target) {
        const created = await ipc.create(
          workspaceId,
          isScratch
            ? { kind: "folder", prompt: text }
            : draftCheckout.mode === "worktree"
              ? {
                  kind: "worktree",
                  base: base ?? "",
                  fromOrigin: baseFromOrigin,
                }
              : { kind: "local" },
        );
        setThreadSnapshot(client, created);
        target = created.id;
        if (acceptsCompletion(composerRef.current, started))
          setCreatedDraft(created);
        void client.invalidateQueries({ queryKey: ["workspace"] });
      }
      if (
        !threadId ||
        newThreadSource ||
        JSON.stringify(submittedSettings) !== JSON.stringify(thread?.settings)
      ) {
        const updated = await ipc.settings(target, submittedSettings);
        setThreadSnapshot(client, updated);
      }
      const attempt = sendAttempt(
        lastAttempt.current,
        target,
        text,
        attachments,
        () => crypto.randomUUID(),
        referencedContext(started),
      );
      if (acceptsCompletion(composerRef.current, started))
        lastAttempt.current = attempt;
      await ipc.submit(
        target,
        text,
        attempt.requestId,
        attachments,
        undefined,
        referencedContext({ text, records: started.records }),
      );
      return target;
    },
    onSuccess: (target, { started, newThreadSource }) => {
      void client.invalidateQueries({ queryKey: ["thread", target] });
      void client.invalidateQueries({ queryKey: ["workspace"] });
      if (!acceptsCompletion(composerRef.current, started)) return;
      const acceptedAsThread =
        !threadId &&
        !newThreadSource &&
        acceptsCompletion(composerRef.current, started, true);
      setDraftSettings((current) =>
        finishDraftSettings({ current, acceptedAsThread }),
      );
      lastAttempt.current = null;
      if (newThreadSource) implementationTarget.current = null;
      if (acceptsCompletion(composerRef.current, started, true))
        setCreatedDraft(undefined);
      updateComposer((current) => clearAcceptedInput(current, started));
      setError(undefined);
      if (
        (!threadId || newThreadSource) &&
        acceptsCompletion(composerRef.current, started, true)
      ) {
        void navigate({
          to: "/",
          search: (previous) => ({
            ...previous,
            workspace: workspaceId,
            thread: target,
          }),
        });
      }
    },
    onError: (e, { started, text, newThreadSource }) => {
      if (!acceptsCompletion(composerRef.current, started)) return;
      if (!newThreadSource && !started.text.trim() && text.trim())
        updateComposer((current) =>
          acceptsCompletion(current, started, true)
            ? { ...current, text, generation: current.generation + 1 }
            : current,
        );
      setError(e.message);
      refresh();
    },
  });
  const approve = useMutation({
    mutationFn: (input: { id: string; decision: ApprovalDecision }) =>
      ipc.approval(input.id, input.decision),
    onSuccess: refresh,
    onError: (e) => setError(e.message),
  });
  const answerQuestions = useMutation({
    mutationFn: ({
      requestId,
      answers,
    }: {
      requestId: string;
      answers: UserQuestionAnswers;
    }) => ipc.answerUserQuestions(requestId, answers),
    onSuccess: refresh,
    onError: (e) => setError(e.message),
  });
  const recoverQueue = (id?: string) => {
    if (!threadId) return;
    if (!id) followUps.hold(threadId);
    const rows = followUps
      .rows(threadId)
      .filter(
        (row) =>
          (!id || row.id === id) &&
          ["waiting", "held", "preparing"].includes(row.state.kind),
      );
    if (!rows.length) return;
    const recovered = restoreFollowUps(composerRef.current, rows);
    if (recovered.error) {
      setError(recovered.error);
      return;
    }
    updateComposer(() => recovered.input);
    for (const row of rows) followUps.remove(threadId, row.id);
    setComposerFocusRequest((current) => current + 1);
  };
  const stop = useMutation({
    mutationFn: () => ipc.interrupt(threadId ?? ""),
    onSuccess: refresh,
    onError: (e) => setError(e.message),
  });
  const resume = useMutation({
    mutationFn: () => ipc.resume(threadId ?? ""),
    onSuccess: (snapshot) => {
      setThreadSnapshot(client, snapshot);
      setError(undefined);
    },
    onError: (e) => setError(e.message),
  });
  const {
    revert,
    preflightError,
    reverting,
    visibleEditTarget,
    startRevert,
    openEdit,
    closeEdit,
  } = useTurnRevert({
    workspaceId,
    threadId,
    thread,
    composer,
    onReverted: () => {
      setTurnSelection(null);
      setPanel(closeFiles);
      setMaximized(false);
      setError(undefined);
    },
  });
  const workspace = view?.workspace;
  const checkoutWorkspace = checkout.workspaceId;
  const checkoutThread = checkout.threadId;
  const fileLinks = useMemo<FileLinks>(() => {
    const files = new Set(view?.files ?? []);
    const root = view?.workspace.root;
    return {
      resolve: (target, source) =>
        parseChatFileLink(target, {
          files,
          root,
          source,
          threadId,
        }),
      openInPanel: (path) => {
        setPanelOpen(true);
        setPanel((current) => openFile(current, path));
      },
      target: (link) =>
        link.kind === "external"
          ? { kind: "chat_link", thread_id: link.threadId, path: link.path }
          : workspaceTarget(
              { workspaceId: checkoutWorkspace, threadId: checkoutThread },
              link.path,
            ),
      absolutePath: (link) =>
        link.kind === "external" || !root ? link.path : `${root}/${link.path}`,
    };
  }, [view, threadId, checkoutWorkspace, checkoutThread]);
  const terminalAvailable = !(isScratch && !threadId);
  const terminalScope = terminalScopeKey(workspaceId, threadId ?? null);
  const terminalState = useTerminalState(terminalScope);
  const terminalOpen = terminalState.terminalOpen;
  const runScript = (script: ProjectScript) => {
    const capturedScope = previewScopeRef.current;
    const surfaceId = createPanelTerminal(terminalScope);
    setPanelOpen(true);
    setMaximized(false);
    setPanel((current) =>
      openSurface(current, { kind: "terminal", id: surfaceId }),
    );
    void ipc
      .runProjectScript(
        workspaceId,
        threadId ?? null,
        script.id,
        surfaceId.slice("terminal:".length),
      )
      .then(() =>
        openProjectScriptPreview({
          script,
          scope: capturedScope,
          currentScope: () =>
            previewActive.current ? previewScopeRef.current : null,
          open: previewIpc.open,
        }),
      )
      .catch((error: unknown) => {
        if (
          previewActive.current &&
          previewScopeKey(capturedScope) ===
            previewScopeKey(previewScopeRef.current)
        )
          setError(error instanceof Error ? error.message : String(error));
      });
  };
  const [searchDialog, setSearchDialog] = useState<
    "filePicker.toggle" | "projectSearch.toggle" | null
  >(null);
  const searchFocus = useRef<HTMLElement | null>(null);
  const closeSearch = () => {
    setSearchDialog(null);
    requestAnimationFrame(() => {
      if (document.querySelector("dialog[open][data-project-search]")) return;
      const previous = searchFocus.current;
      searchFocus.current = null;
      if (
        previous?.isConnected &&
        previous.getBoundingClientRect().width > 0 &&
        !previous.matches(":disabled")
      )
        previous.focus({ preventScroll: true });
      else setComposerFocusRequest((value) => value + 1);
    });
  };
  useEffect(() => {
    setSearchDialog(null);
  }, [workspaceId, threadId, checkout.threadId]);
  const consumedCommand = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!commandRequest || consumedCommand.current === commandRequest.sequence)
      return;
    consumedCommand.current = commandRequest.sequence;
    if (
      commandRequest.workspaceId !== workspaceId ||
      commandRequest.threadId !== threadId
    )
      return;
    if (commandRequest.kind === "rightPanel.toggle") {
      setPanelOpen((value) => !value);
      setMaximized(false);
    } else if (
      commandRequest.kind === "filePicker.toggle" ||
      commandRequest.kind === "projectSearch.toggle"
    ) {
      if (!view || view.unavailable || (isScratch && !threadId)) return;
      if (searchDialog === commandRequest.kind) {
        closeSearch();
        return;
      }
      const previous =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      searchFocus.current = previous?.isConnected ? previous : null;
      setSearchDialog(commandRequest.kind);
    } else if (terminalAvailable)
      updateTerminalState(terminalScope, toggleTerminalOpen);
  }, [commandRequest, workspaceId, threadId, terminalAvailable, terminalScope]);

  const reconciledPanel = reconcileTerminalSurfaces(
    panel,
    terminalAvailable
      ? terminalState.panelSurfaces.map((surface) => surface.id)
      : [],
  );
  if (reconciledPanel !== panel) setPanel(reconciledPanel);
  const label = (isScratch ? scratch : workspace)?.label ?? "Repository";
  const newThreadLabel = isScratch
    ? "New thread without a project"
    : `New thread in ${label}`;
  const busy = thread
    ? workingSessions.has(thread.session.kind) ||
      thread.turns.some(
        (turn) =>
          turn.checkpoint.kind === "pending" ||
          turn.checkpoint.kind === "before",
      )
    : false;
  const effectiveFollowUpBehavior =
    preferences.followUpBehavior === "steer" &&
    !queued.length &&
    thread &&
    immediateIntent(thread)?.kind === "steer"
      ? "steer"
      : "queue";
  const pending = thread?.approvals.filter((a) => a.state === "pending") ?? [];
  const approval = pending[0];
  const questionRequest = thread?.userQuestions.find(
    (request) => request.state === "pending" || request.state === "answering",
  );
  const latestTurn = thread?.turns.at(-1);
  const proposedPlan =
    latestTurn?.execution.kind === "completed"
      ? latestTurn.items.findLast(
          (item) => item.kind === "plan" && item.complete && item.text.trim(),
        )
      : undefined;
  const showPlanFollowUp = Boolean(
    planSupported &&
    settings?.interactionMode === "plan" &&
    proposedPlan &&
    !busy &&
    !approval &&
    !questionRequest &&
    !queued.length &&
    !slots.length,
  );
  const noticeKey = usageNoticeKey(
    threadId ?? `draft:${workspaceId}`,
    thread?.turns.at(-1)?.id ?? null,
    approval?.id ?? questionRequest?.id ?? null,
  );
  const reviewDraftTarget = useRef<ReviewDraftTarget>({
    workspaceId,
    threadId,
    canAccept: false,
  });
  reviewDraftTarget.current = {
    workspaceId,
    threadId,
    canAccept: Boolean(
      threadId &&
      thread &&
      !isScratch &&
      !busy &&
      !reverting &&
      !send.isPending &&
      !saveSettings.isPending &&
      !approval,
    ),
  };
  const askCodex = (request: ReviewDraftRequest) => {
    const target = reviewDraftTarget.current;
    if (!canAcceptReviewDraft(request, target)) return;
    setDraft(
      (current) => appendReviewDraft(current, request, target) ?? current,
    );
    setMaximized(false);
    setComposerFocusRequest((current) => current + 1);
  };
  const canStop = Boolean(
    thread?.turns.some(
      (t) => t.execution.kind === "running" && t.nativeTurnId !== null,
    ),
  );
  const isDraft = !threadId;
  const dormant =
    thread && ["dormant", "unavailable"].includes(thread.session.kind);
  const addAttachments = async (
    files: File[],
    source?: AttachmentSource,
  ): Promise<Attachment[]> => {
    const started = composerRef.current;
    const admitted = reserveAttachments(started, files, source);
    updateComposer(() => admitted.input);
    if (admitted.errors.length) setError(admitted.errors.join("\n"));
    return (
      await Promise.all(
        admitted.reservations.map(async (reservation) => {
          try {
            const file = await prepareComposerFile(reservation);
            const attachment = await ipc.stageAttachment(
              file,
              reservation.kind,
              reservation.source,
            );
            const current = composerRef.current;
            if (
              !acceptsCompletion(current, started) ||
              !current.attachments.some(
                (slot) =>
                  slot.key === reservation.key && slot.status === "staging",
              )
            )
              return null;
            const next = finishComposerStaging(
              current,
              started,
              reservation.key,
              attachment,
            );
            if (totalImageBytes(next) > MAX_TOTAL_IMAGE_BYTES)
              throw new Error(IMAGE_TOTAL_ERROR);
            updateComposer(() => next);
            return attachment;
          } catch (cause) {
            const current = composerRef.current;
            if (
              !acceptsCompletion(current, started) ||
              !current.attachments.some((slot) => slot.key === reservation.key)
            )
              return null;
            updateComposer((current) => ({
              ...current,
              attachments: current.attachments.filter(
                (slot) => slot.key !== reservation.key,
              ),
              generation: current.generation + 1,
            }));
            setError(cause instanceof Error ? cause.message : String(cause));
            return null;
          }
        }),
      )
    ).filter((attachment) => attachment !== null);
  };
  useEffect(() => {
    if (
      !threadId ||
      thread?.id !== threadId ||
      composer.threadId !== threadId ||
      composer.scopeKey !== draftKey ||
      !settings
    )
      return;
    const files = sidebarPendingFileDrops.consume(threadId);
    if (files.length)
      setDropRequest({ id: crypto.randomUUID(), scopeKey: draftKey, files });
  }, [dropVersion, thread?.id, composer.activation, settings]);
  const attachments = readyAttachments(slots);
  const submit = () => {
    if (!settings) return;
    if (!threadId && !isScratch) {
      if (configQuery.isPending) return;
      if (configQuery.error) {
        setError(configQuery.error.message);
        return;
      }
    }
    const command = standaloneComposerCommand(draft);
    if (planSupported && (command === "plan" || command === "default")) {
      if (
        busy ||
        send.isPending ||
        saveSettings.isPending ||
        approval ||
        questionRequest
      )
        return;
      saveSettings.mutate({
        ...settings,
        interactionMode: command === "plan" ? "plan" : "default",
      });
      setDraft("");
      return;
    }
    if (isUsageLimitsCommand(draft)) {
      setUsageNotice({ key: noticeKey, now: Date.now() });
      setDraft("");
      return;
    }
    if (
      attachments === null ||
      (!draft.trim() && attachments.length === 0 && !showPlanFollowUp) ||
      reverting ||
      send.isPending ||
      saveSettings.isPending ||
      (Boolean(threadId) && !thread)
    )
      return;
    if (thread && (busy || queued.length)) {
      const id = crypto.randomUUID();
      followUps.enqueue(thread, {
        id,
        text: draft,
        context: referencedContext(composer),
        attachments,
        settings,
      });
      updateComposer((current) => clearAcceptedInput(current, composer));
      setError(undefined);
      if (busy && effectiveFollowUpBehavior === "steer")
        sendFollowUpNow(client, thread, id);
      return;
    }
    if (approval || questionRequest) return;
    const submission =
      showPlanFollowUp && proposedPlan && "text" in proposedPlan
        ? resolvePlanFollowUpSubmission({
            draftText: draft,
            planMarkdown: proposedPlan.text,
          })
        : { text: draft, interactionMode: settings.interactionMode };
    send.mutate({
      text: submission.text,
      attachments,
      started: composer,
      settings: { ...settings, interactionMode: submission.interactionMode },
    });
  };
  const implementInNewThread = () => {
    if (
      !showPlanFollowUp ||
      !settings ||
      !thread ||
      !proposedPlan ||
      !("text" in proposedPlan) ||
      send.isPending ||
      saveSettings.isPending
    )
      return;
    send.mutate({
      text: buildPlanImplementationPrompt(proposedPlan.text),
      attachments: [],
      started: composer,
      settings: { ...settings, interactionMode: "default" },
      newThreadSource: thread,
    });
  };
  const title = isDraft ? "New thread" : (thread?.title ?? "");
  const worktreeDraft =
    isDraft && !createdDraft && draftCheckout.mode === "worktree";
  const controlsDisabled =
    busy ||
    reverting ||
    send.isPending ||
    saveSettings.isPending ||
    Boolean(approval) ||
    Boolean(questionRequest) ||
    (Boolean(threadId) && !thread);
  const context: ComponentProps<typeof Composer>["context"] = isScratch
    ? undefined
    : {
        checkout:
          isDraft && !createdDraft
            ? {
                kind: "draft",
                mode: draftCheckout.mode,
                onChange: (mode) =>
                  setDraftCheckout((current) => ({
                    ...current,
                    mode,
                  })),
              }
            : (thread ?? createdDraft)?.checkout,
        branch: (
          <BranchPicker
            checkout={checkout}
            branches={branches}
            value={
              worktreeDraft
                ? base
                : (branches?.branches.find((branch) => branch.current)?.name ??
                  (view?.branch || null))
            }
            worktreeBase={
              worktreeDraft
                ? {
                    fromOrigin: draftCheckout.fromOrigin,
                    onSelect: (name) =>
                      setDraftCheckout((current) => ({
                        ...current,
                        base: name,
                      })),
                    onFromOriginChange: (fromOrigin) =>
                      setDraftCheckout((current) => ({
                        ...current,
                        fromOrigin,
                      })),
                  }
                : undefined
            }
            disabled={controlsDisabled}
            onError={setError}
          />
        ),
      };
  const addComposerContext = (record: ComposerContextRecord) => {
    try {
      const content = appendContext(composer, record);
      const started = composer;
      updateComposer((current) =>
        acceptsCompletion(current, started, true)
          ? { ...current, ...content, generation: current.generation + 1 }
          : current,
      );
      requestAnimationFrame(() =>
        setComposerFocusRequest((current) => current + 1),
      );
      return true;
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to add context.",
      );
      return false;
    }
  };
  const content = (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
      <div
        className="pointer-events-none fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] z-50 mr-px flex h-[var(--workspace-topbar-height)] items-center gap-1 [-webkit-app-region:no-drag]"
        data-workspace-titlebar-controls
      >
        <span
          aria-hidden={!panelOpen}
          inert={!panelOpen}
          className={cn(
            "flex shrink-0",
            panelOpen
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none absolute right-full mr-1 opacity-0",
          )}
        >
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={maximized}
            onClick={() => setMaximized((value) => !value)}
            aria-label={maximized ? "Restore panel size" : "Maximize panel"}
            title={maximized ? "Restore panel size" : "Maximize panel"}
            variant="ghost"
            size="sm"
          >
            {maximized ? (
              <Minimize2Icon className="size-4" />
            ) : (
              <Maximize2Icon className="size-4" />
            )}
          </Toggle>
        </span>
        <div className="pointer-events-auto flex h-full items-center">
          <div
            className="flex h-full shrink-0 items-center gap-1 [-webkit-app-region:no-drag]"
            data-panel-layout-controls
          >
            {terminalAvailable ? (
              <span className="flex shrink-0">
                <Toggle
                  className="shrink-0 [-webkit-app-region:no-drag]"
                  pressed={terminalOpen}
                  onClick={() =>
                    updateTerminalState(terminalScope, toggleTerminalOpen)
                  }
                  aria-label="Toggle terminal drawer"
                  title={`Toggle terminal drawer${terminalToggleShortcut ? ` (${terminalToggleShortcut})` : ""}`}
                  variant="ghost"
                  size="sm"
                >
                  <PanelBottomIcon className="size-4" />
                </Toggle>
              </span>
            ) : null}
            <span className="flex shrink-0">
              <Toggle
                className="shrink-0 [-webkit-app-region:no-drag]"
                pressed={panelOpen}
                onClick={() => {
                  setPanelOpen((value) => !value);
                  setMaximized(false);
                }}
                aria-label="Toggle right panel"
                title="Toggle right panel"
                variant="ghost"
                size="sm"
              >
                <PanelRightIcon className="size-4" />
              </Toggle>
            </span>
          </div>
        </div>
      </div>
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-col overflow-x-hidden",
          panelOpen && maximized ? "w-0 flex-none" : "flex-1",
        )}
      >
        <header
          data-tauri-drag-region="deep"
          data-chat-header
          className="flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-3 pl-(--workspace-gutter-start) pr-(--workspace-gutter-end) drag-region [[data-sidebar-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)] max-md:[[data-sidebar-state=expanded]_&]:pl-[var(--workspace-titlebar-content-left)] relative bg-background"
        >
          {!panelOpen ? (
            <span
              aria-hidden
              className="pointer-events-none fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] h-[var(--workspace-topbar-height)] w-28 [-webkit-app-region:no-drag]"
            />
          ) : null}
          <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
            <WorkspaceBreadcrumb
              ariaLabel="Thread breadcrumb"
              className="flex-1 overflow-clip [overflow-clip-margin:2px]"
            >
              <WorkspaceBreadcrumbItem className="shrink">
                <button
                  type="button"
                  aria-label={newThreadLabel}
                  title={newThreadLabel}
                  onClick={() =>
                    void navigate({
                      to: "/",
                      search: (previous) => ({
                        ...previous,
                        workspace: workspaceId,
                        thread: undefined,
                      }),
                    })
                  }
                  className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <WorkspaceBadge
                    workspace={{
                      kind: isScratch ? "scratch" : "repository",
                      label,
                    }}
                    className="size-3.5"
                  />
                  <WorkspaceBreadcrumbText className="max-w-40">
                    {label}
                  </WorkspaceBreadcrumbText>
                </button>
              </WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbSeparator>
                <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
              </WorkspaceBreadcrumbSeparator>
              <WorkspaceBreadcrumbItem current className="min-w-10 flex-1">
                <h2 aria-label={title} title={title} className="min-w-0 flex-1">
                  <WorkspaceBreadcrumbText>{title}</WorkspaceBreadcrumbText>
                </h2>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            <div
              data-chat-header-actions
              className={cn(
                "flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3",
                panelOpen
                  ? "pr-0"
                  : terminalAvailable
                    ? "pr-19.25 sm:pr-15.25 @3xl/header-actions:pr-16.25"
                    : "pr-10.25 sm:pr-7.25 @3xl/header-actions:pr-8.25",
              )}
            >
              {checkoutOpenable ? (
                <OpenInPicker target={workspaceTarget(checkout, "")} />
              ) : null}
              {!isScratch ? (
                <ProjectScriptsControl
                  scripts={configQuery.data?.scripts ?? []}
                  onRun={runScript}
                />
              ) : null}
              {gitThread ? (
                <GitActionsControl
                  checkout={checkout}
                  thread={gitThread}
                  threads={view?.threads ?? []}
                  onError={setError}
                  onOpenPullRequests={() => {
                    const links =
                      client.getQueryData<ThreadPrSummary>([
                        "thread-prs",
                        gitThread.id,
                      ])?.links ?? pullRequests;
                    setPanel((current) =>
                      openSurface(current, pullRequestSurface(links)),
                    );
                    setPanelOpen(true);
                  }}
                />
              ) : null}
            </div>
          </div>
        </header>
        <div className="flex min-h-0 min-w-0 flex-1">
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col">
              {error ||
              configQuery.error ||
              thread?.diagnostic ||
              query.error ? (
                <div className="pointer-events-auto mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
                  <div
                    role="alert"
                    data-variant="error"
                    className="relative rounded-xl border px-3.5 py-3 text-card-foreground text-sm alert-glass border-error/32 bg-error-surface text-error-foreground"
                  >
                    <div className="flex gap-2 items-start">
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <div className="line-clamp-3 text-error-foreground/80">
                          {error ??
                            configQuery.error?.message ??
                            query.error?.message ??
                            thread?.diagnostic}
                        </div>
                      </div>
                      {error ? (
                        <button
                          type="button"
                          className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
                          onClick={() => setError(undefined)}
                        >
                          Dismiss
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
            <div className="relative flex min-h-0 flex-1 flex-col bg-background">
              {thread ? (
                <FileLinkProvider value={fileLinks}>
                  <Timeline
                    thread={thread}
                    skills={skills.skills}
                    clearance={clearance}
                    reverting={revert.isPending}
                    busy={busy}
                    onEdit={(turnId) => {
                      if (threadId) {
                        recoverQueue();
                        followUps.hold(threadId);
                      }
                      openEdit(turnId);
                    }}
                    onRemoveQueued={recoverQueue}
                    onOpenTurnDiff={openTurnDiff}
                    onFileContextMenu={
                      checkoutOpenable
                        ? (path, event) =>
                            fileContextMenu.show(
                              workspaceTarget(checkout, path),
                              event,
                            )
                        : undefined
                    }
                  />
                  {fileContextMenu.element}
                </FileLinkProvider>
              ) : null}
            </div>
            <div
              ref={overlay}
              data-chat-composer-overlay="true"
              className={
                isDraft
                  ? "pointer-events-none absolute inset-0 z-20 flex items-center"
                  : "pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2"
              }
            >
              <div className="w-full ps-(--workspace-gutter-start) pe-(--workspace-gutter-end)">
                <div
                  data-chat-composer-stack="true"
                  className="group/composer-stack pointer-events-auto relative z-10 mx-auto w-full max-w-(--chat-max-width)"
                >
                  {isDraft ? (
                    <div className="absolute inset-x-0 bottom-full z-0">
                      <div className="pb-8">
                        <DraftHeadline
                          label={label}
                          workspaceId={workspaceId}
                          workspaces={workspaces}
                          isScratch={isScratch}
                          scratchAvailable={scratchAvailable}
                          onSelectWorkspace={onSelectWorkspace}
                          onStartScratch={onStartScratch}
                          onOpenRepository={onOpenRepository}
                        />
                      </div>
                    </div>
                  ) : null}
                  {dormant && view?.unavailable ? (
                    <div className="mb-2 flex items-center justify-between gap-2 px-4 text-xs text-muted-foreground">
                      <span>{view.unavailable}</span>
                    </div>
                  ) : dormant ? (
                    <div className="mb-2 flex items-center justify-between gap-2 px-4 text-xs text-muted-foreground">
                      <span>
                        {thread.session.kind === "dormant"
                          ? "Saved conversation. Reconnect to continue."
                          : "Codex is unavailable."}
                      </span>
                      <button
                        type="button"
                        className="pointer-events-auto font-medium text-foreground hover:underline disabled:opacity-64"
                        disabled={resume.isPending}
                        onClick={() => resume.mutate()}
                      >
                        Reconnect
                      </button>
                    </div>
                  ) : null}
                  {recoveryNotice ? (
                    <div
                      role="status"
                      className="mb-2 px-4 text-xs text-muted-foreground"
                    >
                      {recoveryNotice}
                    </div>
                  ) : null}
                  {thread?.pendingRevert ? (
                    <div className="mb-2 flex items-center justify-between gap-2 px-4 text-xs text-muted-foreground">
                      <span>
                        A saved revert needs to finish before this checkout can
                        continue.
                      </span>
                      <button
                        type="button"
                        className="font-medium text-foreground hover:underline disabled:opacity-64"
                        disabled={revert.isPending}
                        onClick={() =>
                          openEdit(thread.pendingRevert?.turnId ?? "")
                        }
                      >
                        Retry revert
                      </button>
                    </div>
                  ) : null}
                  <div className="relative">
                    {settings ? (
                      <Composer
                        key={threadId ?? "draft"}
                        scopeKey={draftKey}
                        activation={composer.activation}
                        dropRequest={dropRequest}
                        historyMessages={threadPromptHistoryMessages(thread)}
                        stashEntries={stashEntries}
                        stashOpen={stashOpen}
                        stashPulse={stashPulse}
                        onStash={() => {
                          void stashPrompt();
                        }}
                        onToggleStash={() =>
                          setStashOpen((current) => !current)
                        }
                        onCloseStash={() => setStashOpen(false)}
                        onRestoreStash={(entry) => {
                          void restoreStash(entry);
                        }}
                        onDeleteStash={(entry) => {
                          if (!stashBusy.current)
                            void promptStash
                              .delete(entry.id)
                              .catch((cause: Error) => setError(cause.message));
                        }}
                        onAttachmentNotice={(message) => {
                          const [title = "", ...detail] = message.split("\n");
                          setAttachmentNotice({
                            title,
                            description: detail.join("\n"),
                            type: title.startsWith("Large paste attached as")
                              ? "info"
                              : "error",
                          });
                        }}
                        value={draft}
                        records={records}
                        pullRequestScope={
                          !isScratch ? { workspaceId, threadId } : undefined
                        }
                        focusRequest={composerFocusRequest}
                        onChange={setDraft}
                        attachments={slots}
                        onAddAttachments={addAttachments}
                        onRemoveAttachment={(key) =>
                          updateComposer((current) => {
                            const slot = current.attachments.find(
                              (slot) => slot.key === key,
                            );
                            const removed =
                              slot?.status === "ready"
                                ? current.records.filter(
                                    (record) =>
                                      (record.kind === "file" ||
                                        record.kind === "image") &&
                                      record.attachmentId ===
                                        slot.attachment.id &&
                                      record.name === slot.attachment.name,
                                  )
                                : [];
                            let text = current.text;
                            const ids = new Set(
                              removed.map((record) => record.contextId),
                            );
                            for (const ref of contextReferences(
                              text,
                            ).toReversed())
                              if (ids.has(ref.contextId))
                                text =
                                  text.slice(0, ref.start) +
                                  text.slice(ref.end);
                            return {
                              ...current,
                              text,
                              records: current.records.filter(
                                (record) => !ids.has(record.contextId),
                              ),
                              attachments: current.attachments.filter(
                                (slot) => slot.key !== key,
                              ),
                              generation: current.generation + 1,
                            };
                          })
                        }
                        onSubmit={submit}
                        searchCheckout={
                          view && !view.unavailable && !(isScratch && !threadId)
                            ? checkout
                            : undefined
                        }
                        skills={skills.skills}
                        skillsLoading={skills.loading}
                        onSkillsMenuOpen={skills.refreshIfStale}
                        filesError={
                          workspaceQuery.error?.message ??
                          view?.unavailable ??
                          undefined
                        }
                        planSupported={planSupported}
                        showPlanFollowUp={showPlanFollowUp}
                        onImplementInNewThread={implementInNewThread}
                        onUsageLimits={() =>
                          setUsageNotice({ key: noticeKey, now: Date.now() })
                        }
                        onStop={() => {
                          recoverQueue();
                          stop.mutate();
                        }}
                        followUpBehavior={effectiveFollowUpBehavior}
                        canSend={
                          isUsageLimitsCommand(draft) ||
                          ((showPlanFollowUp ||
                            Boolean(draft.trim()) ||
                            slots.length > 0) &&
                            attachments !== null &&
                            !reverting &&
                            !send.isPending &&
                            !saveSettings.isPending &&
                            (Boolean(threadId) ||
                              isScratch ||
                              (!configQuery.isPending && !configQuery.error)) &&
                            (!threadId || Boolean(thread)))
                        }
                        taskTurn={latestTurn}
                        running={busy || queued.length > 0}
                        canStop={canStop}
                        stopping={
                          stop.isPending ||
                          thread?.session.kind === "interrupting"
                        }
                        placeholder={
                          approval
                            ? "Resolve this approval request to continue"
                            : "Ask for changes or send follow-ups"
                        }
                        approval={
                          questionRequest ? (
                            <ComposerPendingUserInputPanel
                              key={questionRequest.id}
                              request={questionRequest}
                              busy={
                                answerQuestions.isPending ||
                                questionRequest.state === "answering"
                              }
                              onAnswer={(answers) =>
                                answerQuestions.mutate({
                                  requestId: questionRequest.id,
                                  answers,
                                })
                              }
                            />
                          ) : approval ? (
                            <ApprovalDrawer
                              approval={approval}
                              pendingCount={pending.length}
                              busy={approve.isPending}
                              onAnswer={(decision) =>
                                approve.mutate({ id: approval.id, decision })
                              }
                            />
                          ) : null
                        }
                        notice={
                          usageNotice?.key === noticeKey ? (
                            <ComposerUsageLimits
                              now={usageNotice.now}
                              onDismiss={() => {
                                setUsageNotice(null);
                                setComposerFocusRequest(
                                  (current) => current + 1,
                                );
                              }}
                            />
                          ) : null
                        }
                        contextUsage={
                          preferences.contextWindowMeter
                            ? (thread?.context ?? null)
                            : null
                        }
                        disabled={false}
                        context={context}
                        settings={settings}
                        permissionModes={
                          capabilities.data?.permissionModes ?? []
                        }
                        models={models.data ?? []}
                        modelsLoading={models.isPending}
                        modelsError={models.error?.message}
                        onRetryModels={() => void models.refetch()}
                        onSettingsChange={(next, options) => {
                          if (!threadId && options?.permissionModeSelected) {
                            setDraftSettings((current) =>
                              captureDraftSettings({
                                current,
                                next,
                                permissionModeSelected: true,
                              }),
                            );
                          } else saveSettings.mutate(next);
                        }}
                        settingsDisabled={controlsDisabled}
                        autoFocus
                      />
                    ) : (
                      <div
                        className="rounded-2xl border border-border bg-background p-4 text-sm text-muted-foreground"
                        role="status"
                      >
                        {capabilities.error ? (
                          <>
                            <p>{capabilities.error.message}</p>
                            <button
                              type="button"
                              className="mt-2 font-medium text-foreground hover:underline"
                              onClick={() => void capabilities.refetch()}
                            >
                              Retry permissions
                            </button>
                          </>
                        ) : (
                          "Loading permissions..."
                        )}
                      </div>
                    )}
                    <div
                      aria-hidden
                      className="h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        {terminalAvailable ? (
          <RenderErrorBoundary
            resetKeys={[terminalScope, terminalOpen]}
            fallback={({ error, reset }) =>
              terminalOpen ? (
                <div
                  className="flex min-h-0 shrink-0 flex-col border-t border-border"
                  style={{ height: terminalState.terminalHeight }}
                >
                  <ErrorView
                    error={error}
                    onRetry={reset}
                    area="Terminal drawer"
                    contained
                  />
                </div>
              ) : null
            }
          >
            <PersistentThreadTerminalDrawer
              key={terminalScope}
              workspaceId={workspaceId}
              threadId={threadId ?? null}
              fontSize={preferences.codeFontSize}
              fileLinks={fileLinks}
              onClosed={() => setComposerFocusRequest((current) => current + 1)}
            />
          </RenderErrorBoundary>
        ) : null}
      </div>
      {panelOpen ? (
        <RenderErrorBoundary
          resetKeys={[checkout.workspaceId, checkout.threadId, threadId]}
          fallback={({ error, reset }) => (
            <div
              className={cn(
                "flex h-full min-h-0 min-w-0 max-w-full flex-col border-l border-border bg-background pt-(--workspace-topbar-height)",
                maximized ? "flex-1" : "shrink-0",
              )}
              style={{ width: maximized ? "100%" : 540 }}
            >
              <ErrorView
                error={error}
                onRetry={reset}
                area="Right panel"
                contained
              />
            </div>
          )}
        >
          <RightPanel
            checkout={checkout}
            git={!isScratch}
            view={view}
            state={panel}
            onChange={setPanel}
            maximized={maximized}
            conversationId={threadId}
            pullRequests={pullRequests}
            canAskCodex={reviewDraftTarget.current.canAccept}
            onAskCodex={askCodex}
            terminalAvailable={terminalAvailable}
            fileLinks={fileLinks}
            thread={thread}
            turnSelection={
              selectedCheckpointTurn(thread, turnSelection)
                ? turnSelection
                : null
            }
            onSelectTurn={selectTurnDiff}
          />
        </RenderErrorBoundary>
      ) : null}
      {searchDialog ? (
        <Dialog
          open
          variant="command"
          projectSearch={searchDialog}
          className={
            searchDialog === "projectSearch.toggle"
              ? "h-[min(44rem,80vh)] max-h-[80vh]"
              : "max-h-[min(42rem,80vh)]"
          }
          onOpenChange={(open) => {
            if (!open) closeSearch();
          }}
        >
          {searchDialog === "filePicker.toggle" ? (
            <ProjectFilePicker
              checkout={checkout}
              projectName={label}
              onOpenFile={(path) => {
                closeSearch();
                setPanel((current) => openFile(current, path));
                setPanelOpen(true);
              }}
            />
          ) : (
            <ProjectContentSearchDialog
              checkout={checkout}
              projectName={label}
              onOpenFile={(path, line) => {
                closeSearch();
                setPanel((current) => openFile(current, path, line));
                setPanelOpen(true);
              }}
            />
          )}
        </Dialog>
      ) : null}
      {thread && visibleEditTarget ? (
        <EditFromHereDialog
          thread={thread}
          turnId={visibleEditTarget}
          working={revert.isPending}
          error={preflightError ?? revert.error?.message}
          onClose={closeEdit}
          onRevert={startRevert}
          checkoutAvailable={Boolean(view && !view.unavailable)}
        />
      ) : null}
    </div>
  );
  return (
    <ComposerContextProvider
      value={reverting || send.isPending ? null : addComposerContext}
    >
      {content}
      {attachmentNotice ? (
        <ToastViewport>
          <Toast
            title={attachmentNotice.title}
            description={attachmentNotice.description}
            type={attachmentNotice.type}
            onDismiss={() => setAttachmentNotice(undefined)}
            dismissAfterVisibleMs={5000}
          />
        </ToastViewport>
      ) : null}
    </ComposerContextProvider>
  );
}
