import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc } from "../ipc";
import { Button } from "../ui/controls";
import { ChatMarkdown } from "../chat/ChatMarkdown";
import { draftKey, reviewDrafts } from "./reviewDrafts";
import { prUrl, type PullRequestKey } from "./pullRequests";
import { PullRequestReviewComposer } from "./PullRequestReviewComposer";
import { PullRequestTimeline, type ReviewHandoff } from "./PullRequestTimeline";
import { sectionProblemText } from "./prCoverage";
import type { ReviewFinding } from "./reviews";

export function PullRequestDetail({
  prKey,
  onBack,
  ...handoff
}: { prKey: PullRequestKey; onBack: () => void } & ReviewHandoff) {
  const [tab, setTab] = useState<"summary" | "timeline" | "code">("summary");
  const [error, setError] = useState<string>();
  const query = useQuery({
    queryKey: ["pr-detail", handoff.threadId, prKey],
    queryFn: () => ipc.readPullRequest(handoff.threadId, prKey),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const detail = query.data;
  const refresh = () => {
    void query.refetch();
  };
  const disabled = query.isFetching || query.isError;
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
      intent,
      problems: detail.problems,
      finding,
    });
  };
  return (
    <section
      className="flex min-h-0 flex-1 flex-col text-sm"
      aria-label="Pull request detail"
    >
      <div className="space-y-2 border-b border-border/60 p-2">
        <div className="flex flex-wrap items-center gap-1">
          <Button size="compact" variant="ghost" onClick={onBack}>
            Back
          </Button>
          <span className="min-w-0 flex-1 break-all text-xs">
            #{prKey.split("/").at(-1)}
          </span>
          <Button
            size="compact"
            variant="ghost"
            onClick={() => openSource(prUrl(prKey))}
          >
            GitHub
          </Button>
          <Button
            size="compact"
            variant="ghost"
            disabled={query.isFetching}
            onClick={refresh}
          >
            Refresh
          </Button>
        </div>
        <h2 className="break-words px-1 font-medium">
          {detail?.snapshot.title ?? "Loading pull request…"}
        </h2>
        {detail ? (
          <p className="break-all px-1 text-xs text-muted-foreground">
            {detail.snapshot.head} → {detail.snapshot.base} ·{" "}
            {detail.snapshot.lifecycle.kind} ·{" "}
            {detail.reviewDecision?.replaceAll("_", " ") ??
              "No review decision"}
          </p>
        ) : null}
        <nav
          className="flex flex-wrap gap-1"
          aria-label="Pull request sections"
        >
          {(["summary", "timeline", "code"] as const).map((item) => (
            <Button
              key={item}
              size="sm"
              variant={tab === item ? "secondary" : "ghost"}
              aria-pressed={tab === item}
              onClick={() => setTab(item)}
            >
              {item === "summary"
                ? "Summary"
                : item === "timeline"
                  ? "Timeline"
                  : "Code"}
            </Button>
          ))}
        </nav>
      </div>
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
          <div className="min-h-0 flex-1 overflow-y-auto">
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
              <div className="space-y-4 p-3">
                <p className="break-all text-xs text-muted-foreground">
                  PR head {detail.observation.headOid} · Signed in as{" "}
                  {detail.observation.viewer}
                </p>
                <ChatMarkdown text={detail.body || "No description."} />
                <Button
                  size="compact"
                  variant="outline"
                  disabled={!handoff.canAskCodex || disabled}
                  onClick={() =>
                    explain(
                      "explain",
                      `Explain this pull request and assess its changes.\n${detail.body}`,
                      prUrl(prKey),
                    )
                  }
                >
                  Explain with Codex
                </Button>
                <div className="space-y-2">
                  <h3 className="text-xs font-medium">Checks</h3>
                  {detail.checks.length ? (
                    detail.checks.map((check, index) => (
                      <div
                        key={`${check.name}:${index}`}
                        className="space-y-1 rounded border border-border p-2 text-xs"
                      >
                        <p>
                          {check.name} · {check.state}
                        </p>
                        <div className="flex gap-2">
                          {check.url ? (
                            <Button
                              size="compact"
                              variant="ghost"
                              onClick={() =>
                                openSource(check.url ?? prUrl(prKey))
                              }
                            >
                              Source
                            </Button>
                          ) : null}
                          <Button
                            size="compact"
                            variant="outline"
                            disabled={!handoff.canAskCodex || disabled}
                            onClick={() =>
                              explain(
                                "fix_check",
                                `Investigate and fix the ${check.name} check. Reported state: ${check.state}.`,
                                check.url ?? prUrl(prKey),
                              )
                            }
                          >
                            Fix check
                          </Button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {detail.problems.some(
                        (problem) => problem.section === "checks",
                      )
                        ? "Checks could not be fully loaded."
                        : "No checks reported."}
                    </p>
                  )}
                </div>
              </div>
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
              <div className="space-y-3 p-2">
                {detail.files.map((file) => (
                  <article
                    key={file.path}
                    className="min-w-0 rounded border border-border"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-1 border-b border-border p-2 text-xs">
                      <span className="break-all font-medium">{file.path}</span>
                      <span>
                        +{file.additions} −{file.deletions}
                      </span>
                    </div>
                    {file.unavailable ? (
                      <p className="p-3 text-xs text-muted-foreground">
                        {file.unavailable}{" "}
                        <button
                          className="underline"
                          onClick={() => openSource(`${prUrl(prKey)}/files`)}
                        >
                          View on GitHub
                        </button>
                      </p>
                    ) : (
                      <div className="overflow-x-auto bg-code-background py-1 text-code-foreground">
                        <pre className="w-max min-w-full text-[11px]">
                          <code>
                            {file.anchors.map((line, index) => (
                              <div
                                key={index}
                                className="flex min-w-full items-start gap-2 px-1 hover:bg-accent/50"
                              >
                                <button
                                  type="button"
                                  className="w-12 shrink-0 cursor-pointer text-right text-muted-foreground disabled:cursor-default"
                                  aria-label={`Comment on ${file.path} ${line.side.toLowerCase()} line ${line.line}`}
                                  title="Add line comment to review"
                                  disabled={disabled || !detail.verdicts.length}
                                  onClick={() =>
                                    reviewDrafts.add(
                                      draftKey(detail.observation),
                                      {
                                        path: file.path,
                                        side: line.side,
                                        line: line.line,
                                      },
                                    )
                                  }
                                >
                                  {line.line} +
                                </button>
                                <span>{line.text}</span>
                              </div>
                            ))}
                          </code>
                        </pre>
                      </div>
                    )}
                  </article>
                ))}
              </div>
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
