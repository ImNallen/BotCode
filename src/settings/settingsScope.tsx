// Follows pingdotgg/t3code v0.0.45 settings/SettingsScopeSentence.tsx, SettingsScopeNotice.tsx
// and the scope navigation in routes/settings.tsx, with picker classes from ui/button.tsx (MIT).
import { useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon } from "lucide-react";
import { ipc, native, type Workspace } from "../ipc";
import { WorkspaceBadge } from "../ProjectBadge";
import { Alert, AlertAction } from "../ui/alert";
import { Button, inlineButton } from "../ui/controls";
import {
  Menu,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
} from "../ui/menu";

export type SettingsScope =
  | { kind: "all" }
  | { kind: "project"; workspace: Workspace }
  | { kind: "unavailable" };

export function useSettingsScope() {
  const selection = useSearch({ from: "__root__" });
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ["workspaces"],
    queryFn: ipc.workspaces,
    enabled: native,
  });
  const list = query.data ?? [];
  const workspaces = [
    ...list.filter((workspace) => workspace.kind === "scratch"),
    ...list.filter((workspace) => workspace.kind === "repository"),
  ];
  const picked = workspaces.find(
    (workspace) => workspace.id === selection.project,
  );
  const scope: SettingsScope | undefined =
    selection.project === undefined
      ? { kind: "all" }
      : picked
        ? { kind: "project", workspace: picked }
        : query.isPending
          ? undefined
          : { kind: "unavailable" };
  const select = (project: string | undefined) =>
    void navigate({
      to: pathname,
      search: { ...selection, project },
      hash: "",
      resetScroll: false,
    });
  return { scope, workspaces, select };
}

export function SettingsScopeSentence() {
  const { scope, workspaces, select } = useSettingsScope();
  if (scope === undefined) return null;
  const selected = scope.kind === "project" ? scope.workspace : undefined;
  const label =
    selected?.label ??
    (scope.kind === "unavailable" ? "Unavailable project" : "All projects");
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 px-3 text-base text-muted-foreground sm:px-4">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0">Applying settings for</span>
        <Menu
          align="start"
          trigger={(props) => (
            <button
              type="button"
              {...props}
              aria-label={`Project scope: ${label}`}
              data-slot="inline-button"
              className={inlineButton({ tone: "picker" }, "min-w-0 max-w-72")}
            >
              {selected ? (
                <WorkspaceBadge
                  workspace={selected}
                  className="size-3.5 shrink-0"
                />
              ) : null}
              <span className="min-w-0 truncate">{label}</span>
              <ChevronDownIcon
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground"
              />
            </button>
          )}
        >
          <MenuRadioItem
            checked={scope.kind === "all"}
            onClick={() => select(undefined)}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate">All projects</span>
              <MenuRadioItemIndicator checked={scope.kind === "all"} />
            </span>
          </MenuRadioItem>
          <MenuSeparator />
          {workspaces.map((workspace) => (
            <MenuRadioItem
              key={workspace.id}
              checked={workspace === selected}
              onClick={() => select(workspace.id)}
            >
              <span className="flex min-w-0 items-center gap-2">
                <WorkspaceBadge workspace={workspace} className="size-3.5" />
                <span className="min-w-0 flex-1 truncate">
                  {workspace.label}
                </span>
                <MenuRadioItemIndicator checked={workspace === selected} />
              </span>
            </MenuRadioItem>
          ))}
        </Menu>
      </span>
    </p>
  );
}

export function SettingsScopeNotice({ children }: { children: string }) {
  const { workspaces, select } = useSettingsScope();
  return (
    <Alert role="status">
      <p>{children}</p>
      <AlertAction className="flex-wrap">
        {workspaces.map((workspace) => (
          <Button
            key={workspace.id}
            size="sm-multiline"
            variant="outline"
            className="max-w-full break-all text-left"
            onClick={() => select(workspace.id)}
          >
            {workspace.label}
          </Button>
        ))}
      </AlertAction>
    </Alert>
  );
}
