// Ported from pingdotgg/t3code v0.0.45 components/settings/NotificationSettings.tsx (MIT).
import { useState } from "react";
import { requestPermission } from "@tauri-apps/plugin-notification";
import { ChevronDownIcon } from "lucide-react";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  NOTIFICATION_MODE_LABELS,
  unlockNotificationAudio,
} from "../threadNotifications";
import { selectItem, selectTrigger } from "../ui/controls";
import { Menu } from "../ui/menu";
import { cn } from "../lib/cn";
import { notificationModeSchema, usePreferences } from "./preferences";
import { SettingsRow } from "./settingsLayout";
import type { SettingsRowInfo } from "./settingsCatalog";

export function NotificationSettings({ info }: { info: SettingsRowInfo }) {
  const { preferences, update } = usePreferences();
  const mode = preferences.notificationMode;
  const [permissionMessage, setPermissionMessage] = useState<string | null>(
    null,
  );
  const [requesting, setRequesting] = useState(false);
  const [open, setOpen] = useState(false);
  return (
    <SettingsRow
      {...info}
      description={permissionMessage ?? info.description}
      control={
        <Menu
          align="end"
          open={open}
          onOpenChange={setOpen}
          trigger={(props) => (
            <button
              {...props}
              type="button"
              disabled={requesting}
              className={cn(selectTrigger({ size: "sm" }), "w-full sm:w-56")}
              aria-label="Thread notifications"
            >
              <span>{NOTIFICATION_MODE_LABELS[mode]}</span>
              <ChevronDownIcon className="size-3.5" />
            </button>
          )}
        >
          {Object.entries(NOTIFICATION_MODE_LABELS).map(([value, label]) => (
            <button
              key={value}
              role="menuitem"
              type="button"
              className={cn(selectItem, "w-full")}
              data-selected={value === mode || undefined}
              onClick={async () => {
                const parsed = notificationModeSchema.safeParse(value);
                if (!parsed.success) return;
                setOpen(false);
                setPermissionMessage(null);
                if (hasNotificationSound(parsed.data))
                  unlockNotificationAudio();
                if (hasDesktopNotifications(parsed.data)) {
                  setRequesting(true);
                  try {
                    if ((await requestPermission()) !== "granted") {
                      setPermissionMessage(
                        "Allow notifications in System Settings, then choose this option again. Sound only is still available.",
                      );
                      return;
                    }
                  } catch (error: unknown) {
                    setPermissionMessage(
                      error instanceof Error ? error.message : String(error),
                    );
                    return;
                  } finally {
                    setRequesting(false);
                  }
                }
                update({ notificationMode: parsed.data });
              }}
            >
              {label}
            </button>
          ))}
        </Menu>
      }
    />
  );
}
