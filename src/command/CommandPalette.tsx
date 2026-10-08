import { useKeybindings } from "../keybindings/store";
// Ported from pingdotgg/t3code v0.0.45 components/CommandPalette.tsx (MIT).
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { ArchiveIcon, CommandIcon, MessageSquareIcon } from "lucide-react";
import { ipc, type Thread, type Workspace } from "../ipc";
import {
  actionLabel,
  actions,
  runAction,
  shortcutLabel,
  type ActionContext,
  type ActionId,
  type PalettePage,
} from "../lib/actions";
import { Dialog } from "../ui/dialog";
import { CommandPaletteContent } from "./CommandPaletteContent";
import {
  CommandPaletteResults,
  type PaletteGroup,
  type PaletteItem,
} from "./CommandPaletteResults";
import {
  matchesSearch,
  searchActions,
  searchThreads,
  type SearchThread,
} from "./commandPaletteSearch";

type Location =
  | { kind: Exclude<PalettePage, "archive-actions"> }
  | { kind: "archive-actions"; threadId: string };
export function CommandPalette({
  context,
  blocked,
  threads,
  workspaces,
  onClose,
  onSelectThread,
}: {
  context: ActionContext;
  blocked: boolean;
  threads: SearchThread[];
  workspaces: Workspace[];
  onClose: (restoreFocus: boolean) => void;
  onSelectThread: (workspaceId: string, threadId: string) => void;
}) {
  useKeybindings();
  const [location, setLocation] = useState<Location>({ kind: "root" });
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<string>();
  const [, refresh] = useState(0);
  const client = useQueryClient();
  const root = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      client.getQueryCache().subscribe((event) => {
        if (event.query.queryKey[0] === "thread") refresh((value) => value + 1);
      }),
    [client],
  );
  const archivesOpen =
    location.kind === "archived" || location.kind === "archive-actions";
  const archiveQueries = useQueries({
    queries: workspaces.map((workspace) => ({
      queryKey: ["thread-summaries", workspace.id],
      queryFn: () => ipc.threadSummaries(workspace.id),
      enabled: archivesOpen,
    })),
  });
  const archived = archiveQueries
    .flatMap((view, index) =>
      (view.data ?? [])
        .filter((thread) => thread.archivedAtMs !== null)
        .map((thread) => ({ thread, workspace: workspaces[index] })),
    )
    .sort(
      (a, b) => (b.thread.archivedAtMs ?? 0) - (a.thread.archivedAtMs ?? 0),
    );
  const archiveTarget =
    location.kind === "archive-actions"
      ? archived.find(({ thread }) => thread.id === location.threadId)?.thread
      : undefined;
  const changeLocation = (next: Location) => {
    setLocation(next);
    setQuery("");
    setHighlighted(undefined);
  };
  const currentContext: ActionContext = {
    ...context,
    archiveTarget,
    openSubmenu: (page) => {
      if (page !== "archive-actions") changeLocation({ kind: page });
    },
  };
  const executeAction = (id: ActionId) => {
    if (!actions[id].available(currentContext)) return;
    if (actions[id].submenu) {
      runAction(id, currentContext);
      return;
    }
    flushSync(() =>
      onClose(
        ![
          "filePicker.toggle",
          "projectSearch.toggle",
          "thread.rename",
          "settings.open",
          "terminal.toggle",
          "archive.delete",
          "thread.delete",
        ].includes(id),
      ),
    );
    runAction(id, currentContext);
  };
  const actionsOnly = query.trimStart().startsWith(">");
  const needle = actionsOnly ? query.trimStart().slice(1).trim() : query;
  const actionItems: PaletteItem[] = searchActions(
    currentContext,
    location.kind,
    needle,
  ).map((id) => {
    const Icon = actions[id].icon ?? CommandIcon;
    return {
      id: `command-${id}`,
      title: actionLabel(id, currentContext),
      icon: <Icon className="size-4 text-icon-muted" />,
      shortcut: shortcutLabel(id),
      submenu: actions[id].submenu,
      execute: () => executeAction(id),
    };
  });
  const snapshots = client
    .getQueriesData<Thread>({ queryKey: ["thread"] })
    .flatMap(([, thread]) => (thread ? [thread] : []));
  const matches = searchThreads(threads, snapshots, needle);
  const threadItems: PaletteItem[] = (
    needle.trim() ? matches : matches.slice(0, 12)
  ).map((row) => ({
    id: `command-thread-${row.thread.id}`,
    title: row.thread.title,
    icon: <MessageSquareIcon className="size-4 text-icon-muted" />,
    description: row.workspaceLabel,
    threadContentMatch: row.excerpt,
    execute: () => {
      flushSync(() => onClose(false));
      onSelectThread(row.workspaceId, row.thread.id);
    },
  }));
  const groups: PaletteGroup[] = blocked
    ? []
    : location.kind === "archived"
      ? [
          {
            label: "Archived threads",
            items: archived
              .filter(({ thread }) => matchesSearch(thread.title, needle))
              .map(({ thread, workspace }) => ({
                id: `command-archive-${thread.id}`,
                title: thread.title,
                description: workspace?.label,
                icon: <ArchiveIcon className="size-4 text-icon-muted" />,
                submenu: true,
                execute: () =>
                  changeLocation({
                    kind: "archive-actions",
                    threadId: thread.id,
                  }),
              })),
          },
        ]
      : location.kind === "root"
        ? [
            { label: "Actions", items: actionItems },
            ...(!actionsOnly
              ? [
                  {
                    label: needle.trim() ? "Threads" : "Recent threads",
                    items: threadItems,
                  },
                ]
              : []),
          ]
        : [
            {
              label:
                location.kind === "snooze"
                  ? "Snooze thread"
                  : location.kind === "copy"
                    ? "Copy"
                    : (archiveTarget?.title ?? "Archived thread unavailable"),
              items: actionItems,
            },
          ];
  const items = groups.flatMap((group) => group.items);
  const active = items.find((item) => item.id === highlighted) ?? items[0];
  useEffect(() => {
    if (active)
      document.getElementById(active.id)?.scrollIntoView({ block: "nearest" });
  }, [active?.id]);
  const back = () =>
    changeLocation({
      kind: location.kind === "archive-actions" ? "archived" : "root",
    });
  const archivesLoading =
    archivesOpen && archiveQueries.some((query) => query.isPending);
  const archivesFailed =
    archivesOpen && archiveQueries.some((query) => query.isError);
  return (
    <Dialog
      open
      variant="command"
      onOpenChange={(open) => {
        if (!open) onClose(true);
      }}
    >
      <div
        ref={root}
        className="flex min-h-0 flex-1 flex-col"
        data-testid="command-palette"
      >
        <CommandPaletteContent
          footerActionLabel={active?.submenu ? "Open" : "Select"}
          showBackHint={location.kind !== "root"}
          inputProps={{
            value: query,
            onChange: (event) => {
              setQuery(event.target.value);
              setHighlighted(undefined);
            },
            placeholder:
              location.kind === "root"
                ? "Search threads or type > for actions…"
                : location.kind === "archived"
                  ? "Search archived threads…"
                  : "Search actions…",
            "aria-label": "Search commands and threads",
            role: "combobox",
            "aria-autocomplete": "list",
            "aria-expanded": true,
            "aria-controls": "command-palette-results",
            "aria-activedescendant": active?.id,
            onKeyDown: (event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const index = items.findIndex((item) => item.id === active?.id);
                const next =
                  items[
                    (index +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      items.length) %
                      items.length
                  ];
                setHighlighted(next?.id);
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (!event.repeat) active?.execute();
              } else if (
                event.key === "Backspace" &&
                !query &&
                location.kind !== "root"
              ) {
                event.preventDefault();
                back();
              }
            },
          }}
        >
          {location.kind !== "root" ? (
            <button
              type="button"
              className="px-4 py-1 text-xs text-muted-foreground"
              onClick={back}
            >
              ← Back
            </button>
          ) : null}
          {archivesFailed ? (
            <div
              role="alert"
              className="px-4 py-2 text-sm text-error-foreground"
            >
              Could not load all archived threads.{" "}
              <button
                type="button"
                onClick={() => {
                  for (const view of archiveQueries) void view.refetch();
                }}
              >
                Retry
              </button>
            </div>
          ) : null}
          <CommandPaletteResults
            groups={groups}
            activeId={active?.id}
            onHighlight={setHighlighted}
            emptyMessage={
              blocked
                ? "Finish the current operation before running commands."
                : archivesLoading
                  ? "Loading archived threads…"
                  : location.kind === "archived"
                    ? "No archived threads found."
                    : location.kind === "archive-actions" && !archiveTarget
                      ? "This archived thread is no longer available."
                      : actionsOnly
                        ? "No matching actions."
                        : "No matching threads or actions."
            }
          />
          {location.kind === "root" && !actionsOnly ? (
            <p className="px-4 pb-2 text-xs text-muted-foreground">
              Searches all thread titles and messages in loaded conversations.
            </p>
          ) : null}
        </CommandPaletteContent>
      </div>
    </Dialog>
  );
}
