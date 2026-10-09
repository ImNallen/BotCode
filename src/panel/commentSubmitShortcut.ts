// Ported from T3 Code v0.0.45 apps/web/src/components/diffs/commentSubmitShortcut.ts (MIT).
interface CommentSubmitShortcutEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}

export function isCommentSubmitShortcut(
  event: CommentSubmitShortcutEvent,
  value: string,
  pending: boolean,
): boolean {
  return (
    !pending &&
    (event.metaKey || event.ctrlKey) &&
    event.key === "Enter" &&
    value.trim().length > 0
  );
}
