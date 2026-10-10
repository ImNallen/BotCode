// Ported from T3 Code v0.0.45 settings/SourceControlSettings.tsx (MIT).
import { SettingsGroup } from "./settingsLayout";
import { RefreshCwIcon } from "lucide-react";
import { Button, Switch } from "../ui/controls";
import { Tooltip } from "../ui/tooltip";
import { Badge } from "../ui/badge";
import { GitHub } from "../ui/icons";
import { cn } from "../lib/cn";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { useGitHubReadiness } from "../chat/githubReadiness";

export function GitHubProviderSettings() {
  const query = useGitHubReadiness();
  const readiness = query.data;
  const enabled = readiness?.kind === "ready";
  const summary =
    readiness?.kind === "ready" ? (
      <>
        <span>Authenticated</span>
        <span aria-hidden>as</span>
        <RedactedSensitiveText
          key={readiness.account}
          value={readiness.account}
          ariaLabel="Toggle source control account visibility"
          revealTooltip="Click to reveal account"
          hideTooltip="Click to hide account"
        />
      </>
    ) : readiness?.reason === "missing" ? (
      <span>Not available on this server: {readiness.hint}</span>
    ) : readiness?.reason === "unauthenticated" ? (
      <span>
        GitHub is not authenticated on this server. Sign in or configure
        credentials using the{" "}
        <code className="rounded bg-muted px-1 py-px text-2xs">gh</code> tool on
        the server host to enable change request features.
      </span>
    ) : query.isPending ? (
      <span>Checking GitHub...</span>
    ) : (
      <span>
        Could not verify GitHub.{" "}
        {readiness?.hint ?? "Check the server environment and rescan."}
      </span>
    );
  return (
    <SettingsGroup
      id="source-control-providers"
      title="Source Control Providers"
      headerAction={
        <Tooltip content="Rescan Git and hosting integrations">
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Rescan server environment"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCwIcon
              className={cn("size-3.5", query.isFetching && "animate-spin")}
            />
          </Button>
        </Tooltip>
      }
    >
      <div
        id="github-provider"
        tabIndex={-1}
        className="first:rounded-t-xl last:rounded-b-xl transition-colors hover:bg-muted/20"
      >
        <div className="px-3 py-3 sm:px-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
                  <GitHub className="size-4.5 text-foreground/80" aria-hidden />
                  <span
                    className={cn(
                      "pointer-events-none absolute -left-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background",
                      enabled ? "bg-success" : "bg-warning",
                    )}
                    aria-hidden
                  />
                </span>
                <span className="truncate text-sm font-medium text-foreground">
                  GitHub
                </span>
                {readiness?.kind === "unavailable" &&
                readiness.reason === "unauthenticated" ? (
                  <Badge variant="warning" size="sm">
                    Not authenticated
                  </Badge>
                ) : null}
              </div>
              <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs leading-normal text-muted-foreground/80">
                {summary}
              </p>
            </div>
            <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
              <Switch
                checked={enabled}
                onCheckedChange={() => {}}
                disabled
                aria-label="GitHub availability"
              />
            </div>
          </div>
        </div>
      </div>
    </SettingsGroup>
  );
}
