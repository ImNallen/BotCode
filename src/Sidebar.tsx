// Layout and classes follow pingdotgg/t3code v0.0.45 components/Sidebar.tsx,
// sidebar/SidebarChrome.tsx, sidebar/SidebarThreadHeader.tsx and ThreadStatusIndicators.tsx (MIT).
import { useState, type ComponentProps } from "react";
import {
  CircleDashedIcon,
  ShieldQuestionIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderPlusIcon,
  PlusIcon,
  SearchIcon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";
import type { Workspace, WorkspaceView } from "./ipc";
import { cn } from "./lib/cn";
import { formatSidebarTime } from "./lib/time";
import { basename } from "./panel/panelState";
import { WorkspaceBadge } from "./ProjectBadge";
import { OpenAI } from "./ui/icons";
import { Button } from "./ui/controls";
import { Menu, MenuItem } from "./ui/menu";

type Row = {
  workspace: Workspace;
  branch: string;
  thread: WorkspaceView["threads"][number];
};

const working = new Set(["connecting", "running", "interrupting"]);

const menuButton =
  "peer/menu-button flex w-full cursor-pointer items-center gap-[var(--sidebar-control-gap)] overflow-hidden text-left outline-hidden ring-ring transition-[width,height,padding] hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 active:bg-sidebar-row-active active:text-sidebar-foreground disabled:pointer-events-none disabled:opacity-64 aria-disabled:pointer-events-none aria-disabled:opacity-64 data-[active=true]:bg-sidebar-row-selected data-[active=true]:font-medium data-[active=true]:text-sidebar-foreground [&>span:last-child]:truncate [&>svg:not([class*='size-'])]:size-4 [&>svg]:shrink-0 [&>svg]:text-[var(--sidebar-icon-color)] hover:[&>svg]:text-sidebar-foreground active:[&>svg]:text-sidebar-foreground data-[active=true]:[&>svg]:text-sidebar-foreground";

function HeaderIconButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        menuButton,
        "justify-center rounded-[var(--control-radius)] p-0 font-medium text-sidebar-muted-foreground/80 relative size-7 shrink-0",
        className,
      )}
      {...props}
    />
  );
}

export function Sidebar({
  workspaces,
  views,
  workspaceId,
  threadId,
  onSelectThread,
  onSelectWorkspace,
  onNewThread,
  onOpenRepository,
}: {
  workspaces: Workspace[];
  views: (WorkspaceView | undefined)[];
  workspaceId: string | undefined;
  threadId: string | undefined;
  onSelectThread: (workspaceId: string, threadId: string) => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onNewThread: () => void;
  onOpenRepository: () => void;
}) {
  const [query, setQuery] = useState("");
  const rows: Row[] = views
    .flatMap((view) =>
      view
        ? view.threads.map((thread) => ({
            workspace: view.workspace,
            branch:
              thread.checkout.kind === "worktree"
                ? thread.checkout.branch
                : view.branch,
            thread,
          }))
        : [],
    )
    .sort((a, b) => (b.thread.updatedAtMs ?? 0) - (a.thread.updatedAtMs ?? 0));
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? rows.filter((row) => row.thread.title.toLowerCase().includes(needle))
    : rows;
  return (
    <>
      <div className="w-full shrink-0">
        <div className="relative flex w-full min-w-0 flex-col p-[var(--sidebar-content-inset)] z-[1]">
          <div className="flex items-center gap-1">
            <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground">
              <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
              <input
                type="search"
                placeholder="Search"
                aria-label="Search threads"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="min-w-0 flex-1 bg-transparent p-0 font-medium text-sidebar-foreground text-sm leading-normal outline-none placeholder:text-sidebar-muted-foreground [&::-webkit-search-cancel-button]:hidden"
              />
              {query ? (
                <Button
                  size="icon-micro"
                  variant="ghost-muted"
                  className="shrink-0"
                  aria-label="Clear thread search"
                  onClick={() => setQuery("")}
                >
                  <XIcon className="size-3" />
                </Button>
              ) : null}
            </label>
            <div className="flex shrink-0 items-center">
              {workspaces.length > 0 ? (
                <Menu
                  align="end"
                  trigger={(props) => (
                    <HeaderIconButton
                      aria-label="Select repository"
                      title="Select repository"
                      {...props}
                    >
                      <FolderIcon className="size-4" />
                    </HeaderIconButton>
                  )}
                >
                  {workspaces.map((workspace) => (
                    <MenuItem
                      key={workspace.id}
                      aria-current={workspace.id === workspaceId}
                      onClick={() => onSelectWorkspace(workspace.id)}
                    >
                      <WorkspaceBadge
                        workspace={workspace}
                        className="size-4"
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {workspace.label}
                      </span>
                    </MenuItem>
                  ))}
                </Menu>
              ) : null}
              {workspaces.length > 0 || rows.length > 0 ? (
                <HeaderIconButton
                  aria-label="Add project"
                  title="Add project"
                  onClick={onOpenRepository}
                >
                  <FolderPlusIcon />
                </HeaderIconButton>
              ) : null}
              <HeaderIconButton
                aria-label="New thread"
                title="New thread"
                disabled={!workspaceId}
                onClick={onNewThread}
              >
                <SquarePenIcon />
              </HeaderIconButton>
            </div>
          </div>
        </div>
      </div>
      <div className="h-auto min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex w-full min-w-0 flex-col [overflow-anchor:none] min-h-full">
          <div className="relative flex w-full min-w-0 flex-col p-[var(--sidebar-content-inset)] pt-0 flex-1">
            {visible.length > 0 ? (
              <ul className="relative flex flex-col gap-px flex-1">
                {visible.map((row) => (
                  <ThreadRow
                    key={row.thread.id}
                    row={row}
                    active={row.thread.id === threadId}
                    onSelect={() =>
                      onSelectThread(row.workspace.id, row.thread.id)
                    }
                  />
                ))}
              </ul>
            ) : (
              <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60">
                {needle ? (
                  "No matching threads"
                ) : workspaces.length === 0 ? (
                  <>
                    No projects yet
                    <button
                      type="button"
                      onClick={onOpenRepository}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-2xs font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                    >
                      <PlusIcon className="-mx-0.5 size-3" />
                      Add project
                    </button>
                  </>
                ) : (
                  "No threads yet"
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function ThreadRow({
  row,
  active,
  onSelect,
}: {
  row: Row;
  active: boolean;
  onSelect: () => void;
}) {
  const isWorking = working.has(row.thread.session.kind);
  const recede = !active;
  return (
    <li
      data-thread-item
      className="list-none py-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_78px]"
    >
      <div
        role="button"
        tabIndex={0}
        aria-current={active ? "page" : undefined}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect();
          }
        }}
        className={cn(
          "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          active
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : recede
              ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
              : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
          recede &&
            isWorking &&
            "opacity-70 transition-opacity hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none",
        )}
      >
        <span className="sr-only">{row.thread.title}</span>
        <div className="relative z-10 h-[4.875rem] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)">
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            <WorkspaceBadge
              workspace={row.workspace}
              className="size-4 shrink-0"
            />
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-secondary-label text-xs",
                recede ? "font-normal" : "font-medium",
              )}
            >
              {row.workspace.label}
            </span>
            <span className="group/sidebar-status-slot relative ml-auto flex h-5 min-w-8 shrink-0 items-stretch justify-end text-xs">
              <span className="pointer-events-none flex items-center self-center justify-self-end tabular-nums text-secondary-label transition-opacity">
                {row.thread.awaitingApproval ? (
                  <span className="inline-flex items-center gap-1 font-medium text-warning-foreground">
                    <ShieldQuestionIcon
                      aria-hidden
                      className="size-4 shrink-0"
                    />
                    <span role="status">Approval</span>
                  </span>
                ) : isWorking ? (
                  <span className="inline-flex items-center gap-1 font-medium text-info">
                    <CircleDashedIcon aria-hidden className="size-4 shrink-0" />
                    <span role="status">Working</span>
                  </span>
                ) : row.thread.updatedAtMs !== null ? (
                  formatSidebarTime(row.thread.updatedAtMs)
                ) : null}
              </span>
            </span>
          </div>
          <div className="mt-1 flex min-w-0">
            <span
              aria-hidden
              className={cn(
                "min-w-0 flex-1 text-sm transition-opacity motion-reduce:transition-none truncate",
                recede
                  ? "font-normal text-secondary-label"
                  : "font-medium text-foreground/90",
              )}
            >
              {row.thread.title}
            </span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs">
            {row.branch ? (
              <>
                {row.thread.checkout.kind === "worktree" ? (
                  <WorktreeIndicator {...row.thread.checkout} />
                ) : null}
                <span className="flex min-w-0 flex-1 text-muted-foreground/40">
                  <span className="inline-flex min-w-0 max-w-full overflow-hidden whitespace-nowrap">
                    <span className="min-w-0 truncate">{row.branch}</span>
                  </span>
                </span>
              </>
            ) : (
              <span className="flex-1" />
            )}
            <span
              aria-hidden
              className="pointer-events-none ml-auto inline-flex shrink-0 items-center gap-1"
            >
              <span className="inline-flex shrink-0 items-center">
                <OpenAI className="size-3.5 opacity-60" />
              </span>
            </span>
          </div>
        </div>
      </div>
    </li>
  );
}

function WorktreeIndicator({ path, branch }: { path: string; branch: string }) {
  const label = `Worktree: ${basename(path)} (${branch})`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="inline-flex items-center justify-center"
    >
      <FolderGit2Icon className="size-3 text-muted-foreground/40" />
    </span>
  );
}

export function SidebarBrand() {
  return (
    <div
      data-tauri-drag-region="deep"
      className="@container/sidebar-header relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 px-3 md:px-0 drag-region"
    >
      <span className="relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md md:flex text-foreground">
        <span className="inline-flex min-w-0 items-baseline gap-1 text-sm font-medium tracking-tight">
          <span className="shrink-0 font-bold">Z1</span>
          <span className="truncate [text-box:trim-both_cap_alphabetic] text-muted-foreground">
            Code
          </span>
        </span>
      </span>
    </div>
  );
}
