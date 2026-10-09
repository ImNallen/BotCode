// Header, tabs and checks status follow pingdotgg/t3code 3e6b450 apps/web/src/components/pullRequest/PullRequestDetailPanel.tsx (MIT).
// Title editing follows pingdotgg/t3code v0.0.45 apps/web/src/components/pullRequest/PullRequestDetailPanel.tsx (MIT).
import { useEffect, useState } from "react";
import {
  currentPrScope,
  prScopeIdentity,
  type PrDiffScope,
} from "./pullRequestScope";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  BookOpenIcon,
  CircleDotIcon,
  ExternalLinkIcon,
  FileDiffIcon,
  HammerIcon,
  GitBranchIcon,
  MoreHorizontalIcon,
} from "lucide-react";
import { ipc } from "../ipc";
import { cn } from "../lib/cn";
import { formatRelativeTimeLabel } from "../lib/time";
import { Badge } from "../ui/badge";
import { Button, Toggle } from "../ui/controls";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuSeparator } from "../ui/menu";
import { RefreshIcon, SegmentedGroup } from "./chrome";
import { prUrl, type PullRequestKey } from "./pullRequests";
import { PullRequestReviewComposer } from "./PullRequestReviewComposer";
import { PullRequestTimeline, type ReviewHandoff } from "./PullRequestTimeline";
import { sectionProblemText } from "./prCoverage";
import { captureRepairDraft, type ReviewFinding } from "./reviews";
import {
  PullRequestLifecycleNotices,
  usePullRequestLifecycle,
} from "./PullRequestLifecycle";
import {
  changeResultText,
  lifecycleLabel,
  menuActions,
  primaryControl,
  type HeaderControls,
} from "./prLifecycle";
import type { LifecycleAction, PrReviewAction } from "./prReview";
import { checksRollup, prChecks, summarizeChecks } from "./prChecks";
import {
  PullRequestActorLabel,
  PullRequestDiffStat,
  PullRequestGlyph,
  PullRequestMetaLine,
  pullRequestState,
} from "./pullRequestPresentation";
import { PullRequestChecksPopover } from "./PullRequestChecksPopover";
import { PullRequestCopyableCode } from "./PullRequestCopyableCode";
import { PullRequestSummary } from "./PullRequestSummary";
import { usePullRequestFilesViewed } from "./usePullRequestFilesViewed";
import { PullRequestCodeTab } from "./PullRequestCodeTab";
import { PullRequestEditButton } from "./PullRequestEditButton";

const TABS = [
  { value: "summary", label: "Summary" },
  { value: "timeline", label: "Timeline" },
  { value: "code", label: "Code" },
] as const;

function ActionIcon({ action }: { action: LifecycleAction }) {
  switch (action.kind) {
    case "set_draft":
      return action.draft ? (
        <PullRequestGlyph.draft className="size-3.5" />
      ) : (
        <PullRequestGlyph.pullRequest className="size-3.5" />
      );
    case "set_closed":
      return action.closed ? (
        <PullRequestGlyph.closed className="size-3.5" />
      ) : (
        <PullRequestGlyph.reopen className="size-3.5" />
      );
    default:
      return <PullRequestGlyph.merged className="size-3.5" />;
  }
}

export function PullRequestDetail({
  prKey,
  onBack,
  ...handoff
}: { prKey: PullRequestKey; onBack: () => void } & ReviewHandoff) {
  const [tab, setTab] = useState<(typeof TABS)[number]["value"]>("summary");
  const [error, setError] = useState<string>();
  const query = useQuery({
    queryKey: ["pr-detail", handoff.threadId, prKey],
    queryFn: () => ipc.readPullRequest(handoff.threadId, prKey),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const detail = query.data;
  const [selectedScope, setScope] = useState<PrDiffScope>({ kind: "all" });
  const scope = detail
    ? currentPrScope(selectedScope, detail.timeline)
    : selectedScope;
  useEffect(() => {
    if (scope !== selectedScope) setScope(scope);
  }, [scope, selectedScope]);
  const commitQuery = useQuery({
    queryKey: [
      "pr-commit-files",
      handoff.threadId,
      detail?.observation,
      scope.kind === "commit" ? scope.oid : "all",
    ],
    queryFn: () => {
      if (!detail || scope.kind !== "commit")
        throw new Error("Select a current commit first.");
      return ipc.readPullRequestCommitFiles(handoff.threadId, {
        target: detail.observation,
        commitOid: scope.oid,
      });
    },
    enabled: !!detail && scope.kind === "commit" && tab === "code",
    retry: false,
    refetchOnWindowFocus: false,
  });
  const displayedFiles =
    scope.kind === "all"
      ? (detail?.files ?? [])
      : (commitQuery.data?.files ?? []);
  const filesViewed = usePullRequestFilesViewed({
    threadId: handoff.threadId,
    target: detail?.observation,
    paths: displayedFiles.map((file) => file.path),
  });
  const refresh = () => {
    void query.refetch();
    filesViewed.refresh();
    if (scope.kind === "commit") void commitQuery.refetch();
  };
  const disabled = query.isFetching || query.isError;
  const lifecycle = usePullRequestLifecycle({
    threadId: handoff.threadId,
    prKey,
    detail,
    disabled,
    refresh,
  });
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [titleSaving, setTitleSaving] = useState(false);
  const [titleError, setTitleError] = useState<string>();
  // Setting a title or body is idempotent on GitHub, so a failed save keeps
  // the editor open and retrying is safe without an acknowledgment step.
  const edit = async (
    action: Extract<PrReviewAction, { kind: "edit_title" | "edit_body" }>,
  ): Promise<string | undefined> => {
    if (!detail) return "The pull request is not loaded.";
    try {
      const result = await ipc.changePullRequest(handoff.threadId, {
        requestId: crypto.randomUUID(),
        target: detail.observation,
        action,
      });
      if (result.kind !== "applied") return changeResultText(result);
      await query.refetch();
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  const closeTitle = () => {
    setTitleDraft(null);
    setTitleError(undefined);
  };
  const saveTitle = async (next: string) => {
    const title = next.trim();
    if (!detail || titleSaving || disabled) return;
    if (title.length === 0 || title === detail.snapshot.title) {
      closeTitle();
      return;
    }
    setTitleSaving(true);
    setTitleError(undefined);
    const error = await edit({ kind: "edit_title", title });
    setTitleSaving(false);
    if (error === undefined) closeTitle();
    else setTitleError(error);
  };
  const openSource = (url: string) =>
    void ipc.openUrl(url).catch((error) => setError(String(error)));
  const explain = (
    intent: "explain" | "fix_check",
    body: string,
    url: string,
  ) => {
    if (!detail) return;
    const finding: ReviewFinding = {
      observation: {
        prId: detail.observation.nodeId,
        findingId: detail.observation.nodeId,
        headSha: detail.observation.headOid,
        contentDigest: "0".repeat(64),
      },
      source: { kind: "conversation" },
      comments: [
        {
          id: detail.observation.nodeId,
          body,
          url,
          author: null,
          createdAt: "",
          updatedAt: "",
          context: null,
        },
      ],
      saved: null,
    };
    handoff.onAskCodex({
      workspaceId: handoff.workspaceId,
      threadId: handoff.threadId,
      key: prKey,
      target: { ...detail.observation },
      intent,
      problems: detail.problems,
      finding,
    });
  };
  const repair = (intent: "resolve_conflicts" | "fix_findings") => {
    if (!detail) return;
    handoff.onAskCodex(
      captureRepairDraft({
        workspaceId: handoff.workspaceId,
        threadId: handoff.threadId,
        key: prKey,
        intent,
        detail,
      }),
    );
  };
  const [, owner, repository, number] = prKey.split("/");
  const repositoryName = `${owner}/${repository}`;
  const statePresentation = detail
    ? pullRequestState(detail.snapshot.lifecycle)
    : null;
  const { primary, armedBadge }: HeaderControls = detail
    ? primaryControl(detail)
    : { primary: { kind: "none" }, armedBadge: null };
  const menu = menuActions(detail?.capabilities.actions ?? [], primary);
  const checks = detail ? prChecks(detail.checks) : [];
  const checksIncomplete =
    detail?.problems.some((problem) => problem.section === "checks") ?? false;
  const checksState = checksIncomplete ? null : checksRollup(checks);
  const checksSummary = checksIncomplete
    ? "Checks could not be fully loaded"
    : summarizeChecks(checks);
  const canAsk = handoff.canAskCodex && !disabled;
  const updated = detail
    ? formatRelativeTimeLabel(detail.snapshot.hostUpdatedAt)
    : "";
  const autoMergeBadge = (label: string) => (
    <Badge
      size="control"
      variant="info"
      role="img"
      aria-label={label}
      title={`${label}: GitHub merges this once its requirements are met`}
    >
      <PullRequestGlyph.merged aria-hidden className="size-3.5" />
      <span className="@max-[30rem]/pr-header:hidden">{label}</span>
    </Badge>
  );
  return (
    <section
      className="flex min-h-0 flex-1 flex-col text-sm"
      aria-label="Pull request detail"
    >
      <div
        className={cn(
          "@container/pr-header grid min-w-0 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 pt-2",
          detail && "border-b border-border/60",
        )}
      >
        <div className="pl-4 grid h-7 min-w-0 items-center overflow-hidden">
          <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-1 text-sm text-muted-foreground sm:text-xs">
            <button
              type="button"
              title={`Open ${repositoryName} repository`}
              onClick={() => openSource(`https://github.com/${repositoryName}`)}
              className="min-w-0 cursor-pointer truncate text-left font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {repositoryName}
            </button>
            <button
              type="button"
              title="Open on GitHub"
              onClick={() => openSource(prUrl(prKey))}
              className={cn(
                "inline-flex shrink-0 cursor-pointer items-center gap-0.5 font-medium underline-offset-2 hover:underline",
                statePresentation?.toneClassName,
              )}
              aria-label={`Open pull request #${number} on GitHub`}
            >
              #{number}
              <ExternalLinkIcon aria-hidden className="size-2.5" />
            </button>
          </div>
        </div>
        <div className="mr-4 flex h-7 shrink-0 items-center justify-end gap-1">
          {handoff.onCheckout ? (
            <Button
              size="xs"
              variant="outline"
              aria-label="Check out"
              disabled={!detail || disabled}
              onClick={() =>
                detail && handoff.onCheckout?.({ ...detail.observation })
              }
            >
              <GitBranchIcon aria-hidden className="size-3.5" />
              <span className="@max-[35rem]/pr-header:hidden">Check out</span>
            </Button>
          ) : null}
          {armedBadge ? autoMergeBadge(armedBadge) : null}
          {primary.kind === "resolve_conflicts" ? (
            <Button
              size="xs"
              variant="destructive-outline"
              title="Resolve conflicts"
              aria-label="Resolve conflicts"
              disabled={disabled || !handoff.canAskCodex}
              onClick={() => repair("resolve_conflicts")}
            >
              <PullRequestGlyph.conflicting aria-hidden className="size-3.5" />
              <span className="@max-[30rem]/pr-header:hidden">
                Resolve conflicts
              </span>
            </Button>
          ) : primary.kind === "action" ? (
            <Button
              size="xs"
              variant="default"
              title={primary.label}
              aria-label={primary.label}
              disabled={!lifecycle.allowed(primary.action)}
              onClick={() => lifecycle.choose(primary.action)}
            >
              <ActionIcon action={primary.action} />
              <span className="@max-[30rem]/pr-header:hidden">
                {primary.label}
              </span>
            </Button>
          ) : primary.kind === "auto_merge_armed" ? (
            autoMergeBadge(primary.label)
          ) : primary.kind === "queued" ? (
            <Badge size="control" variant="info">
              <PullRequestGlyph.merged aria-hidden className="size-3.5" />
              <span className="@max-[30rem]/pr-header:hidden">Queued</span>
            </Badge>
          ) : primary.kind === "state" && statePresentation ? (
            <Badge size="control" variant="outline">
              <span
                className={cn(
                  "flex items-center gap-1",
                  statePresentation.toneClassName,
                )}
              >
                <statePresentation.Icon className="size-3.5" />
                {statePresentation.label}
              </span>
            </Badge>
          ) : null}
          <Menu
            align="end"
            trigger={(props) => (
              <Button
                {...props}
                size="icon-xs"
                variant="ghost-muted"
                aria-label={
                  query.isFetching
                    ? "Refreshing pull request"
                    : "More pull request actions"
                }
                title={
                  query.isFetching
                    ? "Refreshing pull request"
                    : "More pull request actions"
                }
              >
                {query.isFetching ? (
                  <RefreshIcon refreshing className="size-4" />
                ) : (
                  <MoreHorizontalIcon className="size-4" />
                )}
              </Button>
            )}
          >
            <MenuItem onClick={onBack}>
              <ArrowLeftIcon className="size-3.5" />
              All pull requests
            </MenuItem>
            <MenuItem disabled={query.isFetching} onClick={refresh}>
              <RefreshIcon refreshing={query.isFetching} className="size-3.5" />
              Refresh
            </MenuItem>
            <MenuItem
              disabled={!detail || !canAsk}
              onClick={() =>
                detail &&
                explain(
                  "explain",
                  `Explain this pull request and assess its changes.\n${detail.body}`,
                  prUrl(prKey),
                )
              }
            >
              <BookOpenIcon className="size-3.5" />
              Explain with Codex
            </MenuItem>
            <MenuItem
              disabled={!detail || !canAsk}
              onClick={() => repair("fix_findings")}
            >
              <HammerIcon className="size-3.5" />
              Fix findings
            </MenuItem>
            {menu.lifecycle.length ? <MenuSeparator /> : null}
            {menu.lifecycle.map((action) => (
              <MenuItem
                key={lifecycleLabel(action)}
                disabled={!lifecycle.allowed(action)}
                onClick={() => lifecycle.choose(action)}
              >
                <ActionIcon action={action} />
                {lifecycleLabel(action)}
              </MenuItem>
            ))}
            {menu.closing.length ? <MenuSeparator /> : null}
            {menu.closing.map((action) => (
              <MenuItem
                key={lifecycleLabel(action)}
                disabled={!lifecycle.allowed(action)}
                onClick={() => lifecycle.choose(action)}
              >
                <ActionIcon action={action} />
                {lifecycleLabel(action)}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem onClick={() => openSource(prUrl(prKey))}>
              <ArrowUpRightIcon className="size-3.5" />
              Open on GitHub
            </MenuItem>
          </Menu>
        </div>
        <div className="col-span-2 mt-1 min-w-0 px-4 pb-4">
          {detail && titleDraft !== null ? (
            <div className="space-y-2">
              <Input
                autoFocus
                size="sm"
                disabled={titleSaving}
                value={titleDraft}
                aria-label="Pull request title"
                onChange={(event) => setTitleDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void saveTitle(titleDraft);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    closeTitle();
                  }
                }}
              />
              <div className="flex justify-end gap-2">
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={titleSaving}
                  onClick={closeTitle}
                >
                  Cancel
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={
                    titleSaving || disabled || titleDraft.trim().length === 0
                  }
                  onClick={() => void saveTitle(titleDraft)}
                >
                  {titleSaving ? "Saving..." : "Save"}
                </Button>
              </div>
              {titleError ? (
                <p role="alert" className="text-xs text-destructive">
                  {titleError}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="group flex min-h-7 min-w-0 items-center gap-1 sm:min-h-6">
              <h1
                className="min-w-0 flex-1 truncate text-base font-semibold leading-snug"
                title={detail?.snapshot.title}
              >
                {detail?.snapshot.title ?? "Loading pull request…"}
              </h1>
              {detail?.capabilities.edit ? (
                <PullRequestEditButton
                  aria-label="Edit title"
                  disabled={disabled}
                  onClick={() => setTitleDraft(detail.snapshot.title)}
                />
              ) : null}
            </div>
          )}
          {detail ? (
            <>
              <div className="mt-2 flex min-h-5 min-w-0 items-center gap-2 text-xs text-muted-foreground">
                <PullRequestMetaLine className="min-w-0 whitespace-nowrap">
                  <PullRequestActorLabel actor={detail.author} />
                  {updated ? <span>updated {updated}</span> : null}
                </PullRequestMetaLine>
                <PullRequestCopyableCode
                  key={number}
                  value={`gh pr checkout ${number}`}
                  copyLabel="Copy checkout command"
                  copiedLabel="Checkout command copied"
                  className="ml-auto font-mono"
                />
              </div>
              <div className="mt-4 flex min-h-5 min-w-0 items-center gap-2 text-xs text-muted-foreground">
                <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-xs text-muted-foreground/70">
                  <span
                    className="inline-flex min-w-0 max-w-[40%] shrink-0 items-center gap-1"
                    title={detail.snapshot.base}
                  >
                    <code className="flex min-w-0">
                      <span className="truncate">{detail.snapshot.base}</span>
                    </code>
                  </span>
                  <ArrowLeftIcon
                    aria-label="receives changes from"
                    className="size-3.5 shrink-0 opacity-60"
                  />
                  <PullRequestCopyableCode
                    key={detail.snapshot.head}
                    value={detail.snapshot.head}
                    copyLabel="Copy pull request branch"
                    copiedLabel="Branch name copied"
                  />
                </span>
                <span className="ml-auto inline-flex shrink-0 items-center justify-end gap-2">
                  <span className="inline-flex min-w-16 items-center justify-end gap-1.5 tabular-nums">
                    <FileDiffIcon className="size-3.5" />
                    {detail.changedFiles.toLocaleString()}{" "}
                    {detail.changedFiles === 1 ? "file" : "files"}
                  </span>
                  <PullRequestDiffStat
                    additions={detail.additions}
                    deletions={detail.deletions}
                    className="shrink-0 font-mono text-xs"
                  />
                </span>
              </div>
            </>
          ) : null}
        </div>
        {detail ? (
          <nav
            className="col-span-2 flex min-w-0 flex-wrap items-center gap-2 border-t border-border/60 px-4 py-2"
            aria-label="Pull request tabs"
          >
            <SegmentedGroup label="Pull request sections">
              {TABS.map((item) => (
                <Toggle
                  key={item.value}
                  size="segmented"
                  variant="segmented"
                  pressed={tab === item.value}
                  onClick={() => setTab(item.value)}
                >
                  {item.label}
                </Toggle>
              ))}
            </SegmentedGroup>
            {tab === "summary" ? (
              <span className="ml-auto flex min-w-0 flex-1 items-center justify-end">
                <span
                  className="flex h-4 min-w-0 flex-wrap content-start items-center justify-end gap-x-1.5 overflow-hidden text-xs text-muted-foreground"
                  aria-label={`Checks: ${checksSummary}`}
                >
                  {checksState !== null ? (
                    <PullRequestChecksPopover
                      checks={checks}
                      checksState={checksState}
                      openSource={openSource}
                    />
                  ) : (
                    <CircleDotIcon aria-hidden className="size-3.5" />
                  )}
                  <span className="whitespace-nowrap">{checksSummary}</span>
                </span>
              </span>
            ) : null}
          </nav>
        ) : null}
      </div>
      <PullRequestLifecycleNotices
        lifecycle={lifecycle}
        detail={detail}
        disabled={disabled}
      />
      {filesViewed.mutationError ? (
        <p role="alert" className="p-2 text-xs text-destructive">
          {filesViewed.mutationError}
        </p>
      ) : null}
      {error || query.error ? (
        <p role="alert" className="p-2 text-xs text-destructive">
          {error ?? query.error?.message}{" "}
          {detail ? "Last loaded detail. Refresh before acting." : ""}
        </p>
      ) : null}
      {query.isFetching ? (
        <p role="status" className="px-3 py-1 text-xs text-muted-foreground">
          Loading pull request…
        </p>
      ) : null}
      {detail ? (
        <>
          <div
            className={cn(
              "min-h-0 flex-1",
              tab === "code"
                ? "flex flex-col overflow-hidden"
                : "overflow-y-auto",
            )}
          >
            {detail.problems.map((problem) => (
              <p
                key={problem.section}
                role="status"
                className="p-2 text-xs text-muted-foreground"
              >
                {sectionProblemText(problem)}{" "}
                <button
                  className="underline"
                  onClick={() => openSource(prUrl(prKey))}
                >
                  Open GitHub
                </button>
              </p>
            ))}
            {tab === "summary" ? (
              <PullRequestSummary
                detail={detail}
                checks={checks}
                checksIncomplete={checksIncomplete}
                canFix={canAsk}
                disabled={disabled}
                saveBody={(body) => edit({ kind: "edit_body", body })}
                openSource={openSource}
                fixCheck={(check) =>
                  explain(
                    "fix_check",
                    `Investigate and fix the ${check.name} check. Reported state: ${check.state}.`,
                    check.url ?? prUrl(prKey),
                  )
                }
              />
            ) : null}
            {tab === "timeline" ? (
              <PullRequestTimeline
                detail={detail}
                disabled={disabled}
                refresh={refresh}
                {...handoff}
              />
            ) : null}
            {tab === "code" ? (
              <PullRequestCodeTab
                filesViewed={filesViewed}
                key={prScopeIdentity(detail, scope)}
                detail={detail}
                scope={scope}
                onScopeChange={setScope}
                files={
                  scope.kind === "all"
                    ? detail.files
                    : (commitQuery.data?.files ?? [])
                }
                problems={
                  scope.kind === "all" ? [] : (commitQuery.data?.problems ?? [])
                }
                loading={scope.kind === "commit" && commitQuery.isFetching}
                error={
                  scope.kind === "commit" && commitQuery.isError
                    ? String(commitQuery.error)
                    : undefined
                }
                onRetry={() => void commitQuery.refetch()}
                disabled={disabled}
                onViewFiles={() =>
                  openSource(
                    scope.kind === "all"
                      ? `${prUrl(prKey)}/files`
                      : `${prUrl(prKey)}/commits/${scope.oid}`,
                  )
                }
              />
            ) : null}
          </div>
          <PullRequestReviewComposer
            threadId={handoff.threadId}
            detail={detail}
            disabled={disabled}
            onSubmitted={refresh}
          />
        </>
      ) : null}
    </section>
  );
}
