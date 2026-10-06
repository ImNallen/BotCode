// Ported from pingdotgg/t3code v0.0.45 components/ThreadNotificationCoordinator.tsx (MIT).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted } from "@tauri-apps/plugin-notification";
import { z } from "zod";
import type { WorkspaceView } from "../ipc";
import { usePreferences } from "../settings/preferences";
import {
  hasNotificationSound,
  playNotificationSound,
  unlockNotificationAudio,
} from "../threadNotifications";
import { Toast, ToastViewport } from "../ui/toast";
import {
  notificationHistory,
  presentation,
  type PresentationContext,
  type ThreadAlert,
  type ThreadTarget,
} from "./observer";

const targets = z.array(
  z.object({ workspaceId: z.uuid(), threadId: z.uuid() }),
);
const titles = {
  completion: "Thread completed",
  failure: "Thread failed",
  approval: "Approval needed",
};

export function ThreadNotificationCoordinator({
  workspaces,
  workspaceIds,
  visibleThread,
  openThread,
}: {
  workspaces: readonly WorkspaceView[];
  workspaceIds: readonly string[];
  visibleThread: ThreadTarget | null;
  openThread: (workspaceId: string, threadId: string) => void;
}) {
  const { preferences } = usePreferences();
  const current = useRef({
    preferences,
    visibleThread,
    openThread,
    focused: document.hasFocus(),
    workspaces,
  });
  const [toasts, setToasts] = useState<ThreadAlert[]>([]);
  useLayoutEffect(() => {
    current.current = {
      ...current.current,
      preferences,
      visibleThread,
      openThread,
      workspaces,
    };
    notificationHistory.prune(workspaceIds);
    for (const view of workspaces) notificationHistory.seed(view);
  });
  useEffect(() => {
    let active = true;
    const appWindow = getCurrentWindow();
    const context = (): PresentationContext => ({
      mode: current.current.preferences.notificationMode,
      inAppNotificationsEnabled:
        current.current.preferences.inAppNotificationsEnabled,
      focused:
        current.current.focused && document.visibilityState === "visible",
      visibleThread: current.current.visibleThread,
    });
    const updateFocus = (focused: boolean) => {
      current.current.focused = focused;
    };
    const onFocus = () => updateFocus(true);
    const onBlur = () => updateFocus(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    const focusOff = appWindow.onFocusChanged(({ payload }) =>
      updateFocus(payload),
    );
    void appWindow.isFocused().then((focused) => {
      if (active) updateFocus(focused);
    });
    const off = notificationHistory.subscribe((alert) => {
      const effects = presentation(alert, context());
      if (effects.sound)
        void playNotificationSound(
          alert.kind === "completion" ? "completion" : "input",
          () => active && presentation(alert, context()).sound,
        );
      if (effects.toast)
        setToasts((previous) => [
          ...previous.filter((toast) => toast.threadId !== alert.threadId),
          alert,
        ]);
      if (effects.desktop)
        void isPermissionGranted()
          .then((granted) => {
            if (!active || !granted || !presentation(alert, context()).desktop)
              return;
            return invoke("plugin:notification|notify", {
              options: {
                title: titles[alert.kind],
                body: alert.threadTitle,
                group: `${alert.workspaceId}:${alert.threadId}`,
                extra: {
                  botThread: {
                    workspaceId: alert.workspaceId,
                    threadId: alert.threadId,
                  },
                },
                silent: true,
              },
            });
          })
          .catch((error: unknown) => {
            if (active)
              setToasts((previous) => [
                ...previous,
                {
                  ...alert,
                  kind: "failure",
                  threadTitle: `Notification could not be delivered. ${error instanceof Error ? error.message : String(error)}`,
                },
              ]);
          });
    });
    const drain = async () => {
      const pending = targets.parse(
        await invoke<unknown>("notification_actions"),
      );
      if (!active) return;
      for (const target of pending)
        current.current.openThread(target.workspaceId, target.threadId);
    };
    const clickOff = listen("bot:notification-open", () => {
      void drain();
    }).then(async (off) => {
      if (active) await drain();
      return off;
    });
    return () => {
      active = false;
      off();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      void focusOff.then((off) => off());
      void clickOff.then((off) => off());
    };
  }, []);
  useEffect(() => {
    if (!hasNotificationSound(preferences.notificationMode)) return;
    document.addEventListener("pointerdown", unlockNotificationAudio);
    document.addEventListener("keydown", unlockNotificationAudio);
    return () => {
      document.removeEventListener("pointerdown", unlockNotificationAudio);
      document.removeEventListener("keydown", unlockNotificationAudio);
    };
  }, [preferences.notificationMode]);
  const dismiss = (eventKey: string) =>
    setToasts((previous) =>
      previous.filter((toast) => toast.eventKey !== eventKey),
    );
  if (!toasts.length) return null;
  return (
    <ToastViewport>
      <div className="flex w-full flex-col gap-2">
        {toasts.map((alert) => (
          <Toast
            key={`${alert.threadId}:${alert.eventKey}`}
            type={
              alert.kind === "completion"
                ? "success"
                : alert.kind === "failure"
                  ? "error"
                  : "warning"
            }
            title={titles[alert.kind]}
            description={alert.threadTitle}
            onDismiss={() => dismiss(alert.eventKey)}
            dismissAfterVisibleMs={10_000}
            action={{
              label: "Open thread",
              onClick: () => {
                dismiss(alert.eventKey);
                openThread(alert.workspaceId, alert.threadId);
              },
            }}
          />
        ))}
      </div>
    </ToastViewport>
  );
}
