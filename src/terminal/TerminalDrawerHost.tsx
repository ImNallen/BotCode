// Ported from T3 Code v0.0.45 apps/web/src/components/ChatView.tsx mounted terminal drawers and ChatHeader.tsx host reparenting (MIT).
import {
  createContext,
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { FileLinks } from "../chat/ChatMarkdown";
import {
  type ComposerContextChannel,
  ComposerContextProvider,
  useComposerContext,
} from "../chat/ComposerContextProvider";
import { ErrorView } from "../errors/ErrorView";
import { RenderErrorBoundary } from "../errors/RenderErrorBoundary";
import { usePreferences } from "../settings/preferences";
import { PersistentThreadTerminalDrawer } from "./ThreadTerminalDrawer";
import {
  ownerScope,
  placeDrawerHosts,
  reconcileMountedOwners,
  type TerminalOwner,
} from "./mountedDrawers";
import { selectTerminalState } from "./terminalState";
import { readTerminalState, useTerminalStates } from "./terminalStore";

type ActiveDrawer = TerminalOwner & {
  readonly slot: HTMLElement;
  readonly fileLinks: FileLinks;
  readonly composer: ComposerContextChannel | null;
};

const ShowDrawer = createContext<((active: ActiveDrawer) => () => void) | null>(
  null,
);

export function TerminalDrawerHost({
  workspaceIds,
  children,
}: {
  workspaceIds: readonly string[];
  children: ReactNode;
}) {
  const [active, setActive] = useState<ActiveDrawer | null>(null);
  const [mounted, setMounted] = useState<readonly TerminalOwner[]>([]);
  const states = useTerminalStates();
  const { preferences } = usePreferences();
  const parking = useRef<HTMLDivElement>(null);
  const hosts = useRef(new Map<string, HTMLDivElement>());
  const show = useCallback((next: ActiveDrawer) => {
    setActive(next);
    return () => setActive((current) => (current === next ? null : current));
  }, []);
  const activeWorkspace = active?.workspaceId;
  const activeThread = active?.threadId;
  const activeOwner = useMemo(
    () =>
      activeWorkspace === undefined || activeThread === undefined
        ? null
        : { workspaceId: activeWorkspace, threadId: activeThread },
    [activeWorkspace, activeThread],
  );
  const activeScope = activeOwner ? ownerScope(activeOwner) : null;
  const activeOpen =
    activeScope !== null &&
    selectTerminalState(states, activeScope).terminalOpen;
  const liveWorkspaces = workspaceIds.join("\n");

  useLayoutEffect(() => {
    const openScopes = new Set(
      Object.entries(states).flatMap(([scope, state]) =>
        state.terminalOpen ? [scope] : [],
      ),
    );
    setMounted((current) =>
      reconcileMountedOwners({
        current,
        openScopes,
        liveWorkspaces: new Set(liveWorkspaces.split("\n")),
        active: activeOwner,
        activeOpen,
      }),
    );
  }, [states, activeOwner, activeOpen, liveWorkspaces]);

  useLayoutEffect(() => {
    const placement = placeDrawerHosts(mounted.map(ownerScope), activeScope);
    for (const [scope, node] of hosts.current) {
      const place = placement.get(scope);
      if (place === undefined) {
        node.remove();
        hosts.current.delete(scope);
        continue;
      }
      const parent = place === "slot" && active ? active.slot : parking.current;
      if (parent && node.parentNode !== parent) parent.append(node);
    }
  });

  const hostFor = (scope: string) => {
    let node = hosts.current.get(scope);
    if (!node) {
      node = document.createElement("div");
      node.className = "contents";
      hosts.current.set(scope, node);
    }
    return node;
  };

  return (
    <ShowDrawer.Provider value={show}>
      {children}
      <div ref={parking} hidden data-terminal-drawer-parking="" />
      {mounted.map((owner) => {
        const scope = ownerScope(owner);
        const isActive = scope === activeScope;
        return createPortal(
          <MountedDrawer
            owner={owner}
            active={isActive}
            fileLinks={isActive ? active?.fileLinks : undefined}
            composer={isActive ? (active?.composer ?? null) : null}
            fontSize={preferences.appearance.fontSizeCode}
          />,
          hostFor(scope),
          scope,
        );
      })}
    </ShowDrawer.Provider>
  );
}

const MountedDrawer = memo(function MountedDrawer({
  owner,
  active,
  fileLinks,
  composer,
  fontSize,
}: {
  owner: TerminalOwner;
  active: boolean;
  fileLinks: FileLinks | undefined;
  composer: ComposerContextChannel | null;
  fontSize: number;
}) {
  return (
    <RenderErrorBoundary
      resetKeys={[active]}
      fallback={({ error, reset }) =>
        active ? (
          <div
            className="flex min-h-0 shrink-0 flex-col border-t border-border"
            style={{
              height: readTerminalState(ownerScope(owner)).terminalHeight,
            }}
          >
            <ErrorView
              error={error}
              onRetry={reset}
              area="Terminal drawer"
              contained
            />
          </div>
        ) : null
      }
    >
      <ComposerContextProvider value={composer}>
        <PersistentThreadTerminalDrawer
          workspaceId={owner.workspaceId}
          threadId={owner.threadId}
          active={active}
          fontSize={fontSize}
          fileLinks={fileLinks}
        />
      </ComposerContextProvider>
    </RenderErrorBoundary>
  );
});

export function TerminalDrawerSlot({
  workspaceId,
  threadId,
  fileLinks,
}: TerminalOwner & { fileLinks: FileLinks }) {
  const show = useContext(ShowDrawer);
  const composer = useComposerContext();
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!show || !slot) return;
    return show({ workspaceId, threadId, slot, fileLinks, composer });
  }, [show, slot, workspaceId, threadId, fileLinks, composer]);
  return <div ref={setSlot} className="contents" />;
}
