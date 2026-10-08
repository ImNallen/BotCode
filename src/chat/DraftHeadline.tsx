// Ported from T3 Code v0.0.45 apps/web/src/components/chat/DraftHeroHeadline.tsx (MIT).
import { FolderPlusIcon } from "lucide-react";
import type { Workspace } from "../ipc";
import { WorkspaceBadge } from "../ProjectBadge";
import { useShortcutLabel } from "../lib/shortcuts";
import { Menu, MenuItem, MenuSeparator } from "../ui/menu";

export function DraftHeadline({
  label,
  workspaceId,
  workspaces,
  isScratch,
  scratchAvailable,
  onSelectWorkspace,
  onStartScratch,
  onOpenRepository,
}: {
  label: string;
  workspaceId: string;
  workspaces: Workspace[];
  isScratch: boolean;
  scratchAvailable: boolean;
  onSelectWorkspace: (workspaceId: string) => void;
  onStartScratch: () => void;
  onOpenRepository: () => void;
}) {
  const newWithoutProjectShortcut = useShortcutLabel("chat.newWithoutProject");
  const picker = (
    <Menu
      align="center"
      trigger={(props) => (
        <button
          type="button"
          className="inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap font-medium underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring gap-1.5 text-foreground underline decoration-foreground/30 decoration-dotted decoration-from-font hover:decoration-foreground hover:decoration-solid data-popup-open:decoration-foreground data-popup-open:decoration-solid pointer-events-auto max-w-64 align-baseline"
          {...props}
        >
          <span className="min-w-0 truncate">{label}</span>
        </button>
      )}
    >
      {scratchAvailable ? (
        <MenuItem aria-current={isScratch} onClick={onStartScratch}>
          <span className="flex min-w-0 items-center gap-2">
            <WorkspaceBadge
              workspace={{ kind: "scratch", label: "No project" }}
              className="size-4 shrink-0"
            />
            <span className="block min-w-0 truncate">No project</span>
          </span>
        </MenuItem>
      ) : null}
      {workspaces.map((workspace) => (
        <MenuItem
          key={workspace.id}
          aria-current={workspace.id === workspaceId}
          onClick={() => onSelectWorkspace(workspace.id)}
        >
          <span className="flex min-w-0 items-center gap-2">
            <WorkspaceBadge workspace={workspace} className="size-4 shrink-0" />
            <span className="block min-w-0 truncate">{workspace.label}</span>
          </span>
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem onClick={onOpenRepository}>
        <FolderPlusIcon />
        Add project
      </MenuItem>
    </Menu>
  );
  const heading = isScratch
    ? "What should we work on?"
    : `What should we build in ${label}?`;
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
      <h1
        aria-label={heading}
        className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl"
      >
        {isScratch ? (
          <>What should we work on?</>
        ) : (
          <>What should we build in {picker}?</>
        )}
      </h1>
      {isScratch || scratchAvailable ? (
        <p className="mt-2 flex h-6 items-center text-sm">
          {isScratch ? (
            picker
          ) : (
            <button
              type="button"
              title={newWithoutProjectShortcut}
              onClick={onStartScratch}
              className="inline-flex shrink-0 cursor-pointer items-center gap-0.5 whitespace-nowrap font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-64 text-muted-foreground hover:text-foreground pointer-events-auto"
            >
              or start without a project
            </button>
          )}
        </p>
      ) : null}
    </div>
  );
}
