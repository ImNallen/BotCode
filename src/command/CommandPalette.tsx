import {
  ThreadMessageSearchController,
  contentQuery,
  type MessageSearchState,
} from "./threadMessageSearch";
import { useKeybindings } from "../keybindings/store";
// Ported from pingdotgg/t3code v0.0.45 components/CommandPalette.tsx (MIT).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  CommandIcon,
  FolderIcon,
  FolderPlusIcon,
  FolderGit2Icon,
  GithubIcon,
  MessageSquareDashedIcon,
  MessageSquareIcon,
} from "lucide-react";
import {
  ipc,
  onThreadSearchInvalidated,
  type BrowseDirectory,
  type Workspace,
  type WorkspaceView,
} from "../ipc";
import {
  actionLabel,
  actions,
  runAction,
  shortcutLabel,
  paletteBindings,
  type ActionContext,
  type ActionId,
  type PalettePage,
} from "../lib/actions";
import { Dialog } from "../ui/dialog";
import { Checkbox } from "../ui/checkbox";
import { notifyProject } from "../project/ProjectToasts";
import { ProjectCloneFlow } from "../project/ProjectCloneFlow";
import { newProjectFolderName } from "../project/newProject";
import { Button } from "../ui/controls";
import { CommandFooterAction } from "../ui/command";
import { Kbd, KbdGroup } from "../ui/kbd";
import { WorkspaceBadge } from "../ProjectBadge";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../keybindings/keyboard";
import { THREAD_JUMP_KEYBINDING_COMMANDS } from "../keybindings/rules";
import { currentShortcutContext } from "../lib/shortcutContext";
import { isMacPlatform } from "../lib/utils";
import {
  browsePath,
  directoryQuery,
  filterBrowseEntries,
} from "./projectNavigation";
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
type BrowseStatus =
  | { kind: "loading" }
  | { kind: "ready"; result: BrowseDirectory }
  | { kind: "error"; message: string };
export function CommandPalette({
  initialPage,
  context,
  blocked,
  threads,
  workspaces,
  workspacesLoading,
  workspacesError,
  onRetryWorkspaces,
  onNewThread,
  onOpenRepository,
  onChooseRepository,
  onClose,
  onSelectThread,
}: {
  initialPage: Exclude<PalettePage, "archive-actions" | "project-local">;
  context: ActionContext;
  blocked: boolean;
  threads: SearchThread[];
  workspaces: Workspace[];
  workspacesLoading: boolean;
  workspacesError: string | undefined;
  onRetryWorkspaces: () => void;
  onNewThread: (workspaceId: string) => boolean;
  onOpenRepository: (path: string, isCurrent: () => boolean) => Promise<void>;
  onChooseRepository: (
    defaultPath: string | undefined,
  ) => Promise<string | null>;
  onClose: (restoreFocus: boolean) => void;
  onSelectThread: (workspaceId: string, threadId: string) => void;
}) {
  useKeybindings();
  const [location, setLocation] = useState<Location>({ kind: initialPage });
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<string>();
  const [browse, setBrowse] = useState<BrowseStatus>({ kind: "loading" });
  const [operationError, setOperationError] = useState<string>();
  const [pending, setPending] = useState<
    "adding" | "choosing" | "creating" | null
  >(null);
  const [publishOnCreate, setPublishOnCreate] = useState(false);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const browseGeneration = useRef(0);
  const pendingGeneration = useRef<number | null>(null);
  const mounted = useRef(true);
  const [messageSearch, setMessageSearch] = useState<MessageSearchState>({
    kind: "idle",
  });
  const [searchClosed, setSearchClosed] = useState(false);
  const [messageController] = useState(
    () =>
      new ThreadMessageSearchController(
        ipc.searchThreadMessages,
        setMessageSearch,
      ),
  );
  const client = useQueryClient();
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // ModalDialog's child layout effect calls showModal before this ancestor effect.
    root.current
      ?.querySelector<HTMLInputElement>('[data-slot="autocomplete-input"]')
      ?.focus();
  }, [location, retry]);
  const isBrowsing = location.kind === "project-local";
  const isNewProject = location.kind === "project-new";
  const projectsRoot = useQuery({
    queryKey: ["new-projects-root"],
    queryFn: ipc.newProjectsRoot,
    enabled: isNewProject,
  });
  const github = useQuery({
    queryKey: ["github-publish-readiness"],
    queryFn: ipc.githubPublishReadiness,
    enabled: isNewProject,
  });
  const newPath = projectsRoot.data
    ? `${projectsRoot.data.replace(/[\\/]$/, "")}/${newProjectFolderName(query.trim())}`
    : null;
  const cwd =
    context.workspace?.kind === "repository"
      ? context.workspace.root
      : undefined;
  const path = browsePath(query, cwd);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);
  useEffect(() => {
    if (!isBrowsing || blocked) return;
    const view = generation.current;
    const current = ++browseGeneration.current;
    if (path.kind === "error") {
      setBrowse({ kind: "error", message: path.message });
      return;
    }
    setBrowse({ kind: "loading" });
    void ipc.browseDirectory(path.directory, cwd).then(
      (result) => {
        if (
          mounted.current &&
          view === generation.current &&
          current === browseGeneration.current
        )
          setBrowse({ kind: "ready", result });
      },
      (error: unknown) => {
        if (
          mounted.current &&
          view === generation.current &&
          current === browseGeneration.current
        )
          setBrowse({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => {
      browseGeneration.current += 1;
    };
  }, [isBrowsing, query, cwd, retry, blocked]);
  const invalidateView = () => {
    generation.current += 1;
    pendingGeneration.current = null;
    setPending(null);
    setOperationError(undefined);
  };
  const close = (restoreFocus: boolean) => {
    invalidateView();
    messageController.cancel();
    setSearchClosed(true);
    onClose(restoreFocus);
  };
  const changeQuery = (next: string) => {
    invalidateView();
    if (isBrowsing) setBrowse({ kind: "loading" });
    setQuery(next);
    setHighlighted(undefined);
  };
  const addRepository = async (
    selectedPath?: string,
    current = generation.current,
  ) => {
    if (blocked || pendingGeneration.current !== null) return;
    pendingGeneration.current = current;
    setPending("adding");
    setOperationError(undefined);
    const isCurrent = () => mounted.current && current === generation.current;
    try {
      const exact = selectedPath ?? (path.kind === "path" ? path.exact : null);
      if (!exact)
        throw new Error(
          path.kind === "error" ? path.message : "Enter a directory path.",
        );
      const resolved =
        selectedPath ?? (await ipc.browseDirectory(exact, cwd)).path;
      if (!isCurrent()) return;
      await onOpenRepository(resolved, isCurrent);
    } catch (error: unknown) {
      if (isCurrent())
        setOperationError(
          error instanceof Error ? error.message : String(error),
        );
    } finally {
      if (isCurrent()) {
        pendingGeneration.current = null;
        setPending(null);
      }
    }
  };
  const chooseRepository = async () => {
    if (blocked || pendingGeneration.current !== null) return;
    const current = generation.current;
    pendingGeneration.current = current;
    setPending("choosing");
    setOperationError(undefined);
    try {
      const selected = await onChooseRepository(
        browse.kind === "ready" ? browse.result.path : undefined,
      );
      if (!mounted.current || current !== generation.current) return;
      pendingGeneration.current = null;
      setPending(null);
      if (selected !== null) await addRepository(selected, current);
    } catch (error: unknown) {
      if (mounted.current && current === generation.current)
        setOperationError(
          error instanceof Error ? error.message : String(error),
        );
    } finally {
      if (mounted.current && current === generation.current) {
        pendingGeneration.current = null;
        setPending(null);
        // Wait for the native chooser to restore window focus.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (!mounted.current || current !== generation.current) return;
            root.current
              ?.querySelector<HTMLInputElement>(
                '[data-slot="autocomplete-input"]',
              )
              ?.focus();
          }),
        );
      }
    }
  };
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
    if (pending === "creating") return;
    invalidateView();
    setLocation(next);
    setQuery(next.kind === "project-local" ? "~/" : "");
    setBrowse({ kind: "loading" });
    setHighlighted(undefined);
    setPublishOnCreate(false);
  };
  const createProject = async () => {
    if (
      blocked ||
      pendingGeneration.current !== null ||
      !query.trim() ||
      query.trim().length > 200
    )
      return;
    const current = generation.current;
    pendingGeneration.current = current;
    setPending("creating");
    setOperationError(undefined);
    try {
      const name = query.trim();
      const result = await ipc.createNewProject(name);
      notifyProject(
        result.commitError ? "warning" : "success",
        result.commitError
          ? `Created ${name} without a first commit`
          : `Created ${name}`,
        result.commitError
          ? `${result.commitError} The project is in ${result.workspace.root}.`
          : result.workspace.root,
      );
      if (publishOnCreate && github.data?.kind === "ready") {
        const repository = `${github.data.account}/${result.workspace.root.split(/[\\/]/).at(-1)}`;
        void ipc
          .publishRepository(
            { workspaceId: result.workspace.id },
            {
              repository,
              visibility: "private",
              remoteName: "origin",
              protocol: "ssh",
            },
          )
          .then(
            (outcome) => {
              if (outcome.kind === "succeeded")
                notifyProject(
                  "success",
                  "Published to GitHub",
                  outcome.result.repository.nameWithOwner,
                );
              else
                notifyProject(
                  "error",
                  "Could not create the GitHub repository",
                  `${outcome.message} Use Publish Repository in the Git menu to try again.`,
                );
            },
            (error: unknown) =>
              notifyProject(
                "error",
                "Could not create the GitHub repository",
                `${error instanceof Error ? error.message : String(error)} Use Publish Repository in the Git menu to try again.`,
              ),
          );
      }
      await client.invalidateQueries({ queryKey: ["workspaces"] });
      if (mounted.current && current === generation.current) {
        onNewThread(result.workspace.id);
        close(false);
      }
    } catch (error: unknown) {
      if (mounted.current && current === generation.current)
        setOperationError(
          error instanceof Error ? error.message : String(error),
        );
    } finally {
      if (mounted.current && current === generation.current) {
        pendingGeneration.current = null;
        setPending(null);
      }
    }
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
      close(
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
  const requestedQuery = contentQuery(
    needle,
    location.kind === "root" && !actionsOnly && !blocked && !searchClosed,
  );
  useLayoutEffect(() => {
    messageController.update(requestedQuery);
    return () => messageController.cancel();
  }, [messageController, requestedQuery]);
  useEffect(() => {
    const offInvalidated = onThreadSearchInvalidated((change) =>
      messageController.invalidate(change),
    );
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (
        event.type === "updated" &&
        event.action.type === "invalidate" &&
        event.query.queryKey[0] === "workspace" &&
        typeof event.query.queryKey[1] === "string"
      )
        messageController.invalidate({
          kind: "workspace",
          workspaceId: event.query.queryKey[1],
        });
    });
    return () => {
      offInvalidated();
      unsubscribe();
    };
  }, [messageController, client]);
  const activeMessageSearch: MessageSearchState =
    requestedQuery !== null &&
    messageSearch.kind !== "idle" &&
    messageSearch.query === requestedQuery
      ? messageSearch
      : { kind: "idle" };
  const loadedWorkspaceIds = new Set(
    client
      .getQueriesData<WorkspaceView>({ queryKey: ["workspace"] })
      .flatMap(([, view]) => (view ? [view.workspace.id] : [])),
  );
  const matches = searchThreads(
    threads,
    activeMessageSearch.kind === "ready"
      ? activeMessageSearch.result.matches
      : [],
    needle,
    loadedWorkspaceIds,
  );
  const threadItems: PaletteItem[] = (
    needle.trim() ? matches : matches.slice(0, 12)
  ).map((row) => ({
    id: `command-thread-${row.thread.id}`,
    title: row.thread.title,
    icon: <MessageSquareIcon className="size-4 text-icon-muted" />,
    description: row.workspaceLabel,
    threadContentMatch: row.excerpt,
    execute: () => {
      flushSync(() => close(false));
      onSelectThread(row.workspaceId, row.thread.id);
    },
  }));
  const bindings = paletteBindings();
  const shortcutContext = currentShortcutContext();
  const projectItems: PaletteItem[] = [
    ...workspaces
      .filter((workspace) => workspace.kind === "repository")
      .sort(
        (left, right) =>
          Number(right.id === context.workspace?.id) -
          Number(left.id === context.workspace?.id),
      )
      .map(
        (workspace): PaletteItem => ({
          id: `command-project-${workspace.id}`,
          title: workspace.label,
          description: (
            <span className="flex min-w-0 items-center gap-1">
              <span className="inline-flex min-w-0 items-center gap-1">
                <span className="truncate">Local</span>
              </span>
              <span aria-hidden="true">·</span>
              <span className="truncate">{workspace.root}</span>
            </span>
          ),
          icon: (
            <WorkspaceBadge workspace={workspace} className="size-4 shrink-0" />
          ),
          execute: () => {
            if (!onNewThread(workspace.id))
              setOperationError("This project is no longer available.");
          },
        }),
      ),
    ...(context.scratchAvailable
      ? [
          {
            id: "command-project-no-project",
            title: "No project",
            icon: (
              <MessageSquareDashedIcon className="size-4 text-icon-muted" />
            ),
            execute: () => {
              flushSync(() => close(false));
              context.startScratch();
            },
          },
        ]
      : []),
  ]
    .filter((item) =>
      matchesSearch(
        `${item.title} ${workspaces.find((workspace) => item.id === `command-project-${workspace.id}`)?.root ?? ""} ${item.id === "command-project-no-project" ? "without project none" : "Local"}`,
        needle,
      ),
    )
    .map((item, index) => ({
      ...item,
      shortcut: THREAD_JUMP_KEYBINDING_COMMANDS[index]
        ? (shortcutLabelForCommand(
            bindings,
            THREAD_JUMP_KEYBINDING_COMMANDS[index] ?? "",
            { context: shortcutContext },
          ) ?? undefined)
        : undefined,
    }));
  const browseItems: PaletteItem[] =
    isBrowsing && browse.kind === "ready" && path.kind === "path"
      ? [
          ...(browse.result.parentPath
            ? [
                {
                  id: "command-browse-up",
                  title: "..",
                  icon: <ArrowUpIcon className="size-4 text-icon-muted" />,
                  execute: () => {
                    if (browse.result.parentPath)
                      changeQuery(directoryQuery(browse.result.parentPath));
                  },
                },
              ]
            : []),
          ...filterBrowseEntries(browse.result.entries, path.leaf).map(
            (entry) => ({
              id: `command-browse-${entry.fullPath}`,
              title: entry.name,
              icon: <FolderIcon className="size-4 text-icon-muted" />,
              execute: () => changeQuery(directoryQuery(entry.fullPath)),
            }),
          ),
        ]
      : [];
  const groups: PaletteGroup[] = blocked
    ? []
    : location.kind === "new-thread-in"
      ? [{ label: "Projects", items: projectItems }]
      : isNewProject
        ? [
            {
              label: "Options",
              items:
                github.data?.kind === "ready"
                  ? [
                      {
                        id: "command-new-project-github",
                        title: "Create private repository on GitHub",
                        description: `${github.data.account}/${newProjectFolderName(query.trim())}`,
                        icon: <GithubIcon className="size-4 text-icon-muted" />,
                        trailing: (
                          <Checkbox
                            tabIndex={-1}
                            aria-hidden
                            checked={publishOnCreate}
                            label="Create private repository on GitHub"
                            onCheckedChange={() => {}}
                          />
                        ),
                        execute: () => {
                          if (pending !== "creating")
                            setPublishOnCreate((value) => !value);
                        },
                      },
                    ]
                  : [],
            },
            {
              label: "",
              items: [
                {
                  id: "command-new-project-existing",
                  title: "Add existing project",
                  description: "Open a folder or clone a repository",
                  icon: <FolderPlusIcon className="size-4 text-icon-muted" />,
                  submenu: true,
                  execute: () => changeLocation({ kind: "project-sources" }),
                },
              ],
            },
          ]
        : location.kind === "project-sources"
          ? [
              {
                label: "Sources",
                items: [
                  ...(matchesSearch(
                    "New project Start a new Git repository from a name create empty git init",
                    needle,
                  )
                    ? [
                        {
                          id: "command-source-new",
                          title: "New project",
                          description: "Start a new Git repository from a name",
                          icon: (
                            <FolderGit2Icon className="size-4 text-icon-muted" />
                          ),
                          submenu: true,
                          execute: () =>
                            changeLocation({ kind: "project-new" }),
                        },
                      ]
                    : []),
                  ...(matchesSearch(
                    "Local folder Browse a folder on disk directory",
                    needle,
                  )
                    ? [
                        {
                          id: "command-source-local",
                          title: "Local folder",
                          description: "Browse a folder on disk",
                          icon: (
                            <FolderPlusIcon className="size-4 text-icon-muted" />
                          ),
                          submenu: true,
                          execute: () =>
                            changeLocation({ kind: "project-local" }),
                        },
                      ]
                    : []),
                  ...(matchesSearch(
                    "Git URL Clone from a remote URL repository",
                    needle,
                  )
                    ? [
                        {
                          id: "command-source-git-url",
                          title: "Git URL",
                          description: "Clone from a remote URL",
                          icon: (
                            <GithubIcon className="size-4 text-icon-muted" />
                          ),
                          submenu: true,
                          execute: () =>
                            changeLocation({ kind: "project-clone" }),
                        },
                      ]
                    : []),
                ],
              },
            ]
          : location.kind === "project-local"
            ? [{ label: "Directories", items: browseItems }]
            : location.kind === "archived"
              ? [
                  {
                    label: "Archived threads",
                    items: archived
                      .filter(({ thread }) =>
                        matchesSearch(thread.title, needle),
                      )
                      .map(({ thread, workspace }) => ({
                        id: `command-archive-${thread.id}`,
                        title: thread.title,
                        description: workspace?.label,
                        icon: (
                          <ArchiveIcon className="size-4 text-icon-muted" />
                        ),
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
                            : (archiveTarget?.title ??
                              "Archived thread unavailable"),
                      items: actionItems,
                    },
                  ];
  const items = groups.flatMap((group) => group.items);
  const active =
    items.find((item) => item.id === highlighted) ??
    (isBrowsing ? undefined : items[0]);
  useEffect(() => {
    if (active)
      document.getElementById(active.id)?.scrollIntoView({ block: "nearest" });
  }, [active?.id]);
  const back = () =>
    changeLocation({
      kind:
        location.kind === "archive-actions"
          ? "archived"
          : location.kind === "project-local"
            ? "project-sources"
            : location.kind === "project-new"
              ? "project-sources"
              : "root",
    });
  const archivesLoading =
    archivesOpen && archiveQueries.some((query) => query.isPending);
  const archivesFailed =
    archivesOpen && archiveQueries.some((query) => query.isError);
  if (location.kind === "project-clone")
    return (
      <ProjectCloneFlow
        cwd={cwd}
        blocked={blocked}
        onBack={() => changeLocation({ kind: "project-sources" })}
        onClose={() => close(true)}
        onStarted={async (workspace) => {
          await client.invalidateQueries({ queryKey: ["workspaces"] });
          await client.invalidateQueries({ queryKey: ["project-clones"] });
          if (mounted.current) {
            onNewThread(workspace.id);
            close(false);
          }
        }}
      />
    );
  return (
    <Dialog
      open
      variant="command"
      onOpenChange={(open) => {
        if (!open) close(true);
      }}
    >
      <div
        ref={root}
        className="flex min-h-0 flex-1 flex-col"
        data-testid="command-palette"
      >
        <CommandPaletteContent
          footerActionLabel={
            isBrowsing && !active
              ? undefined
              : active?.submenu
                ? "Open"
                : "Select"
          }
          showBackHint={location.kind !== "root"}
          inputAccessory={
            isNewProject ? (
              <Button
                variant="outline"
                size="xs"
                tabIndex={-1}
                className="absolute inset-e-2.5 top-1/2 -translate-y-1/2"
                aria-label="Create (Enter)"
                disabled={
                  blocked ||
                  pending !== null ||
                  !query.trim() ||
                  query.trim().length > 200 ||
                  !projectsRoot.data
                }
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void createProject()}
              >
                <span>{pending === "creating" ? "Creating" : "Create"}</span>
                <KbdGroup className="pointer-events-none -me-0.5">
                  <Kbd>Enter</Kbd>
                </KbdGroup>
              </Button>
            ) : isBrowsing ? (
              <Button
                variant="outline"
                size="xs"
                tabIndex={-1}
                className="absolute inset-e-2.5 top-1/2 -translate-y-1/2"
                aria-label={`Add (${active ? (isMacPlatform(navigator.platform) ? "⌘ Enter" : "Ctrl Enter") : "Enter"})`}
                disabled={
                  blocked ||
                  pending !== null ||
                  path.kind === "error" ||
                  browse.kind === "loading"
                }
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void addRepository()}
              >
                <span>{pending === "adding" ? "Adding" : "Add"}</span>
                <KbdGroup className="pointer-events-none -me-0.5">
                  <Kbd>
                    {active
                      ? isMacPlatform(navigator.platform)
                        ? "⌘ Enter"
                        : "Ctrl Enter"
                      : "Enter"}
                  </Kbd>
                </KbdGroup>
              </Button>
            ) : undefined
          }
          footerTrailing={
            isBrowsing ? (
              <CommandFooterAction
                disabled={blocked || pending !== null}
                onClick={() => void chooseRepository()}
              >
                Open in Finder
              </CommandFooterAction>
            ) : undefined
          }
          inputProps={{
            className:
              isBrowsing || isNewProject
                ? "*:data-[slot=autocomplete-input]:pe-32!"
                : undefined,
            ...(location.kind !== "root"
              ? {
                  startAddon: (
                    <button
                      type="button"
                      className="flex cursor-pointer items-center"
                      aria-label="Back"
                      onClick={back}
                    >
                      <ArrowLeftIcon />
                    </button>
                  ),
                }
              : {}),
            value: query,
            onChange: (event) => {
              changeQuery(event.target.value);
            },
            placeholder: isNewProject
              ? "Project name"
              : location.kind === "root"
                ? "Search threads or type > for actions…"
                : location.kind === "new-thread-in"
                  ? "New thread in…"
                  : location.kind === "project-sources"
                    ? "Add project from…"
                    : location.kind === "project-local"
                      ? "Enter a directory path…"
                      : location.kind === "archived"
                        ? "Search archived threads…"
                        : "Search actions…",
            "aria-label": isBrowsing
              ? "Project directory path"
              : "Search commands and threads",
            role: "combobox",
            "aria-autocomplete": "list",
            "aria-expanded": true,
            "aria-controls": "command-palette-results",
            "aria-activedescendant": active?.id,
            onKeyDown: (event) => {
              if (event.nativeEvent.isComposing) return;
              if (isNewProject && event.key === "Enter") {
                event.preventDefault();
                if (!event.repeat) void createProject();
                return;
              }
              if (location.kind === "new-thread-in") {
                const command = resolveShortcutCommand(event, bindings, {
                  context: shortcutContext,
                });
                const jumpIndex = THREAD_JUMP_KEYBINDING_COMMANDS.indexOf(
                  command ?? "",
                );
                if (jumpIndex !== -1) {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!blocked && !event.repeat) items[jumpIndex]?.execute();
                  return;
                }
              }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const index = items.findIndex((item) => item.id === active?.id);
                const next =
                  items[
                    ((index === -1 && event.key === "ArrowUp" ? 0 : index) +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      items.length) %
                      items.length
                  ];
                setHighlighted(next?.id);
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (!event.repeat) {
                  const primaryModifier = isMacPlatform(navigator.platform)
                    ? event.metaKey && !event.ctrlKey
                    : event.ctrlKey && !event.metaKey;
                  if (isBrowsing && (!active || primaryModifier))
                    void addRepository();
                  else active?.execute();
                }
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
          {isNewProject && projectsRoot.data ? (
            <div className="p-2 pb-0">
              <div className="flex min-h-8 items-center gap-2 rounded-sm px-2 py-1.5">
                <FolderGit2Icon className="size-4 text-icon-muted" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-foreground text-sm">
                    {query.trim() || "New project"}
                  </span>
                  <span className="truncate text-muted-foreground/85 text-xs">
                    {query.trim()
                      ? `Creates ${newPath}`
                      : `Goes in ${projectsRoot.data}`}
                  </span>
                </span>
              </div>
            </div>
          ) : null}
          {isNewProject && projectsRoot.isError ? (
            <div
              role="alert"
              className="px-4 py-2 text-sm text-error-foreground"
            >
              Could not load the projects folder.{" "}
              <button onClick={() => void projectsRoot.refetch()}>Retry</button>
            </div>
          ) : null}
          {operationError || (isBrowsing && browse.kind === "error") ? (
            <div
              role="alert"
              className="px-4 py-2 text-sm text-error-foreground"
            >
              {operationError ??
                (browse.kind === "error" ? browse.message : "")}
              {!operationError && browse.kind === "error" ? (
                <>
                  {" "}
                  <button
                    type="button"
                    onClick={() => {
                      invalidateView();
                      setRetry((value) => value + 1);
                    }}
                  >
                    Retry
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
          {location.kind === "new-thread-in" && workspacesError ? (
            <div
              role="alert"
              className="px-4 py-2 text-sm text-error-foreground"
            >
              Could not load all projects.{" "}
              <button type="button" onClick={onRetryWorkspaces}>
                Retry
              </button>
            </div>
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
          {activeMessageSearch.kind === "loading" ? (
            <p
              role="status"
              className="px-4 py-2 text-xs text-muted-foreground"
            >
              Searching messages…
            </p>
          ) : null}
          {activeMessageSearch.kind === "error" ? (
            <div
              role="alert"
              className="px-4 py-2 text-sm text-error-foreground"
            >
              Could not search saved messages. {activeMessageSearch.message}{" "}
              <button type="button" onClick={() => messageController.retry()}>
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
                : isNewProject
                  ? ""
                  : isBrowsing
                    ? browse.kind === "loading"
                      ? "Loading directories…"
                      : browse.kind === "error"
                        ? "Could not browse this directory."
                        : "No matching directories."
                    : location.kind === "new-thread-in"
                      ? workspacesLoading
                        ? "Loading projects…"
                        : "No matching projects."
                      : location.kind === "project-sources"
                        ? "No matching sources."
                        : archivesLoading
                          ? "Loading archived threads…"
                          : location.kind === "archived"
                            ? "No archived threads found."
                            : location.kind === "archive-actions" &&
                                !archiveTarget
                              ? "This archived thread is no longer available."
                              : actionsOnly
                                ? "No matching actions."
                                : activeMessageSearch.kind === "loading"
                                  ? "Searching messages…"
                                  : activeMessageSearch.kind === "error"
                                    ? "Message search unavailable. Title and action matches remain available."
                                    : "No matching threads or actions."
            }
          />
          {location.kind === "root" && !actionsOnly ? (
            <p className="px-4 pb-2 text-xs text-muted-foreground">
              {Array.from(needle.trim()).length > 200
                ? "Message search accepts up to 200 characters. Titles and actions still match."
                : activeMessageSearch.kind === "ready" &&
                    activeMessageSearch.result.hasMore
                  ? "Showing 50 saved message matches. Refine your search for more."
                  : "Searches all thread titles and saved conversations."}
            </p>
          ) : null}
        </CommandPaletteContent>
      </div>
    </Dialog>
  );
}
