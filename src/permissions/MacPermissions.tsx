// Checklist and polling ported from T3 Code v0.0.45 web/components/permissions (MIT).
import { invoke } from "@tauri-apps/api/core";
import { MacAccessibilityIcon, MacScreenRecordingIcon } from "../ui/icons";
import { useState } from "react";
import { z } from "zod";
import { PermissionChecklist } from "./PermissionChecklist";
import { usePermissionStatus } from "./usePermissionStatus";

import { isMac } from "./platform";
export { isMac } from "./platform";
const permissionStatus = z.object({
  screenRecording: z.boolean(),
  accessibility: z.boolean(),
});
const settingsOpened = z.enum(["helper", "unpackaged"]);
type Permission = "screen-recording" | "accessibility";
const check = async () =>
  permissionStatus.parse(await invoke<unknown>("mac_permission_status"));

export function MacPermissions() {
  const { status, error } = usePermissionStatus(
    check,
    { screenRecording: false, accessibility: false },
    isMac,
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const allow = async (permission: Permission) => {
    setBusy(true);
    setNotice(null);
    try {
      const result = settingsOpened.parse(
        await invoke<unknown>("mac_permission_open", { permission }),
      );
      if (result === "unpackaged")
        setNotice(
          "System Settings is open. The app drag helper is available in an installed Bot Code app.",
        );
    } catch {
      setNotice("Could not open System Settings. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Optional. Codex works without these permissions. You can manage them
        later in Settings.
      </p>
      <PermissionChecklist
        busy={busy}
        permissions={[
          {
            id: "screen-recording",
            icon: (
              <MacScreenRecordingIcon className="size-8 shrink-0 drop-shadow-sm" />
            ),
            title: "Screen Recording",
            description: "Manage macOS permission to capture your screen.",
            granted: status.screenRecording,
            onAllow: () => void allow("screen-recording"),
          },
          {
            id: "accessibility",
            icon: (
              <MacAccessibilityIcon className="size-8 shrink-0 drop-shadow-sm" />
            ),
            title: "Accessibility",
            description: "Manage macOS permission to control other apps.",
            granted: status.accessibility,
            onAllow: () => void allow("accessibility"),
          },
        ]}
      />
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
