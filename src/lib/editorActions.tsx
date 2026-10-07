// Failure titles follow pingdotgg/t3code v0.0.45 fileContextMenu.ts and components/ChatMarkdown.tsx (MIT).
import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { ipc, native, type EditorPosition, type OpenTarget } from "../ipc";
import { usePreferences } from "../settings/preferences";
import { Toast, ToastViewport } from "../ui/toast";
import {
  editorById,
  installedEditors,
  resolvePreferredEditor,
  type EditorId,
} from "./editors";

type Notice = {
  id: number;
  type: "success" | "error";
  title: string;
  description: string;
};
let notices: readonly Notice[] = [];
let nextNotice = 0;
const listeners = new Set<() => void>();
const setNotices = (next: readonly Notice[]) => {
  notices = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function notifyEditorResult(
  type: Notice["type"],
  title: string,
  description: string,
) {
  setNotices([...notices, { id: ++nextNotice, type, title, description }]);
}

export function EditorToasts() {
  const list = useSyncExternalStore(
    subscribe,
    () => notices,
    () => notices,
  );
  if (!list.length) return null;
  return (
    <ToastViewport>
      <div className="flex w-full flex-col gap-2">
        {list.map((notice) => (
          <Toast
            key={notice.id}
            type={notice.type}
            title={notice.title}
            description={notice.description}
            onDismiss={() =>
              setNotices(notices.filter((other) => other.id !== notice.id))
            }
            dismissAfterVisibleMs={notice.type === "error" ? 10_000 : 3_000}
          />
        ))}
      </div>
    </ToastViewport>
  );
}

const failure = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const NONE: readonly EditorId[] = [];

export function useEditorActions() {
  const { preferences, update } = usePreferences();
  const query = useQuery({
    queryKey: ["available-editors"],
    queryFn: ipc.availableEditors,
    staleTime: 60_000,
    enabled: native,
  });
  const available = query.data ?? NONE;
  const preferred = resolvePreferredEditor(
    preferences.preferredEditor,
    available,
  );
  return {
    available,
    installed: installedEditors(available),
    preferred,
    open: (
      target: OpenTarget,
      position: EditorPosition | null = null,
      editor: EditorId | null = preferred,
    ) => {
      if (!editor) return;
      ipc
        .openInEditor(target, editor, position)
        .catch((error: unknown) =>
          notifyEditorResult(
            "error",
            editor === "file-manager"
              ? "Unable to open file"
              : `Could not open in ${editorById(editor).label}`,
            failure(error),
          ),
        );
    },
    reveal: (target: OpenTarget) => {
      ipc
        .revealInFinder(target)
        .catch((error: unknown) =>
          notifyEditorResult("error", "Unable to reveal file", failure(error)),
        );
    },
    choose: (editor: EditorId) => update({ preferredEditor: editor }),
  };
}
