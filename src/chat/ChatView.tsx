// Column, header and composer overlay follow pingdotgg/t3code v0.0.45
// components/ChatView.tsx, chat/ChatHeader.tsx and chat/PanelLayoutControls.tsx,
// and chat/DraftHeroHeadline.tsx at 6b286ae8a (MIT).
import {
  type ComponentProps,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FolderPlusIcon,
  Maximize2Icon,
  Minimize2Icon,
  PanelRightIcon,
} from "lucide-react";
import { checkoutKey, ipc, setThreadSnapshot } from "../ipc";
import type {
  ApprovalDecision,
  CheckoutRef,
  Thread,
  Workspace,
  SessionSettings,
} from "../ipc";
import { cn } from "../lib/cn";
import { workingSessions } from "../lib/sessions";
import { newWithoutProjectShortcut } from "../lib/shortcuts";
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
import { Menu, MenuItem, MenuSeparator } from "../ui/menu";
import { RightPanel, emptyPanel, type PanelState } from "../panel/RightPanel";
import { closeFiles, openFile } from "../panel/panelState";
import {
  appendReviewDraft,
  canAcceptReviewDraft,
  type ReviewDraftRequest,
  type ReviewDraftTarget,
} from "../panel/reviews";
import { FileLinkProvider, type FileLinks } from "./ChatMarkdown";
import { GitActionsControl } from "./GitActionsControl";
import { ApprovalDrawer } from "./ApprovalDrawer";
import { BranchPicker, startsFromOrigin } from "./BranchPicker";
import { Composer } from "./Composer";
import { Timeline } from "./Timeline";

type DraftCheckout = {
  mode: CheckoutMode;
  base: string | null;
  fromOrigin: boolean;
};

export function ChatView({
  workspaceId,
  threadId,
  workspaces,
  scratch,
  scratchAvailable,
  onSelectWorkspace,
  onStartScratch,
  onOpenRepository,
}: {
  workspaceId: string;
  threadId: string | undefined;
  workspaces: Workspace[];
  scratch: Workspace | undefined;
  scratchAvailable: boolean;
  onSelectWorkspace: (workspaceId: string) => void;
  onStartScratch: () => void;
  onOpenRepository: () => void;
}) {
  const isScratch = scratch?.id === workspaceId;
  const client = useQueryClient();
  const navigate = useNavigate({ from: "/" });
  const [panelOpen, setPanelOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [panel, setPanel] = useState<PanelState>(emptyPanel);
  const [draft, setDraft] = useState("");
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const [createdDraft, setCreatedDraft] = useState<Thread>();
  const [draftSettings, setDraftSettings] = useState<SessionSettings>({
    model: null,
    effort: null,
    permissionMode: "approval-required",
  });
  const { preferences } = usePreferences();
  const newThreadCheckout = projectSetting(
    preferences,
    workspaceId,
    "newThreadCheckout",
  ).value;
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
  useEffect(
    () => setDraftCheckout(draftDefaults()),
    [threadId, newThreadCheckout, newWorktreesStartFromOrigin],
  );
  const [error, setError] = useState<string>();
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
    setDraft("");
    setCreatedDraft(undefined);
  }, [threadId]);
  const query = useQuery({
    queryKey: ["thread", threadId],
    queryFn: async () => {
      const incoming = await ipc.thread(threadId ?? "");
      const current = client.getQueryData<Thread>(["thread", threadId]);
      return current && current.revision > incoming.revision
        ? current
        : incoming;
    },
    enabled: Boolean(threadId),
  });
  const thread = threadId ? query.data : undefined;
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
  const { data: view } = useQuery({
    queryKey: checkoutKey("workspace", checkout),
    queryFn: () => ipc.workspace(checkout),
  });
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
  const settings = thread?.settings ?? draftSettings;
  const models = useQuery({
    queryKey: ["models"],
    queryFn: ipc.models,
    retry: false,
  });
  const saveSettings = useMutation({
    mutationFn: async (next: SessionSettings) => {
      if (!threadId) {
        setDraftSettings(next);
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
    mutationFn: async (text: string) => {
      let target = threadId ?? createdDraft?.id;
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
        setCreatedDraft(created);
        void client.invalidateQueries({ queryKey: ["workspace"] });
      }
      if (!threadId) {
        try {
          const updated = await ipc.settings(target, draftSettings);
          setThreadSnapshot(client, updated);
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error));
          throw error;
        }
      }
      await ipc.submit(target, text, crypto.randomUUID());
      return target;
    },
    onSuccess: (target) => {
      setCreatedDraft(undefined);
      setDraft("");
      setError(undefined);
      if (!threadId) {
        void navigate({
          to: "/",
          search: (previous) => ({
            ...previous,
            workspace: workspaceId,
            thread: target,
          }),
        });
      }
      void client.invalidateQueries({ queryKey: ["thread", target] });
      void client.invalidateQueries({ queryKey: ["workspace"] });
    },
    onError: (e) => {
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
  const workspace = view?.workspace;
  const fileLinks = useMemo<FileLinks>(() => {
    const files = new Set(view?.files ?? []);
    const root = view?.workspace.root;
    return {
      resolve: (target) => {
        let path = target
          .trim()
          .replace(/^file:\/\//, "")
          .replace(/#L\d+.*$/, "")
          .replace(/:\d+(:\d+)?$/, "");
        if (root && path.startsWith(`${root}/`))
          path = path.slice(root.length + 1);
        path = path.replace(/^\.\//, "");
        return files.has(path) ? path : null;
      },
      open: (path) => {
        setPanelOpen(true);
        setPanel((current) => openFile(current, path));
      },
    };
  }, [view]);
  const label = (isScratch ? scratch : workspace)?.label ?? "Repository";
  const newThreadLabel = isScratch
    ? "New thread without a project"
    : `New thread in ${label}`;
  const busy = thread ? workingSessions.has(thread.session.kind) : false;
  const pending = thread?.approvals.filter((a) => a.state === "pending") ?? [];
  const approval = pending[0];
  const reviewDraftTarget = useRef<ReviewDraftTarget>({
    workspaceId,
    threadId,
    branch: view?.branch,
    canAccept: false,
  });
  reviewDraftTarget.current = {
    workspaceId,
    threadId,
    branch: view?.branch,
    canAccept: Boolean(
      threadId &&
      thread &&
      !isScratch &&
      !view?.unavailable &&
      !busy &&
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
  const submit = () => {
    if (
      !draft.trim() ||
      busy ||
      send.isPending ||
      saveSettings.isPending ||
      approval ||
      (Boolean(threadId) && !thread)
    )
      return;
    send.mutate(draft);
  };
  const title = isDraft ? "New thread" : (thread?.title ?? "");
  const worktreeDraft =
    isDraft && !createdDraft && draftCheckout.mode === "worktree";
  const controlsDisabled =
    busy ||
    send.isPending ||
    saveSettings.isPending ||
    Boolean(approval) ||
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
  return (
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
            {thread && !isScratch && !view?.unavailable ? (
              <div
                data-chat-header-actions
                className={cn(
                  "flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3",
                  panelOpen
                    ? "pr-0"
                    : "pr-10.25 sm:pr-7.25 @3xl/header-actions:pr-8.25",
                )}
              >
                <GitActionsControl
                  checkout={checkout}
                  thread={thread}
                  threads={view?.threads ?? []}
                  onError={setError}
                />
              </div>
            ) : null}
          </div>
        </header>
        <div className="flex min-h-0 min-w-0 flex-1">
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col">
              {error || thread?.diagnostic || query.error ? (
                <div className="pointer-events-auto mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
                  <div
                    role="alert"
                    data-variant="error"
                    className="relative rounded-xl border px-3.5 py-3 text-card-foreground text-sm alert-glass border-error/32 bg-error-surface text-error-foreground"
                  >
                    <div className="flex gap-2 items-start">
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <div className="line-clamp-3 text-error-foreground/80">
                          {error ?? query.error?.message ?? thread?.diagnostic}
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
                  <Timeline thread={thread} clearance={clearance} />
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
                  <div className="relative">
                    <Composer
                      key={threadId ?? "draft"}
                      value={draft}
                      focusRequest={composerFocusRequest}
                      onChange={setDraft}
                      onSubmit={submit}
                      onStop={() => stop.mutate()}
                      canSend={
                        Boolean(draft.trim()) &&
                        !busy &&
                        !send.isPending &&
                        !saveSettings.isPending &&
                        (!threadId || Boolean(thread))
                      }
                      running={busy}
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
                        approval ? (
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
                      disabled={Boolean(approval)}
                      context={context}
                      settings={settings}
                      models={models.data ?? []}
                      modelsLoading={models.isPending}
                      modelsError={models.error?.message}
                      onRetryModels={() => void models.refetch()}
                      onSettingsChange={(next) => saveSettings.mutate(next)}
                      settingsDisabled={controlsDisabled}
                      autoFocus
                    />
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
      </div>
      {panelOpen ? (
        <RightPanel
          checkout={checkout}
          git={!isScratch && !view?.unavailable}
          view={view}
          state={panel}
          onChange={setPanel}
          maximized={maximized}
          conversationId={threadId}
          canAskCodex={reviewDraftTarget.current.canAccept}
          onAskCodex={askCodex}
        />
      ) : null}
    </div>
  );
}

function DraftHeadline({
  label,
  workspaceId,
  workspaces,
  isScratch,
  scratchAvailable,
  onSelectWorkspace,
  onStartScratch,
  onOpenRepository,
}: {
  label: string;
  workspaceId: string;
  workspaces: Workspace[];
  isScratch: boolean;
  scratchAvailable: boolean;
  onSelectWorkspace: (workspaceId: string) => void;
  onStartScratch: () => void;
  onOpenRepository: () => void;
}) {
  const picker = (
    <Menu
      align="center"
      trigger={(props) => (
        <button
          type="button"
          className="inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap font-medium underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring gap-1.5 text-foreground underline decoration-foreground/30 decoration-dotted decoration-from-font hover:decoration-foreground hover:decoration-solid data-popup-open:decoration-foreground data-popup-open:decoration-solid pointer-events-auto max-w-64 align-baseline"
          {...props}
        >
          <span className="min-w-0 truncate">{label}</span>
        </button>
      )}
    >
      {scratchAvailable ? (
        <MenuItem aria-current={isScratch} onClick={onStartScratch}>
          <span className="flex min-w-0 items-center gap-2">
            <WorkspaceBadge
              workspace={{ kind: "scratch", label: "No project" }}
              className="size-4 shrink-0"
            />
            <span className="block min-w-0 truncate">No project</span>
          </span>
        </MenuItem>
      ) : null}
      {workspaces.map((workspace) => (
        <MenuItem
          key={workspace.id}
          aria-current={workspace.id === workspaceId}
          onClick={() => onSelectWorkspace(workspace.id)}
        >
          <span className="flex min-w-0 items-center gap-2">
            <WorkspaceBadge workspace={workspace} className="size-4 shrink-0" />
            <span className="block min-w-0 truncate">{workspace.label}</span>
          </span>
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem onClick={onOpenRepository}>
        <FolderPlusIcon />
        Add project
      </MenuItem>
    </Menu>
  );
  const heading = isScratch
    ? "What should we work on?"
    : `What should we build in ${label}?`;
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
      <h1
        aria-label={heading}
        className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl"
      >
        {isScratch ? (
          <>What should we work on?</>
        ) : (
          <>What should we build in {picker}?</>
        )}
      </h1>
      {isScratch || scratchAvailable ? (
        <p className="mt-2 flex h-6 items-center text-sm">
          {isScratch ? (
            picker
          ) : (
            <button
              type="button"
              title={newWithoutProjectShortcut}
              onClick={onStartScratch}
              className="inline-flex shrink-0 cursor-pointer items-center gap-0.5 whitespace-nowrap font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-64 text-muted-foreground hover:text-foreground pointer-events-auto"
            >
              or start without a project
            </button>
          )}
        </p>
      ) : null}
    </div>
  );
}
