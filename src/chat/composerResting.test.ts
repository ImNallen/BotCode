import assert from "node:assert/strict";
import { it } from "node:test";
import {
  COMPOSER_SCROLL_COLLAPSE_THRESHOLD_PX,
  canScrollCollapseComposer,
  createComposerScrollGestureState,
  getRestingComposerImagePreviewCounts,
  recordComposerScrollGestureEvent,
  resolveComposerTimelineInset,
  shouldUseRestingComposerLayout,
  suppressActiveComposerScrollGesture,
} from "./composerResting";

const eligible = {
  isExistingThread: true,
  collapseOnScroll: true,
  hasMultilinePrompt: false,
  hasExpandedChrome: false,
  showsInlineTasksBadge: false,
};

it("lets a scroll collapse only an existing thread's single-line composer with the setting on", () => {
  assert.equal(canScrollCollapseComposer(eligible), true);
  for (const blocker of [
    { isExistingThread: false },
    { collapseOnScroll: false },
    { hasMultilinePrompt: true },
    { hasExpandedChrome: true },
    { showsInlineTasksBadge: true },
  ])
    assert.equal(
      canScrollCollapseComposer({ ...eligible, ...blocker }),
      false,
      JSON.stringify(blocker),
    );
});

it("rests only after a scroll collapse while the timeline overflows", () => {
  const resting = {
    isExistingThread: true,
    isScrollCollapsed: true,
    hasExpandedChrome: false,
    hasMultilinePrompt: false,
    timelineOverflows: true,
  };
  assert.equal(shouldUseRestingComposerLayout(resting), true);
  for (const blocker of [
    { isExistingThread: false },
    { isScrollCollapsed: false },
    { hasExpandedChrome: true },
    { hasMultilinePrompt: true },
    { timelineOverflows: false },
  ])
    assert.equal(
      shouldUseRestingComposerLayout({ ...resting, ...blocker }),
      false,
      JSON.stringify(blocker),
    );
});

it("collapses once a reading gesture passes 24px and never while scrolling at the end", () => {
  const gesture = createComposerScrollGestureState();
  const wheel = (deltaPx: number, now: number, atEnd = false) =>
    recordComposerScrollGestureEvent(gesture, {
      now,
      deltaPx,
      collapseThresholdPx: COMPOSER_SCROLL_COLLAPSE_THRESHOLD_PX,
      collapseEligible: true,
      canScrollInGestureDirection: true,
      scrollsTowardLogicalEnd: atEnd,
    });
  assert.equal(wheel(10, 0), false);
  assert.equal(wheel(10, 10), false);
  assert.equal(wheel(10, 20), true);
  assert.equal(wheel(30, 30, true), false);
  suppressActiveComposerScrollGesture(gesture, 100, 120);
  assert.equal(wheel(100, 110), false);
});

it("keeps the expanded reservation while resting and shows three image thumbnails", () => {
  assert.equal(
    resolveComposerTimelineInset({
      currentInset: 180,
      overlayHeight: 60,
      isResting: true,
    }),
    180,
  );
  assert.equal(
    resolveComposerTimelineInset({
      currentInset: 0,
      overlayHeight: 60,
      isResting: true,
    }),
    154,
  );
  assert.equal(
    resolveComposerTimelineInset({
      currentInset: 180,
      overlayHeight: 120,
      isResting: false,
    }),
    120,
  );
  assert.deepEqual(getRestingComposerImagePreviewCounts(5), {
    visibleCount: 3,
    overflowCount: 2,
  });
  assert.deepEqual(getRestingComposerImagePreviewCounts(2), {
    visibleCount: 2,
    overflowCount: 0,
  });
});
