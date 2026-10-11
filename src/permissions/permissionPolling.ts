// Ported from T3 Code v0.0.45 web/components/permissions/usePermissionStatus.ts (MIT).
export function watchPermissionStatus<Status>({
  check,
  onStatus,
  onError,
  window: host,
  document: page,
}: {
  check: () => Promise<Status>;
  onStatus: (status: Status) => void;
  onError: (error: string | null) => void;
  window: Pick<
    Window,
    "setInterval" | "clearInterval" | "addEventListener" | "removeEventListener"
  >;
  document: Pick<
    Document,
    "visibilityState" | "addEventListener" | "removeEventListener"
  >;
}) {
  let disposed = false;
  let checking = false;
  const refresh = async () => {
    if (disposed || checking || page.visibilityState === "hidden") return;
    checking = true;
    try {
      const next = await check();
      if (!disposed) {
        onStatus(next);
        onError(null);
      }
    } catch {
      if (!disposed)
        onError("Could not check permissions. We'll try again automatically.");
    }
    checking = false;
  };
  void refresh();
  const timer = host.setInterval(() => void refresh(), 1500);
  host.addEventListener("focus", refresh);
  page.addEventListener("visibilitychange", refresh);
  return () => {
    disposed = true;
    host.clearInterval(timer);
    host.removeEventListener("focus", refresh);
    page.removeEventListener("visibilitychange", refresh);
  };
}
