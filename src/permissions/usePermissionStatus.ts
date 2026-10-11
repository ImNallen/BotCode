// Ported from T3 Code v0.0.45 web/components/permissions/usePermissionStatus.ts (MIT).
import { useEffect, useEffectEvent, useState } from "react";
import { watchPermissionStatus } from "./permissionPolling";

export function usePermissionStatus<Id extends string>(
  check: () => Promise<Record<Id, boolean>>,
  initialStatus: Record<Id, boolean>,
  enabled = true,
) {
  const [status, setStatus] = useState(initialStatus);
  const [error, setError] = useState<string | null>(null);
  const checkLatest = useEffectEvent(check);
  useEffect(() => {
    if (!enabled) return;
    return watchPermissionStatus({
      check: checkLatest,
      onStatus: setStatus,
      onError: setError,
      window,
      document,
    });
  }, [enabled]);
  return {
    status,
    error,
    isReady: (required: readonly Id[]) =>
      error === null && required.every((id) => status[id]),
  };
}
