// Toast copy follows T3 Code v0.0.45 hooks/useNewProject.ts (MIT).
import { useSyncExternalStore } from "react";
import { Toast, ToastViewport, type ToastType } from "../ui/toast";

type Notice = {
  id: number;
  type: ToastType;
  title: string;
  description: string;
};
let notices: readonly Notice[] = [];
let sequence = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const update = (next: readonly Notice[]) => {
  notices = next;
  for (const listener of listeners) listener();
};
export function notifyProject(
  type: ToastType,
  title: string,
  description: string,
) {
  update([...notices, { id: ++sequence, type, title, description }]);
}
export function ProjectToasts() {
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
            {...notice}
            dismissAfterVisibleMs={notice.type === "success" ? 5000 : 10000}
            onDismiss={() =>
              update(notices.filter((other) => other.id !== notice.id))
            }
          />
        ))}
      </div>
    </ToastViewport>
  );
}
