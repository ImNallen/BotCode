// Adapted from pingdotgg/t3code v0.0.45 components/ThreadNotificationCoordinator.tsx (MIT).
import type { NotificationMode } from "../settings/preferences";
import type { ThreadTarget } from "./observer";

export const notificationTag = ({ workspaceId, threadId }: ThreadTarget) =>
  `${workspaceId}:${threadId}`;

export function notificationBadgeLabel(count: number) {
  return count > 9
    ? { text: "9+", fontSize: 30 }
    : { text: String(count), fontSize: 40 };
}

export class PendingNotifications {
  private readonly workspaceByTag = new Map<string, string>();
  private mode: NotificationMode;
  constructor(mode: NotificationMode) {
    this.mode = mode;
  }

  get count(): number {
    return this.workspaceByTag.size;
  }

  delivered(target: ThreadTarget): void {
    if (
      this.mode === "notifications" ||
      this.mode === "notifications-and-sound"
    )
      this.workspaceByTag.set(notificationTag(target), target.workspaceId);
  }

  clear(): string[] {
    const tags = [...this.workspaceByTag.keys()];
    this.workspaceByTag.clear();
    return tags;
  }

  setMode(mode: NotificationMode): string[] {
    this.mode = mode;
    return this.clear();
  }

  retainWorkspaces(workspaceIds: readonly string[]): string[] {
    const active = new Set(workspaceIds);
    const dropped: string[] = [];
    for (const [tag, workspaceId] of this.workspaceByTag)
      if (!active.has(workspaceId)) dropped.push(tag);
    for (const tag of dropped) this.workspaceByTag.delete(tag);
    return dropped;
  }
}
