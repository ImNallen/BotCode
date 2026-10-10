// Local Git URL flow ports T3 Code v0.0.45 components/CommandPalette.tsx (MIT).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  ArrowUpIcon,
  FolderIcon,
  GitBranchIcon,
} from "lucide-react";
import { ipc, type Workspace } from "../ipc";
import { Dialog } from "../ui/dialog";
import { Button } from "../ui/controls";
import { Kbd, KbdGroup } from "../ui/kbd";
import { CommandPaletteContent } from "../command/CommandPaletteContent";
import {
  CommandPaletteResults,
  type PaletteItem,
} from "../command/CommandPaletteResults";
import {
  browsePath,
  directoryQuery,
  filterBrowseEntries,
} from "../command/projectNavigation";
import { cloneFolder } from "./clones";

type Flow =
  | { kind: "repository" }
  | { kind: "destination"; remoteUrl: string; folder: string };
export function ProjectCloneFlow({
  cwd,
  blocked,
  onBack,
  onClose,
  onStarted,
}: {
  cwd?: string;
  blocked: boolean;
  onBack: () => void;
  onClose: () => void;
  onStarted: (workspace: Workspace) => Promise<void>;
}) {
  const [flow, setFlow] = useState<Flow>({ kind: "repository" });
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    root.current
      ?.querySelector<HTMLInputElement>('[data-slot="autocomplete-input"]')
      ?.focus();
  }, [flow.kind]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const submitted = useRef(false);
  const mounted = useRef(true);
  const [highlighted, setHighlighted] = useState<string>();
  const path = browsePath(query, cwd);
  const browse = useQuery({
    queryKey: [
      "clone-destination-browse",
      path.kind === "path" ? path.directory : null,
      cwd,
    ],
    queryFn: () =>
      path.kind === "path"
        ? ipc.browseDirectory(path.directory, cwd)
        : Promise.reject(new Error(path.message)),
    enabled: flow.kind === "destination" && path.kind === "path",
    retry: false,
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const name = flow.kind === "destination" ? flow.folder : "";
  const items: PaletteItem[] =
    flow.kind === "destination" && path.kind === "path" && browse.data
      ? [
          ...(browse.data.parentPath
            ? [
                {
                  id: "clone-directory-up",
                  title: "..",
                  icon: <ArrowUpIcon className="size-4 text-icon-muted" />,
                  execute: () =>
                    setQuery(
                      `${directoryQuery(browse.data?.parentPath ?? "")}${name}`,
                    ),
                },
              ]
            : []),
          ...filterBrowseEntries(browse.data.entries, path.leaf).map(
            (entry) => ({
              id: `clone-directory-${entry.fullPath}`,
              title: entry.name,
              icon: <FolderIcon className="size-4 text-icon-muted" />,
              execute: () =>
                setQuery(`${directoryQuery(entry.fullPath)}${name}`),
            }),
          ),
        ]
      : [];
  const active = items.find((item) => item.id === highlighted);
  const exactExists =
    path.kind === "path" &&
    browse.data?.entries.some((entry) => entry.name === path.leaf);
  const label =
    flow.kind === "repository"
      ? "Continue"
      : exactExists
        ? "Clone"
        : "Create & Clone";
  const back = () => {
    if (pending) return;
    if (flow.kind === "repository") onBack();
    else {
      setQuery(flow.remoteUrl);
      setFlow({ kind: "repository" });
      setError(undefined);
    }
  };
  const submit = async () => {
    if (blocked || submitted.current || !query.trim()) return;
    if (flow.kind === "repository") {
      const folder = cloneFolder(query);
      setFlow({ kind: "destination", remoteUrl: query.trim(), folder });
      setQuery(`~/${folder}`);
      setHighlighted(undefined);
      return;
    }
    if (path.kind === "error") {
      setError(path.message);
      return;
    }
    submitted.current = true;
    setPending(true);
    setError(undefined);
    try {
      const directory = await ipc.browseDirectory(path.directory, cwd);
      const destination = path.leaf
        ? `${directoryQuery(directory.path)}${path.leaf}`
        : directory.path;
      const result = await ipc.startProjectClone(flow.remoteUrl, destination);
      await onStarted(result.workspace);
    } catch (failure: unknown) {
      if (mounted.current)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      submitted.current = false;
      if (mounted.current) setPending(false);
    }
  };
  return (
    <Dialog
      open
      variant="command"
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <div
        ref={root}
        className="flex min-h-0 flex-1 flex-col"
        data-testid="project-clone-flow"
      >
        <CommandPaletteContent
          showBackHint
          footerActionLabel={active ? "Open" : undefined}
          inputAccessory={
            <Button
              variant="outline"
              size="xs"
              tabIndex={-1}
              className="absolute inset-e-2.5 top-1/2 -translate-y-1/2"
              aria-label={`${label} (Enter)`}
              disabled={blocked || pending || !query.trim()}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void submit()}
            >
              <span>{pending ? "Cloning" : label}</span>
              <KbdGroup className="pointer-events-none -me-0.5">
                <Kbd>Enter</Kbd>
              </KbdGroup>
            </Button>
          }
          inputProps={{
            className: "*:data-[slot=autocomplete-input]:pe-32!",
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
            value: query,
            placeholder:
              flow.kind === "repository"
                ? "Enter Git clone URL"
                : "Enter a directory path…",
            "aria-label":
              flow.kind === "repository"
                ? "Git clone URL"
                : "Clone destination",
            onChange: (event) => {
              if (!pending) {
                setQuery(event.target.value);
                setHighlighted(undefined);
                setError(undefined);
              }
            },
            onKeyDown: (event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                if (!event.repeat) {
                  if (active && !event.metaKey && !event.ctrlKey)
                    active.execute();
                  else void submit();
                }
              } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const index = items.findIndex(
                  (item) => item.id === highlighted,
                );
                setHighlighted(
                  items[
                    (index +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      items.length) %
                      items.length
                  ]?.id,
                );
              } else if (event.key === "Backspace" && !query) {
                event.preventDefault();
                back();
              }
            },
          }}
        >
          {flow.kind === "destination" ? (
            <div className="p-2 pb-0">
              <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
                Repository
              </div>
              <div className="flex min-h-8 items-center gap-2 rounded-sm px-2 py-1.5">
                <GitBranchIcon className="size-4 text-icon-muted" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-foreground text-sm">
                    {flow.folder}
                  </span>
                  <span className="truncate text-muted-foreground/85 text-xs">
                    {flow.remoteUrl}
                  </span>
                </span>
              </div>
            </div>
          ) : (
            <p className="px-4 py-2 text-sm text-muted-foreground">
              Enter a Git clone URL and press Enter to continue.
            </p>
          )}
          {error ? (
            <div
              role="alert"
              className="px-4 py-2 text-sm text-error-foreground"
            >
              {error}
            </div>
          ) : null}
          {flow.kind === "destination" ? (
            <CommandPaletteResults
              groups={[{ label: "Select where to clone", items }]}
              activeId={active?.id}
              onHighlight={setHighlighted}
              emptyMessage={
                browse.isPending
                  ? "Loading directories…"
                  : browse.error
                    ? browse.error.message
                    : "No matching directories."
              }
            />
          ) : null}
        </CommandPaletteContent>
      </div>
    </Dialog>
  );
}
