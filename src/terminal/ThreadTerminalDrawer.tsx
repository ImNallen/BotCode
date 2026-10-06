// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/ThreadTerminalDrawer.tsx,
// PersistentThreadTerminalDrawer in components/ChatView.tsx and lib/terminalCloseConfirm.ts (MIT).
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import {
  PlusIcon,
  SquareIcon,
  SquareSplitHorizontalIcon,
  SquareSplitVerticalIcon,
  TerminalSquareIcon,
  Trash2Icon,
} from "lucide-react";
import { ipc, native, type TerminalEvent, type TerminalTarget } from "../ipc";
import type { FileLinks } from "../chat/ChatMarkdown";
import { cn } from "../lib/cn";
import {
  observeSelectionActions,
  resolveSelectionActionPosition,
  type SelectionActionPoint,
} from "../lib/selectionActions";
import { serial } from "../lib/serial";
import {
  terminalCloseShortcut,
  terminalNewShortcut,
  terminalSplitShortcut,
  terminalSplitVerticalShortcut,
} from "../lib/shortcuts";
import { PanelTabCloseButton } from "../panel/chrome";
import { isTerminalUrl } from "../terminal-links";
import { Button } from "../ui/controls";
import { Menu, MenuItem } from "../ui/menu";
import { type GhosttyColor, type GhosttyTheme } from "./ghostty/core";
import {
  GhosttyTerminalSurface,
  isTerminalCopyShortcut,
  isTerminalPasteShortcut,
} from "./ghostty/surface";
import {
  isMacCommandChord,
  isMacOptionText,
  isTerminalClearShortcut,
  isTerminalFocused,
  terminalDeleteShortcutData,
  terminalNavigationShortcutData,
  terminalShortcutCommand,
} from "./terminalKeys";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  MAX_TERMINALS_PER_GROUP,
  closeTerminal,
  getTerminalLabel,
  newTerminal,
  allocateTerminalId,
  setActiveTerminal,
  setTerminalHeight,
  splitTerminal,
  terminalScopeKey,
  toggleTerminalOpen,
  type ThreadTerminalGroup,
  type ThreadTerminalUiState,
} from "./terminalState";
import { updateTerminalState, useTerminalState } from "./terminalStore";

const MIN_DRAWER_HEIGHT = 180;
const MAX_DRAWER_HEIGHT_RATIO = 0.75;

function maxDrawerHeight(): number {
  return Math.max(
    MIN_DRAWER_HEIGHT,
    Math.floor(window.innerHeight * MAX_DRAWER_HEIGHT_RATIO),
  );
}

function clampDrawerHeight(height: number): number {
  const safeHeight = Number.isFinite(height)
    ? height
    : DEFAULT_THREAD_TERMINAL_HEIGHT;
  const maxHeight = maxDrawerHeight();
  return Math.min(
    Math.max(Math.round(safeHeight), MIN_DRAWER_HEIGHT),
    maxHeight,
  );
}

function writeSystemMessage(
  terminal: GhosttyTerminalSurface,
  message: string,
): void {
  terminal.write(`\r\n[terminal] ${message}\r\n`);
}

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

function parseTerminalColor(
  value: string,
  fallback: GhosttyColor,
): GhosttyColor {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return fallback;

  context.clearRect(0, 0, 1, 1);
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
  if (alpha === 0) return fallback;

  return {
    r: red ?? fallback.r,
    g: green ?? fallback.g,
    b: blue ?? fallback.b,
  };
}

function normalizeComputedColor(
  value: string | null | undefined,
  fallback: string,
): string {
  const normalizedValue = value?.trim().toLowerCase();
  if (
    !normalizedValue ||
    normalizedValue === "transparent" ||
    normalizedValue === "rgba(0, 0, 0, 0)" ||
    normalizedValue === "rgba(0 0 0 / 0)"
  ) {
    return fallback;
  }
  return value ?? fallback;
}

function readThemeColor(
  styles: CSSStyleDeclaration,
  variable: string,
  fallback: string,
): string {
  return normalizeComputedColor(styles.getPropertyValue(variable), fallback);
}

function terminalThemeFromApp(mountElement?: HTMLElement | null): GhosttyTheme {
  const drawerSurface =
    mountElement?.closest("[data-thread-terminal-drawer]") ??
    document.querySelector("[data-thread-terminal-drawer]") ??
    document.body;
  const drawerStyles = getComputedStyle(drawerSurface);
  const themeStyles = mountElement
    ? getComputedStyle(mountElement)
    : drawerStyles;
  const colorScheme = themeStyles.colorScheme;
  const isDark =
    colorScheme === "dark"
      ? true
      : colorScheme === "light"
        ? false
        : document.documentElement.classList.contains("dark");
  const fallbackBackground = isDark ? "rgb(14, 18, 24)" : "rgb(255, 255, 255)";
  const fallbackForeground = isDark ? "rgb(237, 241, 247)" : "rgb(28, 33, 41)";
  const bodyStyles = getComputedStyle(document.body);
  const rootThemeStyles = getComputedStyle(document.documentElement);
  const background = normalizeComputedColor(
    drawerStyles.backgroundColor,
    normalizeComputedColor(bodyStyles.backgroundColor, fallbackBackground),
  );
  const foreground = normalizeComputedColor(
    drawerStyles.color,
    normalizeComputedColor(bodyStyles.color, fallbackForeground),
  );
  const terminalBackground = readThemeColor(
    themeStyles,
    "--terminal-background",
    readThemeColor(rootThemeStyles, "--terminal-background", background),
  );
  const terminalForeground = readThemeColor(
    themeStyles,
    "--terminal-foreground",
    readThemeColor(rootThemeStyles, "--terminal-foreground", foreground),
  );
  const terminalCursor = readThemeColor(
    themeStyles,
    "--terminal-cursor",
    isDark ? "rgb(180, 203, 255)" : "rgb(38, 56, 78)",
  );
  const terminalSelection = readThemeColor(
    themeStyles,
    "--terminal-selection-background",
    isDark ? "rgba(180, 203, 255, 0.25)" : "rgba(37, 63, 99, 0.2)",
  );
  return {
    background: parseTerminalColor(
      terminalBackground,
      isDark ? { r: 14, g: 18, b: 24 } : { r: 255, g: 255, b: 255 },
    ),
    foreground: parseTerminalColor(
      terminalForeground,
      isDark ? { r: 237, g: 241, b: 247 } : { r: 28, g: 33, b: 41 },
    ),
    cursor: parseTerminalColor(
      terminalCursor,
      isDark ? { r: 180, g: 203, b: 255 } : { r: 38, g: 56, b: 78 },
    ),
    selectionBackground: terminalSelection,
  };
}

let pendingConfirmations = 0;

function isTerminalCloseConfirmPending(): boolean {
  return pendingConfirmations > 0;
}

async function confirmTerminalClose(label: string): Promise<boolean> {
  if (!native) return true;
  pendingConfirmations += 1;
  try {
    return await confirm(
      [
        `Close terminal "${label}"?`,
        "This stops the running process and clears its history.",
      ].join("\n"),
      {
        title: "Close terminal",
        kind: "warning",
        okLabel: "Close",
        cancelLabel: "Cancel",
      },
    );
  } catch {
    return false;
  } finally {
    pendingConfirmations -= 1;
  }
}

type TerminalMenu = {
  kind: "selection" | "context";
  point: SelectionActionPoint;
  selection: string;
};

interface TerminalViewportProps {
  target: TerminalTarget;
  fontSize: number;
  fileLinks: FileLinks | undefined;
  onSessionExited: () => void;
  focusRequestId: number;
  autoFocus: boolean;
  visible: boolean;
  resizeEpoch: number;
  drawerHeight: number;
}

function TerminalViewport({
  target: { workspaceId, threadId, terminalId },
  fontSize,
  fileLinks,
  onSessionExited,
  focusRequestId,
  autoFocus,
  visible,
  resizeEpoch,
  drawerHeight,
}: TerminalViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<GhosttyTerminalSurface | null>(null);
  const visibleRef = useRef(visible);
  const fontSizeRef = useRef(fontSize);
  const [menu, setMenu] = useState<TerminalMenu | null>(null);
  const handleSessionExited = useEffectEvent(() => onSessionExited());
  const openPath = useEffectEvent((text: string) => {
    const path = fileLinks?.resolve(text);
    if (path) fileLinks?.open(path);
  });
  const showMenu = useEffectEvent((next: TerminalMenu | null) => setMenu(next));
  const dismissSelectionMenu = useEffectEvent(() =>
    setMenu((current) => (current?.kind === "selection" ? null : current)),
  );

  useLayoutEffect(() => {
    visibleRef.current = visible;
    terminalRef.current?.setVisible(visible);
  }, [visible]);

  useEffect(() => {
    if (fontSizeRef.current === fontSize) return;
    fontSizeRef.current = fontSize;
    void terminalRef.current?.setFont({ size: fontSize });
  }, [fontSize]);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) return;

    const target = { workspaceId, threadId, terminalId };
    const inOrder = serial();
    let attach: Promise<number | null> | null = null;
    let attachFailed = false;
    let exited = false;
    let cancelled = false;
    let teardown: (() => void) | null = null;
    let setupTerminal: GhosttyTerminalSurface | null = null;
    let setupCleanups: Array<() => void> = [];
    let selectionActions: ReturnType<typeof observeSelectionActions> | null =
      null;

    const send = (task: () => Promise<unknown>, fallbackError: string) => {
      if (!attach || attachFailed) return;
      void inOrder(task).catch((error: unknown) => {
        const activeTerminal = terminalRef.current;
        if (activeTerminal)
          writeSystemMessage(
            activeTerminal,
            errorMessage(error, fallbackError),
          );
      });
    };

    const handleEvent = (
      terminal: GhosttyTerminalSurface,
      event: TerminalEvent,
    ) => {
      switch (event.type) {
        case "snapshot":
          terminal.resetAndWrite(event.history);
          return;
        case "output":
          terminal.write(event.data);
          terminal.clearSelection();
          return;
        case "exited":
          if (exited) return;
          exited = true;
          writeSystemMessage(terminal, "Process exited");
          window.setTimeout(() => handleSessionExited(), 0);
          return;
      }
    };

    const setup = async (): Promise<(() => void) | null> => {
      const setupFontSize = fontSizeRef.current;
      const terminal = await GhosttyTerminalSurface.create(mount, {
        theme: terminalThemeFromApp(mount),
        font: { size: setupFontSize },
        get visible() {
          return visibleRef.current;
        },
        onData: (data) =>
          send(() => ipc.terminalWrite(target, data), "Terminal write failed"),
        onResize: (cols, rows) =>
          send(
            () => ipc.terminalResize(target, cols, rows),
            "Terminal resize failed",
          ),
        onSelectionChange: () => handleSelectionChange(),
        beforeKey: (event) => handleBeforeKey(event),
        onLinkActivate: (text) => handleLinkActivate(text),
        onContextMenu: (event) => showContextMenu(event),
      });
      if (cancelled) {
        terminal.dispose();
        return null;
      }
      terminal.setVisible(visibleRef.current);
      terminal.setTheme(terminalThemeFromApp(mount));
      setupTerminal = terminal;
      terminalRef.current = terminal;
      if (fontSizeRef.current !== setupFontSize) {
        void terminal.setFont({ size: fontSizeRef.current });
      }
      attach = inOrder(() =>
        ipc.terminalAttach(
          target,
          { cols: terminal.cols, rows: terminal.rows },
          (event) => handleEvent(terminal, event),
        ),
      ).catch((error: unknown) => {
        attachFailed = true;
        writeSystemMessage(
          terminal,
          errorMessage(error, "Unable to start the terminal"),
        );
        return null;
      });
      if (visibleRef.current && mount.contains(document.activeElement)) {
        terminal.focus();
      }

      const clearSelectionAction = () => {
        selectionActions?.cancel();
        dismissSelectionMenu();
      };
      setupCleanups.push(clearSelectionAction);

      const readSelection = (): string | null => {
        const activeTerminal = terminalRef.current;
        if (!activeTerminal?.hasSelection()) return null;
        const selection = activeTerminal.getSelection();
        return selection.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "")
          .length > 0
          ? selection
          : null;
      };

      function showContextMenu(event: MouseEvent): void {
        // Own the gesture: the webview's own menu has no working Paste over a canvas.
        event.preventDefault();
        clearSelectionAction();
        showMenu({
          kind: "context",
          point: { x: event.clientX, y: event.clientY },
          selection: readSelection() ?? "",
        });
      }

      const showSelectionAction = (pointer: SelectionActionPoint | null) => {
        const activeTerminal = terminalRef.current;
        const mountElement = containerRef.current;
        const selection = readSelection();
        if (!activeTerminal || !mountElement || selection === null) {
          clearSelectionAction();
          return;
        }
        showMenu({
          kind: "selection",
          point: resolveSelectionActionPosition({
            bounds: mountElement.getBoundingClientRect(),
            selectionRect: activeTerminal.getSelectionEndClientRect(),
            pointer,
            viewport: { width: window.innerWidth, height: window.innerHeight },
          }),
          selection,
        });
      };

      function handleBeforeKey(event: KeyboardEvent): boolean {
        const command = terminalShortcutCommand(event);
        if (command === "terminal.close") {
          event.preventDefault();
          return false;
        }
        if (command !== null) return false;
        if (isMacOptionText(event)) return false;

        const navigationData = terminalNavigationShortcutData(event);
        if (navigationData !== null) {
          event.preventDefault();
          event.stopPropagation();
          send(
            () => ipc.terminalWrite(target, navigationData),
            "Failed to move cursor",
          );
          return false;
        }

        const deleteData = terminalDeleteShortcutData(event);
        if (deleteData !== null) {
          event.preventDefault();
          event.stopPropagation();
          send(
            () => ipc.terminalWrite(target, deleteData),
            "Failed to delete terminal input",
          );
          return false;
        }

        if (!isTerminalClearShortcut(event)) {
          if (!isMacCommandChord(event) || isTerminalPasteShortcut(event)) {
            return true;
          }
          return (
            isTerminalCopyShortcut(event) &&
            terminalRef.current?.hasSelection() === true
          );
        }
        event.preventDefault();
        event.stopPropagation();
        send(
          () => ipc.terminalWrite(target, "\u000c"),
          "Failed to clear terminal",
        );
        return false;
      }

      function handleLinkActivate(text: string): void {
        const latestTerminal = terminalRef.current;
        if (!latestTerminal) return;
        if (isTerminalUrl(text)) {
          void ipc.openUrl(text).catch((error: unknown) => {
            writeSystemMessage(
              latestTerminal,
              errorMessage(error, "Unable to open link"),
            );
          });
          return;
        }
        openPath(text);
      }

      function handleSelectionChange(): void {
        if (terminalRef.current?.hasSelection()) return;
        clearSelectionAction();
      }

      selectionActions = observeSelectionActions({
        element: mount,
        onSelection: (pointer) => showSelectionAction(pointer),
        onDismiss: () => dismissSelectionMenu(),
      });
      setupCleanups.push(() => selectionActions?.dispose());

      const themeObserver = new MutationObserver(() => {
        const activeTerminal = terminalRef.current;
        if (!activeTerminal) return;
        activeTerminal.setTheme(terminalThemeFromApp(containerRef.current));
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style"],
      });
      setupCleanups.push(() => themeObserver.disconnect());

      const fitTimer = window.setTimeout(() => {
        const activeTerminal = terminalRef.current;
        if (!activeTerminal) return;
        const wasAtBottom = activeTerminal.isAtBottom();
        activeTerminal.fit();
        if (wasAtBottom) {
          activeTerminal.scrollToBottom();
        }
      }, 30);
      setupCleanups.push(() => window.clearTimeout(fitTimer));

      const cleanups = setupCleanups;
      setupCleanups = [];
      setupTerminal = null;
      return () => {
        for (const cleanup of cleanups.toReversed()) cleanup();
        if (terminalRef.current === terminal) terminalRef.current = null;
        // Disposing flushes a pending resize into the queue ahead of the detach.
        terminal.dispose();
        void attach
          ?.then((subscription) =>
            subscription === null
              ? undefined
              : inOrder(() => ipc.terminalDetach(subscription)),
          )
          .catch(() => {});
      };
    };

    void setup()
      .then((nextTeardown) => {
        if (cancelled) {
          nextTeardown?.();
          return;
        }
        teardown = nextTeardown;
      })
      .catch((error: unknown) => {
        for (const cleanup of setupCleanups.toReversed()) cleanup();
        setupCleanups = [];
        if (terminalRef.current === setupTerminal) terminalRef.current = null;
        setupTerminal?.dispose();
        setupTerminal = null;
        if (cancelled) return;
        const message = errorMessage(
          error,
          "Unable to initialize libghostty-vt",
        );
        mount.textContent = `${message} — close and reopen the terminal to retry.`;
      });

    return () => {
      cancelled = true;
      const hadFocus = mount.contains(document.activeElement);
      teardown?.();
      if (hadFocus && mount.isConnected) mount.focus({ preventScroll: true });
    };
  }, [workspaceId, threadId, terminalId]);

  useEffect(() => {
    if (!autoFocus || !visible) return;
    (terminalRef.current ?? containerRef.current)?.focus();
  }, [autoFocus, focusRequestId, visible]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !visibleRef.current) return;
    const wasAtBottom = terminal.isAtBottom();
    const frame = window.requestAnimationFrame(() => {
      if (!visibleRef.current) return;
      terminal.fit();
      if (wasAtBottom) {
        terminal.scrollToBottom();
      }
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [drawerHeight, resizeEpoch, terminalId]);

  const copySelection = (text: string) => {
    void navigator.clipboard.writeText(text).catch((error: unknown) => {
      const terminal = terminalRef.current;
      if (terminal)
        writeSystemMessage(
          terminal,
          errorMessage(error, "Unable to copy terminal selection"),
        );
    });
  };
  const pasteFromClipboard = () => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    void terminal
      .pasteFromClipboard(() => navigator.clipboard.readText())
      .catch((error: unknown) =>
        writeSystemMessage(
          terminal,
          errorMessage(error, "Unable to read the clipboard"),
        ),
      );
  };

  return (
    <>
      <div
        ref={containerRef}
        tabIndex={-1}
        className="relative h-full w-full overflow-hidden bg-(--terminal-background)"
      />
      {menu ? (
        <Menu
          open
          point={menu.point}
          returnFocus={terminalRef.current?.input}
          onOpenChange={(open) => {
            if (!open) setMenu(null);
          }}
          trigger={() => null}
        >
          <MenuItem
            disabled={menu.selection.length === 0}
            onClick={() => copySelection(menu.selection)}
          >
            Copy
          </MenuItem>
          {menu.kind === "context" ? (
            <MenuItem onClick={pasteFromClipboard}>Paste</MenuItem>
          ) : null}
        </Menu>
      ) : null}
    </>
  );
}

interface ThreadTerminalDrawerProps {
  workspaceId: string;
  threadId: string | null;
  fontSize: number;
  fileLinks: FileLinks | undefined;
  visible: boolean;
  height: number;
  terminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
  focusRequestId: number;
  onSplitTerminal: () => void;
  onSplitTerminalVertical: () => void;
  onNewTerminal: () => void;
  onActiveTerminalChange: (terminalId: string) => void;
  onRequestCloseTerminal: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  onHeightChange: (height: number) => void;
}

interface TerminalActionButtonProps {
  label: string;
  className: string;
  onClick: () => void;
  children: ReactNode;
}

function TerminalActionButton({
  label,
  className,
  onClick,
  children,
}: TerminalActionButtonProps) {
  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function ThreadTerminalDrawer({
  workspaceId,
  threadId,
  fontSize,
  fileLinks,
  visible,
  height,
  terminalIds,
  activeTerminalId,
  terminalGroups,
  activeTerminalGroupId,
  focusRequestId,
  onSplitTerminal,
  onSplitTerminalVertical,
  onNewTerminal,
  onActiveTerminalChange,
  onRequestCloseTerminal,
  onCloseTerminal,
  onHeightChange,
}: ThreadTerminalDrawerProps) {
  const [drawerHeight, setDrawerHeight] = useState(() =>
    clampDrawerHeight(height),
  );
  const [resizeEpoch, setResizeEpoch] = useState(0);
  const drawerHeightRef = useRef(drawerHeight);
  const lastSyncedHeightRef = useRef(clampDrawerHeight(height));
  const onHeightChangeRef = useRef(onHeightChange);
  const resizeStateRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);
  const didResizeDuringDragRef = useRef(false);

  const resolvedTerminalGroups = useMemo(() => {
    const terminalOrderIndex = new Map(
      terminalIds.map((id, index) => [id, index] as const),
    );
    const rank = (ids: readonly string[]) =>
      Math.min(
        ...ids.map(
          (id) => terminalOrderIndex.get(id) ?? Number.POSITIVE_INFINITY,
        ),
      );
    return terminalGroups.toSorted(
      (left, right) => rank(left.terminalIds) - rank(right.terminalIds),
    );
  }, [terminalIds, terminalGroups]);

  const resolvedActiveGroupIndex = useMemo(() => {
    const indexById = resolvedTerminalGroups.findIndex(
      (terminalGroup) => terminalGroup.id === activeTerminalGroupId,
    );
    if (indexById >= 0) return indexById;
    const indexByTerminal = resolvedTerminalGroups.findIndex((terminalGroup) =>
      terminalGroup.terminalIds.includes(activeTerminalId),
    );
    return indexByTerminal >= 0 ? indexByTerminal : 0;
  }, [activeTerminalGroupId, activeTerminalId, resolvedTerminalGroups]);

  const visibleTerminalIds =
    resolvedTerminalGroups[resolvedActiveGroupIndex]?.terminalIds ??
    (terminalIds.length > 0 ? [activeTerminalId] : []);
  const splitDirection =
    resolvedTerminalGroups[resolvedActiveGroupIndex]?.splitDirection ??
    "horizontal";
  const hasTerminalSidebar = terminalIds.length > 1;
  const isSplitView = visibleTerminalIds.length > 1;
  const showGroupHeaders =
    resolvedTerminalGroups.length > 1 ||
    resolvedTerminalGroups.some(
      (terminalGroup) => terminalGroup.terminalIds.length > 1,
    );
  const hasReachedSplitLimit =
    visibleTerminalIds.length >= MAX_TERMINALS_PER_GROUP;
  const splitTerminalActionLabel = hasReachedSplitLimit
    ? `Split Terminal Horizontally (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : `Split Terminal Horizontally (${terminalSplitShortcut})`;
  const splitTerminalVerticalActionLabel = hasReachedSplitLimit
    ? `Split Terminal Vertically (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : `Split Terminal Vertically (${terminalSplitVerticalShortcut})`;
  const newTerminalActionLabel = `New Terminal (${terminalNewShortcut})`;
  const closeTerminalActionLabel = `Close Terminal (${terminalCloseShortcut})`;
  const onSplitTerminalAction = () => {
    if (hasReachedSplitLimit) return;
    onSplitTerminal();
  };
  const onSplitTerminalVerticalAction = () => {
    if (hasReachedSplitLimit) return;
    onSplitTerminalVertical();
  };

  useEffect(() => {
    onHeightChangeRef.current = onHeightChange;
  }, [onHeightChange]);

  useEffect(() => {
    drawerHeightRef.current = drawerHeight;
  }, [drawerHeight]);

  const syncHeight = useCallback((nextHeight: number) => {
    const clampedHeight = clampDrawerHeight(nextHeight);
    if (lastSyncedHeightRef.current === clampedHeight) return;
    lastSyncedHeightRef.current = clampedHeight;
    onHeightChangeRef.current(clampedHeight);
  }, []);

  const handleResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      didResizeDuringDragRef.current = false;
      resizeStateRef.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startHeight: drawerHeightRef.current,
      };
    },
    [],
  );

  const handleResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      event.preventDefault();
      const clampedHeight = clampDrawerHeight(
        resizeState.startHeight + (resizeState.startY - event.clientY),
      );
      if (clampedHeight === drawerHeightRef.current) {
        return;
      }
      didResizeDuringDragRef.current = true;
      drawerHeightRef.current = clampedHeight;
      setDrawerHeight(clampedHeight);
    },
    [],
  );

  const handleResizePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      resizeStateRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!didResizeDuringDragRef.current) {
        return;
      }
      syncHeight(drawerHeightRef.current);
      setResizeEpoch((value) => value + 1);
    },
    [syncHeight],
  );

  useEffect(() => {
    if (!visible) {
      return;
    }

    const onWindowResize = () => {
      const clampedHeight = clampDrawerHeight(drawerHeightRef.current);
      const changed = clampedHeight !== drawerHeightRef.current;
      if (changed) {
        setDrawerHeight(clampedHeight);
        drawerHeightRef.current = clampedHeight;
      }
      if (!resizeStateRef.current) {
        syncHeight(clampedHeight);
      }
      setResizeEpoch((value) => value + 1);
    };
    window.addEventListener("resize", onWindowResize);
    return () => {
      window.removeEventListener("resize", onWindowResize);
    };
  }, [syncHeight, visible]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    setResizeEpoch((value) => value + 1);
  }, [visible]);

  useEffect(() => {
    return () => {
      syncHeight(drawerHeightRef.current);
    };
  }, [syncHeight]);

  const resizeHandle = (
    <div
      className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
      onPointerDown={handleResizePointerDown}
      onPointerMove={handleResizePointerMove}
      onPointerUp={handleResizePointerEnd}
      onPointerCancel={handleResizePointerEnd}
    />
  );

  if (terminalIds.length === 0) {
    return (
      <aside
        data-thread-terminal-drawer
        data-terminal-owner="drawer"
        className="relative flex min-w-0 flex-col overflow-hidden bg-background shrink-0 border-t border-border/80"
        style={{ height: `${drawerHeight}px` }}
      >
        {resizeHandle}
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 py-6 text-center text-sm text-muted-foreground">
          <p>No terminal sessions for this thread yet.</p>
          <Button size="xs" variant="outline" onClick={onNewTerminal}>
            {newTerminalActionLabel}
          </Button>
        </div>
      </aside>
    );
  }

  const viewport = (terminalId: string, autoFocus: boolean) => (
    <TerminalViewport
      target={{ workspaceId, threadId, terminalId }}
      fontSize={fontSize}
      fileLinks={fileLinks}
      onSessionExited={() => onCloseTerminal(terminalId)}
      focusRequestId={focusRequestId}
      autoFocus={autoFocus}
      visible={visible}
      resizeEpoch={resizeEpoch}
      drawerHeight={drawerHeight}
    />
  );

  return (
    <aside
      data-thread-terminal-drawer
      data-terminal-owner="drawer"
      className="relative flex min-w-0 flex-col overflow-hidden bg-background shrink-0 border-t border-border/80"
      style={{ height: `${drawerHeight}px` }}
    >
      {resizeHandle}

      {!hasTerminalSidebar && (
        <div className="pointer-events-none absolute right-2 top-2 z-20">
          <div className="pointer-events-auto inline-flex items-center overflow-hidden rounded-md border border-border/80 bg-background shadow-xs">
            <TerminalActionButton
              className={`p-1 text-foreground/90 transition-colors ${
                hasReachedSplitLimit
                  ? "cursor-not-allowed opacity-64 hover:bg-transparent"
                  : "hover:bg-accent"
              }`}
              onClick={onSplitTerminalAction}
              label={splitTerminalActionLabel}
            >
              <SquareSplitHorizontalIcon className="size-3.25" />
            </TerminalActionButton>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              className={`p-1 text-foreground/90 transition-colors ${
                hasReachedSplitLimit
                  ? "cursor-not-allowed opacity-64 hover:bg-transparent"
                  : "hover:bg-accent"
              }`}
              onClick={onSplitTerminalVerticalAction}
              label={splitTerminalVerticalActionLabel}
            >
              <SquareSplitVerticalIcon className="size-3.25" />
            </TerminalActionButton>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              className="p-1 text-foreground/90 transition-colors hover:bg-accent"
              onClick={onNewTerminal}
              label={newTerminalActionLabel}
            >
              <PlusIcon className="size-3.25" />
            </TerminalActionButton>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              className="p-1 text-foreground/90 transition-colors hover:bg-accent"
              onClick={() => onRequestCloseTerminal(activeTerminalId)}
              label={closeTerminalActionLabel}
            >
              <Trash2Icon className="size-3.25" />
            </TerminalActionButton>
          </div>
        </div>
      )}

      <div className="min-h-0 w-full flex-1">
        <div
          className={cn(
            "flex h-full min-h-0 bg-(--terminal-background)",
            hasTerminalSidebar && "gap-1.5",
          )}
        >
          <div className="min-w-0 flex-1">
            {isSplitView ? (
              <div
                className="grid h-full w-full min-w-0 gap-0 overflow-hidden"
                style={
                  splitDirection === "vertical"
                    ? {
                        gridTemplateRows: `repeat(${visibleTerminalIds.length}, minmax(0, 1fr))`,
                      }
                    : {
                        gridTemplateColumns: `repeat(${visibleTerminalIds.length}, minmax(0, 1fr))`,
                      }
                }
              >
                {visibleTerminalIds.map((terminalId) => (
                  <div
                    key={terminalId}
                    className={`min-h-0 min-w-0 ${
                      splitDirection === "vertical"
                        ? "border-t first:border-t-0"
                        : "border-l first:border-l-0"
                    } ${
                      terminalId === activeTerminalId
                        ? "border-border"
                        : "border-border/70"
                    }`}
                    onMouseDown={() => {
                      if (terminalId !== activeTerminalId) {
                        onActiveTerminalChange(terminalId);
                      }
                    }}
                  >
                    <div className="h-full">
                      {viewport(terminalId, terminalId === activeTerminalId)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div key={activeTerminalId} className="h-full">
                {viewport(activeTerminalId, true)}
              </div>
            )}
          </div>

          {hasTerminalSidebar && (
            <aside className="flex w-36 min-w-36 flex-col border border-border/70 bg-muted/10">
              <div className="flex h-[22px] items-stretch justify-end border-b border-border/70">
                <div className="inline-flex h-full items-stretch">
                  <TerminalActionButton
                    className={`inline-flex h-full items-center px-1 text-foreground/90 transition-colors ${
                      hasReachedSplitLimit
                        ? "cursor-not-allowed opacity-64 hover:bg-transparent"
                        : "hover:bg-accent/70"
                    }`}
                    onClick={onSplitTerminalAction}
                    label={splitTerminalActionLabel}
                  >
                    <SquareSplitHorizontalIcon className="size-3.25" />
                  </TerminalActionButton>
                  <TerminalActionButton
                    className={`inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors ${
                      hasReachedSplitLimit
                        ? "cursor-not-allowed opacity-64 hover:bg-transparent"
                        : "hover:bg-accent/70"
                    }`}
                    onClick={onSplitTerminalVerticalAction}
                    label={splitTerminalVerticalActionLabel}
                  >
                    <SquareSplitVerticalIcon className="size-3.25" />
                  </TerminalActionButton>
                  <TerminalActionButton
                    className="inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors hover:bg-accent/70"
                    onClick={onNewTerminal}
                    label={newTerminalActionLabel}
                  >
                    <PlusIcon className="size-3.25" />
                  </TerminalActionButton>
                  <TerminalActionButton
                    className="inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors hover:bg-accent/70"
                    onClick={() => onRequestCloseTerminal(activeTerminalId)}
                    label={closeTerminalActionLabel}
                  >
                    <Trash2Icon className="size-3.25" />
                  </TerminalActionButton>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
                {resolvedTerminalGroups.map((terminalGroup) => {
                  const isGroupActive =
                    terminalGroup.terminalIds.includes(activeTerminalId);
                  const groupActiveTerminalId = isGroupActive
                    ? activeTerminalId
                    : (terminalGroup.terminalIds[0] ?? activeTerminalId);
                  const terminalCount = terminalGroup.terminalIds.length;
                  const isSplitGroup = terminalCount > 1;
                  const groupLabel = !isSplitGroup
                    ? "Single"
                    : terminalGroup.splitDirection === "vertical"
                      ? "Stacked"
                      : "Side by side";
                  const GroupIcon = !isSplitGroup
                    ? SquareIcon
                    : terminalGroup.splitDirection === "vertical"
                      ? SquareSplitVerticalIcon
                      : SquareSplitHorizontalIcon;

                  return (
                    <div key={terminalGroup.id} className="pb-0.5">
                      {showGroupHeaders && (
                        <button
                          type="button"
                          className={`flex h-[22px] w-full cursor-pointer items-center gap-1 rounded px-1.5 text-2xs ${
                            isGroupActive
                              ? "bg-accent/50 text-foreground"
                              : "text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                          }`}
                          onClick={() =>
                            onActiveTerminalChange(groupActiveTerminalId)
                          }
                        >
                          <GroupIcon className="size-3 shrink-0" />
                          <span className="min-w-0 flex-1 truncate text-left">
                            {groupLabel}
                          </span>
                          <span className="text-muted-foreground/70 text-3xs tabular-nums">
                            {terminalCount}
                          </span>
                        </button>
                      )}

                      <div className="flex flex-col gap-0.5">
                        {terminalGroup.terminalIds.map((terminalId) => {
                          const isActive = terminalId === activeTerminalId;
                          const terminalLabel = getTerminalLabel(terminalId);
                          const closeTerminalLabel = `Close ${terminalLabel}${
                            isActive ? ` (${terminalCloseShortcut})` : ""
                          }`;
                          return (
                            <div
                              key={terminalId}
                              className={cn(
                                "group/tab flex h-6 w-full items-center gap-0.5 rounded-md pr-2 pl-1.5 text-xs",
                                isActive
                                  ? "bg-accent text-foreground"
                                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                              )}
                            >
                              <PanelTabCloseButton
                                label={closeTerminalLabel}
                                onClick={() =>
                                  onRequestCloseTerminal(terminalId)
                                }
                              >
                                <TerminalSquareIcon className="size-3 shrink-0" />
                              </PanelTabCloseButton>
                              <button
                                type="button"
                                className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left"
                                onClick={() =>
                                  onActiveTerminalChange(terminalId)
                                }
                              >
                                <span className="truncate">
                                  {terminalLabel}
                                </span>
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </aside>
          )}
        </div>
      </div>
    </aside>
  );
}

export function PersistentThreadTerminalDrawer({
  workspaceId,
  threadId,
  fontSize,
  fileLinks,
  onClosed,
}: {
  workspaceId: string;
  threadId: string | null;
  fontSize: number;
  fileLinks: FileLinks | undefined;
  onClosed: () => void;
}) {
  const scopeKey = terminalScopeKey(workspaceId, threadId);
  const terminalUiState = useTerminalState(scopeKey);
  const visible = terminalUiState.terminalOpen;
  const rootRef = useRef<HTMLDivElement>(null);
  const [localFocusRequestId, setLocalFocusRequestId] = useState(0);
  const update = useCallback(
    (transition: (state: ThreadTerminalUiState) => ThreadTerminalUiState) =>
      updateTerminalState(scopeKey, transition),
    [scopeKey],
  );
  const bumpFocusRequestId = () => setLocalFocusRequestId((value) => value + 1);

  const wasOpen = useRef(false);
  const handleClosed = useEffectEvent(onClosed);
  useEffect(() => {
    const previous = wasOpen.current;
    wasOpen.current = visible;
    if (!previous && visible) {
      setLocalFocusRequestId((value) => value + 1);
    } else if (previous && !visible) {
      const frame = window.requestAnimationFrame(() => handleClosed());
      return () => window.cancelAnimationFrame(frame);
    }
  }, [visible]);

  const splitTerminalIn = (direction: "horizontal" | "vertical") => {
    update((state) =>
      splitTerminal(state, allocateTerminalId(state), direction),
    );
    bumpFocusRequestId();
  };
  const createNewTerminal = () => {
    update((state) => newTerminal(state, allocateTerminalId(state)));
    bumpFocusRequestId();
  };
  const activateTerminal = (terminalId: string) => {
    update((state) => setActiveTerminal(state, terminalId));
    bumpFocusRequestId();
  };
  const removeTerminal = (terminalId: string) => {
    const target = { workspaceId, threadId, terminalId };
    void ipc
      .terminalClose(target)
      .catch(() => ipc.terminalWrite(target, "exit\n"))
      .catch(() => {});
    update((state) => closeTerminal(state, terminalId));
    bumpFocusRequestId();
  };
  const requestCloseTerminal = (terminalId: string) => {
    void confirmTerminalClose(getTerminalLabel(terminalId)).then(
      (confirmed) => {
        if (confirmed) removeTerminal(terminalId);
      },
    );
  };

  const handleShortcut = useEffectEvent((event: KeyboardEvent) => {
    const command = terminalShortcutCommand(event);
    if (command === null || rootRef.current?.closest("[inert]")) return;
    // A held or repeated close must not fall through to the window's own Close.
    if (
      command === "terminal.close" &&
      (event.repeat || isTerminalCloseConfirmPending())
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const terminalFocus = isTerminalFocused();
    if (command !== "terminal.toggle" && !terminalFocus) return;
    if (event.defaultPrevented && !terminalFocus) return;
    event.preventDefault();
    event.stopPropagation();
    switch (command) {
      case "terminal.toggle":
        update(toggleTerminalOpen);
        return;
      case "terminal.split":
        splitTerminalIn("horizontal");
        return;
      case "terminal.splitVertical":
        splitTerminalIn("vertical");
        return;
      case "terminal.new":
        createNewTerminal();
        return;
      case "terminal.close":
        requestCloseTerminal(terminalUiState.activeTerminalId);
        return;
    }
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => handleShortcut(event);
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  return (
    <div
      ref={rootRef}
      className={cn(
        "grid shrink-0 overflow-clip",
        visible ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        "[[data-panel-animations=true]_&]:transition-[grid-template-rows] [[data-panel-animations=true]_&]:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:ease-out",
        visible && "[[data-panel-animations=true]_&]:starting:grid-rows-[0fr]!",
      )}
    >
      <div className="min-h-0 overflow-clip" inert={!visible}>
        <ThreadTerminalDrawer
          workspaceId={workspaceId}
          threadId={threadId}
          fontSize={fontSize}
          fileLinks={fileLinks}
          visible={visible}
          height={terminalUiState.terminalHeight}
          terminalIds={terminalUiState.terminalIds}
          activeTerminalId={terminalUiState.activeTerminalId}
          terminalGroups={terminalUiState.terminalGroups}
          activeTerminalGroupId={terminalUiState.activeTerminalGroupId}
          focusRequestId={localFocusRequestId + (visible ? 1 : 0)}
          onSplitTerminal={() => splitTerminalIn("horizontal")}
          onSplitTerminalVertical={() => splitTerminalIn("vertical")}
          onNewTerminal={createNewTerminal}
          onActiveTerminalChange={activateTerminal}
          onRequestCloseTerminal={requestCloseTerminal}
          onCloseTerminal={removeTerminal}
          onHeightChange={(height) =>
            update((state) => setTerminalHeight(state, height))
          }
        />
      </div>
    </div>
  );
}
