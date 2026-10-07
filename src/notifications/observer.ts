// Adapted from pingdotgg/t3code v0.0.45 components/ThreadNotificationCoordinator.tsx (MIT).
import type { ThreadSummary, WorkspaceView } from "../ipc";

export type ThreadTarget = { workspaceId: string; threadId: string };
export type ThreadAlert = ThreadTarget & {
  eventKey: string;
  kind: "completion" | "failure" | "approval";
  threadTitle: string;
};

type History = { revision: number; consumed: Set<string> };
function events(
  summary: ThreadSummary,
): Pick<ThreadAlert, "eventKey" | "kind">[] {
  const result: Pick<ThreadAlert, "eventKey" | "kind">[] = [
    ...summary.pendingApprovalIds,
    ...summary.pendingUserQuestionIds,
  ].map((id) => ({
    eventKey: `approval:${id}`,
    kind: "approval",
  }));
  const turn = summary.latestTurn;
  if (turn?.completedAtMs !== null && turn?.completedAtMs !== undefined) {
    if (turn.execution.kind === "completed")
      result.push({ eventKey: `turn:${turn.id}`, kind: "completion" });
    if (turn.execution.kind === "failed")
      result.push({ eventKey: `turn:${turn.id}`, kind: "failure" });
  }
  return result;
}

export class NotificationHistory {
  private readonly workspaces = new Map<string, Map<string, History>>();
  private readonly seeded = new Set<string>();
  private readonly listeners = new Set<(alert: ThreadAlert) => void>();

  seed(view: Pick<WorkspaceView, "workspace" | "threads">): void {
    let threads = this.workspaces.get(view.workspace.id);
    if (!threads) {
      threads = new Map();
      this.workspaces.set(view.workspace.id, threads);
    }
    const seeded = this.seeded.has(view.workspace.id);
    for (const summary of view.threads) {
      const prior = threads.get(summary.id);
      if (seeded && prior) {
        this.observe(view.workspace.id, summary);
        continue;
      }
      if (prior && prior.revision > summary.revision) continue;
      const consumed = prior?.consumed ?? new Set<string>();
      for (const event of events(summary)) consumed.add(event.eventKey);
      threads.set(summary.id, { revision: summary.revision, consumed });
    }
    this.seeded.add(view.workspace.id);
  }

  prune(workspaceIds: readonly string[]): void {
    const active = new Set(workspaceIds);
    for (const id of this.workspaces.keys())
      if (!active.has(id)) {
        this.workspaces.delete(id);
        this.seeded.delete(id);
      }
  }

  observe(workspaceId: string, summary: ThreadSummary): boolean {
    let threads = this.workspaces.get(workspaceId);
    if (!threads) {
      threads = new Map();
      this.workspaces.set(workspaceId, threads);
    }
    const prior = threads.get(summary.id);
    if (prior && prior.revision > summary.revision) return false;
    if (prior?.revision === summary.revision) return true;
    const current = events(summary);
    const history = prior ?? {
      revision: summary.revision,
      consumed: new Set<string>(),
    };
    history.revision = summary.revision;
    threads.set(summary.id, history);
    for (const event of current) {
      if (history.consumed.has(event.eventKey)) continue;
      history.consumed.add(event.eventKey);
      if (!prior || !this.seeded.has(workspaceId)) continue;
      for (const listener of this.listeners)
        listener({
          ...event,
          workspaceId,
          threadId: summary.id,
          threadTitle: summary.title,
        });
    }
    return true;
  }

  subscribe(listener: (alert: ThreadAlert) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
export const notificationHistory = new NotificationHistory();

export type PresentationContext = {
  focused: boolean;
  visibleThread: ThreadTarget | null;
  mode: "off" | "notifications" | "sound" | "notifications-and-sound";
  inAppNotificationsEnabled: boolean;
};
export function presentation(
  alert: ThreadTarget,
  context: PresentationContext,
) {
  const suppressed =
    context.focused &&
    context.visibleThread?.workspaceId === alert.workspaceId &&
    context.visibleThread.threadId === alert.threadId;
  return {
    sound:
      !suppressed &&
      (context.mode === "sound" || context.mode === "notifications-and-sound"),
    desktop:
      !suppressed &&
      !context.focused &&
      (context.mode === "notifications" ||
        context.mode === "notifications-and-sound"),
    toast: !suppressed && context.focused && context.inAppNotificationsEnabled,
  };
}
