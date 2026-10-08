// Ported from T3 Code v0.0.45 apps/web/src/routes/__root.tsx and components/ui/standalone-page.tsx (MIT).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { z } from "zod";
import packageManifest from "../../package.json?raw";
import { Button } from "../ui/controls";
import { errorMessage, errorReport } from "./errorReport";

const version = z
  .object({ version: z.string() })
  .parse(JSON.parse(packageManifest)).version;

export function ErrorView({
  error,
  onRetry,
  area = "Application",
  pathname = window.location.pathname,
  contained = false,
}: {
  error: unknown;
  onRetry: () => void | Promise<unknown>;
  area?: string;
  pathname?: string;
  contained?: boolean;
}) {
  const report = useMemo(
    () => errorReport({ error, pathname, version, area }),
    [error, pathname, area],
  );
  const [retrying, setRetrying] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const retry = async () => {
    setRetrying(true);
    setActionError(undefined);
    try {
      await onRetry();
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setRetrying(false);
    }
  };
  const content = (
    <>
      <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
        {contained ? area : "Bot Code"}
      </p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
        Something went wrong.
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {errorMessage(error)}
      </p>
      <div className="mt-5 flex flex-wrap gap-2">
        <Button size="sm" disabled={retrying} onClick={() => void retry()}>
          {retrying ? "Trying again..." : "Try again"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => window.location.reload()}
        >
          Reload app
        </Button>
        <CopyErrorButton report={report} onError={setActionError} />
      </div>
      {actionError ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {actionError}
        </p>
      ) : null}
      <div className="mt-5 overflow-hidden rounded-lg border border-border/70 bg-background/55">
        <p className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
          Error report
        </p>
        <pre className="max-h-64 overflow-auto border-t border-border/70 bg-background/80 px-3 py-2 text-xs whitespace-pre-wrap text-foreground/85">
          {report}
        </pre>
      </div>
    </>
  );
  if (contained)
    return (
      <div
        role="alert"
        className="flex min-h-0 flex-1 flex-col overflow-auto bg-background p-6 text-foreground"
      >
        {content}
      </div>
    );
  return <StandaloneErrorPage>{content}</StandaloneErrorPage>;
}

function CopyErrorButton({
  report,
  onError,
}: {
  report: string;
  onError: (message: string | undefined) => void;
}) {
  const [copiedReport, setCopiedReport] = useState<string>();
  const copied = copiedReport === report;
  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopiedReport(undefined), 2000);
    return () => clearTimeout(timeout);
  }, [copied]);
  const copy = async () => {
    onError(undefined);
    try {
      await navigator.clipboard.writeText(report);
      setCopiedReport(report);
    } catch (cause) {
      onError(`Could not copy the error report. ${errorMessage(cause)}`);
    }
  };
  return (
    <Button size="sm" variant="outline" onClick={() => void copy()}>
      {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
      {copied ? "Copied" : "Copy error"}
    </Button>
  );
}

function StandaloneErrorPage({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6"
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-80"
        aria-hidden
      >
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-red-500)_16%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>
      <section className="relative w-full max-w-xl rounded-2xl border border-border/80 shadow-2xl shadow-black/20 backdrop-blur-md bg-card/90">
        <div className="p-6 sm:p-8">{children}</div>
      </section>
    </div>
  );
}
