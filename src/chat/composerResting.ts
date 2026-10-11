// Ported from T3 Code v0.0.45 apps/web/src/components/composerFooterLayout.ts, chat/composerScrollGesture.ts, chat/timelineScrollTarget.ts and chat/useComposerMultilinePrompt.ts (MIT).
import { useLayoutEffect, useState } from "react";

const RESTING_COMPOSER_IMAGE_THUMBNAIL_LIMIT = 3;
export const COMPOSER_SCROLL_COLLAPSE_THRESHOLD_PX = 24;
export const COMPOSER_SCROLL_GESTURE_RESET_MS = 120;

export function getRestingComposerImagePreviewCounts(imageCount: number): {
  visibleCount: number;
  overflowCount: number;
} {
  const visibleCount = Math.min(
    imageCount,
    RESTING_COMPOSER_IMAGE_THUMBNAIL_LIMIT,
  );
  return {
    visibleCount,
    overflowCount: Math.max(0, imageCount - visibleCount),
  };
}

// Bot Code is desktop only, so T3's mobile viewport input is always false
// and left out of both decisions.
export function canScrollCollapseComposer(input: {
  isExistingThread: boolean;
  collapseOnScroll: boolean;
  hasMultilinePrompt: boolean;
  hasExpandedChrome: boolean;
  showsInlineTasksBadge: boolean;
}): boolean {
  return (
    input.isExistingThread &&
    input.collapseOnScroll &&
    !input.hasMultilinePrompt &&
    !input.hasExpandedChrome &&
    !input.showsInlineTasksBadge
  );
}

export function shouldUseRestingComposerLayout(input: {
  isExistingThread: boolean;
  isScrollCollapsed: boolean;
  hasExpandedChrome: boolean;
  hasMultilinePrompt: boolean;
  /** Whether the timeline has more content than fits above the composer. */
  timelineOverflows: boolean;
}): boolean {
  // Only a timeline scroll rests the composer, and it lifts on the next
  // composer interaction. Losing focus never rests it. A thread that fits
  // above the composer has nothing to reclaim, so it stays expanded.
  return (
    input.isExistingThread &&
    input.timelineOverflows &&
    input.isScrollCollapsed &&
    !input.hasMultilinePrompt &&
    !input.hasExpandedChrome
  );
}

/**
 * How much taller the empty expanded composer is than its resting row: the
 * body loses 8px of top padding, the prompt clamps from 70px to 32px, and the
 * 48px footer leaves flow.
 */
export const COMPOSER_RESTING_EXPANSION_MIN_PX = 94;

/**
 * While resting, the timeline keeps the last expanded reservation, or at least
 * the resting height plus the empty expansion, so expanding again changes
 * nothing above the composer. An expanded measurement is authoritative.
 */
export function resolveComposerTimelineInset(input: {
  currentInset: number;
  overlayHeight: number;
  isResting: boolean;
}): number {
  return input.isResting
    ? Math.max(
        input.currentInset,
        input.overlayHeight + COMPOSER_RESTING_EXPANSION_MIN_PX,
      )
    : input.overlayHeight;
}

export type ComposerScrollGestureState = {
  accumulatedDeltaPx: number;
  collapseSuppressed: boolean;
  lastEventAt: number;
};

export function createComposerScrollGestureState(): ComposerScrollGestureState {
  return {
    accumulatedDeltaPx: 0,
    collapseSuppressed: false,
    lastEventAt: Number.NEGATIVE_INFINITY,
  };
}

export function resetComposerScrollGesture(
  state: ComposerScrollGestureState,
): void {
  state.accumulatedDeltaPx = 0;
  state.collapseSuppressed = false;
  state.lastEventAt = Number.NEGATIVE_INFINITY;
}

export function suppressActiveComposerScrollGesture(
  state: ComposerScrollGestureState,
  now: number,
  gestureResetMs: number,
): void {
  if (now - state.lastEventAt <= gestureResetMs)
    state.collapseSuppressed = true;
}

export function recordComposerScrollGestureEvent(
  state: ComposerScrollGestureState,
  input: {
    now: number;
    deltaPx: number;
    collapseThresholdPx: number;
    collapseEligible: boolean;
    canScrollInGestureDirection: boolean;
    scrollsTowardLogicalEnd: boolean;
  },
): boolean {
  state.lastEventAt = input.now;
  if (
    state.collapseSuppressed ||
    !input.collapseEligible ||
    !input.canScrollInGestureDirection ||
    input.scrollsTowardLogicalEnd
  ) {
    state.accumulatedDeltaPx = 0;
    return false;
  }
  state.accumulatedDeltaPx += input.deltaPx;
  if (state.accumulatedDeltaPx < input.collapseThresholdPx) return false;
  state.accumulatedDeltaPx = 0;
  return true;
}

// A gesture inside the timeline may belong to a nested tool result or code
// block. Only treat it as timeline navigation if it can chain to the outer list.
export function isTimelineScrollTarget(
  target: EventTarget | null,
  timeline: HTMLElement,
  deltaY: number,
): boolean {
  if (
    !(target instanceof Element) ||
    !timeline.contains(target) ||
    deltaY === 0
  )
    return false;
  for (
    let element: Element | null = target;
    element && element !== timeline;
    element = element.parentElement
  ) {
    const style = getComputedStyle(element);
    if (style.overflowY !== "auto" && style.overflowY !== "scroll") continue;
    const canScroll =
      deltaY < 0
        ? element.scrollTop > 0
        : element.scrollTop < element.scrollHeight - element.clientHeight;
    if (
      canScroll ||
      style.overscrollBehaviorY === "contain" ||
      style.overscrollBehaviorY === "none"
    )
      return false;
  }
  return true;
}

export function measureComposerMultilinePrompt(
  body: HTMLElement,
): boolean | null {
  const editor = body.querySelector<HTMLElement>(
    '[data-testid="composer-editor"]',
  );
  if (!editor || editor.clientWidth === 0) return null;
  const bodyStyle = getComputedStyle(body);
  const expandedWidth =
    body.clientWidth -
    Number.parseFloat(bodyStyle.paddingLeft) -
    Number.parseFloat(bodyStyle.paddingRight);
  const lineHeight = Number.parseFloat(getComputedStyle(editor).lineHeight);
  const range = document.createRange();
  range.selectNodeContents(editor);
  const bounds = range.getBoundingClientRect();
  // Measure content, not the editor's minimum height. While resting, the
  // prompt is unwrapped: compare its width with the expanded row so that
  // moving the actions inline cannot make collapse and expansion oscillate.
  return bounds.height > lineHeight + 1 || bounds.width > expandedWidth + 1;
}

export function useComposerMultilinePrompt(body: HTMLElement | null): boolean {
  const [isMultiline, setIsMultiline] = useState(false);
  useLayoutEffect(() => {
    if (!body) return;
    const measure = () => {
      const next = measureComposerMultilinePrompt(body);
      if (next !== null) setIsMultiline(next);
    };
    measure();
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(body);
    const editor = body.querySelector<HTMLElement>(
      '[data-testid="composer-editor"]',
    );
    if (editor) resizeObserver.observe(editor);
    const mutationObserver = new MutationObserver(measure);
    mutationObserver.observe(body, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [body]);
  return isMultiline;
}
