import type { PrReviewDetail } from "./prReview";
export function commentSubmitShortcut(event: {
  key: string;
  keyCode: number;
  nativeEvent: { isComposing: boolean };
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}) {
  return (
    !event.nativeEvent.isComposing &&
    event.keyCode !== 229 &&
    event.key === "Enter" &&
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey
  );
}
export function commentFollowUp(
  detail: Pick<PrReviewDetail, "snapshot" | "capabilities">,
): "close" | "reopen" | null {
  const closed = detail.snapshot.lifecycle.kind === "closed";
  if (!closed && detail.snapshot.lifecycle.kind !== "open") return null;
  return detail.capabilities.actions.some(
    (action) => action.kind === "set_closed" && action.closed === !closed,
  )
    ? closed
      ? "reopen"
      : "close"
    : null;
}
