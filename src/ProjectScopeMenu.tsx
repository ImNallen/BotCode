// Follows the project scope combobox in pingdotgg/t3code v0.0.45 components/Sidebar.tsx,
// with classes from components/ui/combobox.tsx (MIT).
import {
  useId,
  useLayoutEffect,
  useState,
  type ComponentProps,
  type RefObject,
} from "react";
import { FolderIcon, SearchIcon, SettingsIcon } from "lucide-react";
import type { Workspace } from "./ipc";
import { WorkspaceBadge } from "./ProjectBadge";
import { Button } from "./ui/controls";
import { Menu } from "./ui/menu";

type Item = Workspace | null;
const key = (item: Item) => item?.id ?? "all";
const label = (item: Item) => item?.label ?? "All projects";

export function ProjectScopeMenu({
  workspaces,
  scope,
  anchor,
  trigger,
  onScope,
  onOpenSettings,
}: {
  workspaces: Workspace[];
  scope: Workspace | undefined;
  anchor: RefObject<HTMLElement | null>;
  trigger: ComponentProps<typeof Menu>["trigger"];
  onScope: (workspaceId: string | null) => void;
  onOpenSettings: (workspaceId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<string>();
  const listId = useId();
  const needle = query.trim().toLowerCase();
  const filtered: Item[] = needle
    ? workspaces.filter((workspace) =>
        workspace.label.toLowerCase().includes(needle),
      )
    : [null, ...workspaces];
  const selected = key(scope ?? null);
  const active =
    filtered.find((item) => key(item) === highlighted) ??
    filtered.find((item) => key(item) === selected) ??
    filtered[0];
  const optionId = (item: Item) => `${listId}-${key(item)}`;
  useLayoutEffect(() => {
    if (open && active !== undefined)
      document
        .getElementById(optionId(active))
        ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);
  const choose = (item: Item) => {
    onScope(item?.id ?? null);
    setOpen(false);
  };
  const settings = (workspace: Workspace) => {
    setOpen(false);
    onOpenSettings(workspace.id);
  };
  return (
    <Menu
      align="start"
      anchor={anchor}
      trigger={trigger}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setQuery("");
        setHighlighted(undefined);
      }}
      popupKind={{ kind: "dialog", label: "Filter threads by project" }}
      className="max-w-[min(18rem,calc(100vw-2rem))] overflow-hidden"
      contentClassName="flex max-h-[23rem] flex-col overflow-hidden p-0 text-foreground"
    >
      <div className="min-w-0 shrink-0 px-3 pt-2.5">
        <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
          />
          <div className="[&_input]:h-6.5 [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-6.5">
            <input
              role="combobox"
              aria-label="Search projects"
              aria-expanded="true"
              aria-autocomplete="list"
              aria-controls={listId}
              aria-activedescendant={
                active === undefined ? undefined : optionId(active)
              }
              autoComplete="off"
              spellCheck={false}
              placeholder="Search projects..."
              value={query}
              className="w-full rounded-none bg-transparent text-sm outline-none"
              onChange={(event) => {
                setQuery(event.target.value);
                setHighlighted(undefined);
              }}
              onKeyDown={(event) => {
                if (
                  event.nativeEvent.isComposing ||
                  event.altKey ||
                  event.ctrlKey ||
                  event.metaKey
                )
                  return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (active !== undefined) choose(active);
                } else if (
                  event.key === "ContextMenu" ||
                  (event.shiftKey && event.key === "F10")
                ) {
                  event.preventDefault();
                  if (active) settings(active);
                } else if (
                  event.key === "ArrowDown" ||
                  event.key === "ArrowUp"
                ) {
                  event.preventDefault();
                  const index =
                    active === undefined ? -1 : filtered.indexOf(active);
                  const next =
                    filtered[
                      (index +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        filtered.length) %
                        filtered.length
                    ];
                  if (next !== undefined) setHighlighted(key(next));
                }
              }}
            />
          </div>
        </div>
      </div>
      {filtered.length === 0 ? (
        <div
          role="status"
          className="not-empty:p-2 text-center text-base text-muted-foreground sm:text-sm"
        >
          No matching projects.
        </div>
      ) : null}
      <div
        id={listId}
        role="listbox"
        aria-label="Projects"
        className="min-h-0 overflow-y-auto not-empty:scroll-py-1 not-empty:px-1 not-empty:py-1"
      >
        {filtered.map((item) => (
          <div
            key={key(item)}
            id={optionId(item)}
            role="option"
            aria-selected={key(item) === selected}
            data-highlighted={item === active ? "" : undefined}
            data-selected={key(item) === selected ? "" : undefined}
            className="flex min-h-8 cursor-pointer items-center rounded-sm px-2 py-1 text-base outline-none not-data-disabled:hover:bg-accent data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-selected:bg-foreground/[0.08] data-selected:text-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground [&[data-highlighted][data-selected]]:bg-accent [&[data-highlighted][data-selected]]:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0"
            onMouseMove={() => setHighlighted(key(item))}
            onClick={() => choose(item)}
            onContextMenu={(event) => {
              if (!item) return;
              event.preventDefault();
              settings(item);
            }}
          >
            <div className="flex min-w-0 flex-1 items-center gap-2 [&_svg:not([class*='text-'])]:text-muted-foreground">
              {item ? (
                <WorkspaceBadge workspace={item} className="size-4 shrink-0" />
              ) : (
                <FolderIcon className="size-4 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate text-sm">
                {label(item)}
              </span>
              {item ? (
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  tabIndex={-1}
                  aria-hidden="true"
                  title={`Project settings for ${item.label}`}
                  className="ml-auto"
                  onClick={(event) => {
                    event.stopPropagation();
                    settings(item);
                  }}
                >
                  <SettingsIcon className="size-3.5" />
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </Menu>
  );
}
