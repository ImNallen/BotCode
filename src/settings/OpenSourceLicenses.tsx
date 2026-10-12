// Ported from T3 Code v0.0.45 apps/web/src/components/settings/OpenSourceLicenses.tsx (MIT).
import { ChevronRightIcon, ExternalLinkIcon, SearchIcon } from "lucide-react";
import { useEffect, useMemo, useReducer, useState, type Dispatch } from "react";

import { ipc } from "../ipc";
import { AnimatedHeight } from "../ui/AnimatedHeight";
import { Button } from "../ui/controls";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "../ui/input-group";
import { Tooltip } from "../ui/tooltip";
import {
  initialLicensesPanelState,
  licensesPanelReducer,
  licensesPanelView,
  loadLicenseManifest,
  type LicensesPanelAction,
} from "./OpenSourceLicenses.logic";
import { SettingsGroup } from "./settingsLayout";
import {
  formatLicenseBundles,
  thirdPartyLicenseEntryKey,
  type ThirdPartyLicenseEntry,
} from "./thirdPartyLicenses";

function LicenseNoticeRow({
  entry,
  open,
  onOpenChange,
}: {
  readonly entry: ThirdPartyLicenseEntry;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { sourceUrl } = entry;
  return (
    <article>
      <div className="flex min-h-10 items-center hover:bg-muted/35 sm:min-h-9">
        <button
          type="button"
          aria-expanded={open}
          data-panel-open={open ? "" : undefined}
          onClick={() => onOpenChange(!open)}
          className="group flex min-h-10 min-w-0 flex-1 items-center gap-2.5 px-3 text-left sm:min-h-9 sm:px-4"
        >
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-data-panel-open:rotate-90"
          />
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="truncate font-medium text-foreground">
              {entry.name}
            </span>
            {entry.version ? (
              <code className="shrink-0 text-xs text-muted-foreground">
                {entry.version}
              </code>
            ) : null}
          </span>
          <span className="max-w-[42%] shrink-0 truncate text-xs text-muted-foreground">
            {entry.license} · {formatLicenseBundles(entry.bundles)}
          </span>
        </button>
        {sourceUrl ? (
          <Button
            aria-label={`View project source for ${entry.name}`}
            className="me-3 shrink-0 sm:me-4"
            onClick={() =>
              void ipc
                .openUrl(sourceUrl)
                .catch((error: unknown) =>
                  console.error(`Failed to open ${sourceUrl}.`, error),
                )
            }
            size="icon-micro"
            title="Project source"
            variant="ghost-muted"
          >
            <ExternalLinkIcon aria-hidden className="size-3" />
          </Button>
        ) : null}
      </div>
      <AnimatedHeight>
        {open ? (
          <div className="px-9 pt-1 pb-4 sm:px-10">
            <pre className="max-w-[76ch] whitespace-pre-wrap break-words font-mono text-xs/5 text-foreground/80">
              {entry.noticeText}
            </pre>
          </div>
        ) : null}
      </AnimatedHeight>
    </article>
  );
}

function LicenseCount({ label }: { label: string }) {
  return (
    <p className="whitespace-nowrap text-xs font-normal text-muted-foreground tabular-nums">
      {label}
    </p>
  );
}

function LicenseHeaderAction({
  query,
  searchOpen,
  countLabel,
  dispatch,
}: {
  query: string;
  searchOpen: boolean;
  countLabel: string;
  dispatch: Dispatch<LicensesPanelAction>;
}) {
  if (!searchOpen) {
    return (
      <div className="flex items-center gap-1.5">
        <LicenseCount label={countLabel} />
        <Tooltip content="Search licenses" side="top">
          <Button
            aria-label="Search open-source licenses"
            onClick={() => dispatch({ type: "search-opened" })}
            size="icon-micro"
            type="button"
            variant="ghost-muted"
          >
            <SearchIcon className="size-3" />
          </Button>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <div className="hidden sm:block">
        <LicenseCount label={countLabel} />
      </div>
      <InputGroup className="w-36 sm:w-44">
        <InputGroupAddon>
          <SearchIcon aria-hidden className="size-3" />
        </InputGroupAddon>
        <InputGroupInput
          aria-label="Search open-source licenses"
          autoFocus
          onBlur={() => dispatch({ type: "search-blurred" })}
          onChange={(event) =>
            dispatch({
              type: "query-changed",
              query: event.currentTarget.value,
            })
          }
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            dispatch({ type: "search-escaped" });
          }}
          placeholder="Search licenses"
          size="compact"
          type="search"
          value={query}
        />
      </InputGroup>
    </div>
  );
}

function LicenseManifestError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-3 px-3 py-5 sm:px-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium text-foreground">
          Open-source notices are unavailable
        </h3>
        <p className="max-w-[70ch] text-pretty text-xs leading-normal text-muted-foreground/80">
          {message}
        </p>
      </div>
      <Button type="button" size="xs" variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

export function OpenSourceLicensesPanel() {
  const [state, dispatch] = useReducer(
    licensesPanelReducer,
    initialLicensesPanelState,
  );
  const [requestVersion, setRequestVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    dispatch({ type: "manifest", manifest: { status: "loading" } });
    void loadLicenseManifest(controller.signal).then(
      (manifest) =>
        dispatch({ type: "manifest", manifest: { status: "ready", manifest } }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        dispatch({
          type: "manifest",
          manifest: {
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "The license manifest could not load.",
          },
        });
      },
    );
    return () => controller.abort();
  }, [requestVersion]);

  const { manifest, query, searchOpen, openEntryKey } = state;
  const view = useMemo(
    () => licensesPanelView({ manifest, query }),
    [manifest, query],
  );

  return (
    <SettingsGroup
      id="third-party-notices"
      title="Third-party notices"
      headerAction={
        manifest.status === "ready" ? (
          <LicenseHeaderAction
            query={query}
            searchOpen={searchOpen}
            countLabel={view.countLabel}
            dispatch={dispatch}
          />
        ) : null
      }
    >
      {manifest.status === "ready" ? (
        <div className="text-base sm:text-sm">
          {view.entries.length > 0 ? (
            view.entries.map((entry) => {
              const key = thirdPartyLicenseEntryKey(entry);
              return (
                <LicenseNoticeRow
                  key={key}
                  entry={entry}
                  open={openEntryKey === key}
                  onOpenChange={(open) =>
                    dispatch({ type: "entry-open-changed", key, open })
                  }
                />
              );
            })
          ) : (
            <p className="px-3 py-8 text-center text-sm/6 text-muted-foreground sm:px-4">
              No licenses match that search.
            </p>
          )}
        </div>
      ) : manifest.status === "error" ? (
        <LicenseManifestError
          message={manifest.message}
          onRetry={() => setRequestVersion((value) => value + 1)}
        />
      ) : (
        <p className="px-3 py-5 text-sm/6 text-muted-foreground sm:px-4">
          Loading open-source notices…
        </p>
      )}
    </SettingsGroup>
  );
}
