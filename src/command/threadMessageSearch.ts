import { normalizeSearch } from "./commandPaletteSearch";
import type { ThreadMessageSearch } from "../ipc";
export type MessageSearchState =
  | { kind: "idle" }
  | { kind: "loading"; query: string }
  | { kind: "ready"; query: string; result: ThreadMessageSearch }
  | { kind: "error"; query: string; message: string };
export function contentQuery(query: string, enabled: boolean): string | null {
  const trimmed = query.trim();
  const length = Array.from(trimmed).length;
  return enabled && length >= 2 && length <= 200 && normalizeSearch(trimmed)
    ? query
    : null;
}
export type SearchInvalidation =
  | { kind: "thread"; threadId: string; revision: number }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "all" };

export class ThreadMessageSearchController {
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private query: string | null = null;
  private running: object | null = null;
  private dirty = false;
  private state: MessageSearchState = { kind: "idle" };
  private revisions = new Map<string, number>();
  private invalidation = 0;
  private allInvalidated = 0;
  private workspaces = new Map<string, number>();
  private request: (query: string) => Promise<ThreadMessageSearch>;
  private publish: (state: MessageSearchState) => void;
  constructor(
    request: (query: string) => Promise<ThreadMessageSearch>,
    publish: (state: MessageSearchState) => void,
  ) {
    this.request = request;
    this.publish = publish;
  }
  private emit(state: MessageSearchState) {
    this.state = state;
    this.publish(state);
  }
  update(query: string | null) {
    this.cancel();
    this.query = query;
    this.emit(query === null ? { kind: "idle" } : { kind: "loading", query });
    this.schedule();
  }
  private schedule() {
    if (this.query === null || this.timer !== undefined || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const query = this.query;
      if (query === null) return;
      const generation = this.generation;
      const invalidation = this.invalidation;
      const request = {};
      this.running = request;
      this.dirty = false;
      void this.request(query)
        .then(
          (result) => {
            if (generation === this.generation)
              this.emit({
                kind: "ready",
                query,
                result: this.current(result, invalidation),
              });
          },
          (error: unknown) => {
            if (generation === this.generation)
              this.emit({
                kind: "error",
                query,
                message: error instanceof Error ? error.message : String(error),
              });
          },
        )
        .then(() => {
          if (this.running !== request) return;
          this.running = null;
          if (this.dirty) this.schedule();
        });
    }, 200);
  }
  private current(
    result: ThreadMessageSearch,
    started: number,
  ): ThreadMessageSearch {
    return {
      ...result,
      matches: result.matches.filter(
        (match) =>
          this.allInvalidated <= started &&
          (this.workspaces.get(match.workspaceId) ?? 0) <= started &&
          (this.revisions.get(match.threadId) ?? 0) <= match.revision,
      ),
    };
  }
  invalidate(change: SearchInvalidation) {
    this.invalidation++;
    switch (change.kind) {
      case "thread":
        this.revisions.set(
          change.threadId,
          Math.max(change.revision, this.revisions.get(change.threadId) ?? 0),
        );
        break;
      case "workspace":
        this.workspaces.set(change.workspaceId, this.invalidation);
        break;
      case "all":
        this.allInvalidated = this.invalidation;
        break;
    }
    if (this.state.kind === "ready")
      this.emit({
        ...this.state,
        result: this.current(this.state.result, this.invalidation - 1),
      });
    this.dirty = true;
    this.schedule();
  }
  retry() {
    this.update(this.query);
  }
  cancel() {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.running = null;
    this.dirty = false;
  }
}
