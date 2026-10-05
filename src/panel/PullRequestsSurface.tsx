import type { PullRequestKey } from "./pullRequests";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { ipc } from "../ipc";
import { Button } from "../ui/controls";
import { prLabel, prUrl } from "./pullRequests";
import type { ThreadPrSummary } from "./pullRequests";

export function PullRequestsSurface({
  threadId,
  onOpen,
}: {
  threadId: string;
  onOpen: (key: PullRequestKey) => void;
}) {
  const client = useQueryClient();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const query = useQuery({
    queryKey: ["thread-prs", threadId],
    queryFn: () => ipc.threadPullRequests(threadId),
  });
  const run = async (operation: () => Promise<ThreadPrSummary>) => {
    setBusy(true);
    setError(undefined);
    try {
      await operation();
      await client.invalidateQueries({ queryKey: ["thread-prs", threadId] });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="flex min-h-0 flex-1 flex-col text-sm"
      aria-label="Linked pull requests"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="font-medium">Pull requests</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh pull requests"
          disabled={busy}
          onClick={() => void run(() => ipc.threadPullRequests(threadId, true))}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-1.5">
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const submitted = url;
            void run(async () => {
              const result = await ipc.linkPullRequest(threadId, submitted);
              setUrl((current) => (current === submitted ? "" : current));
              return result;
            });
          }}
        >
          <input
            aria-label="Pull request URL"
            type="url"
            required
            placeholder="https://github.com/owner/repo/pull/42"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={busy || !url.trim()}
          >
            Link
          </Button>
        </form>
        {error || query.error ? (
          <p role="alert" className="text-xs text-destructive">
            {error ?? query.error?.message}
          </p>
        ) : null}
        {query.isPending ? (
          <p className="text-xs text-muted-foreground">
            Loading pull requests…
          </p>
        ) : null}
        {query.data?.discovering ? (
          <p role="status" className="text-xs text-muted-foreground">
            Looking for this checkout's pull request…
          </p>
        ) : null}
        {query.data?.discoveryError ? (
          <p role="status" className="text-xs text-muted-foreground">
            {query.data.discoveryError}
          </p>
        ) : null}
        {query.data?.links.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No linked pull requests. Link a GitHub URL or refresh to discover
            this branch.
          </p>
        ) : null}
        {query.data?.links.map(({ pr }) => (
          <article
            key={pr.key}
            className="space-y-1 border-b border-border px-2 py-2"
          >
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0 break-words font-medium">
                {pr.snapshot?.title ??
                  `Pull request #${pr.key.split("/").at(-1)}`}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {prLabel(pr)}
              </span>
            </div>
            <p className="break-all text-xs text-muted-foreground">
              {pr.key.replace("github.com/", "")}
            </p>
            {pr.snapshot ? (
              <p className="break-all text-xs text-muted-foreground">
                {pr.snapshot.head} → {pr.snapshot.base}
              </p>
            ) : null}
            {pr.freshness.kind === "stale" ? (
              <p role="status" className="text-xs text-muted-foreground">
                Last known status. {pr.freshness.message}
              </p>
            ) : null}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => onOpen(pr.key)}
              >
                Open
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void ipc
                    .openUrl(prUrl(pr.key))
                    .catch((error) => setError(String(error)))
                }
              >
                <ExternalLinkIcon className="size-3" />
                GitHub
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(() => ipc.unlinkPullRequest(threadId, pr.key))
                }
              >
                Unlink
              </Button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
