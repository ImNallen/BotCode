import assert from "node:assert/strict";
import { it } from "node:test";
import { act, createElement } from "react";
import {
  resolvePanelAnimation,
  usePanelNavigationSuppression,
} from "./panelAnimations";
import { withFakeDom } from "./test/fakeDom";

it("animates panels only with a duration, no reduced motion, and no suppression", () => {
  const motion = { durationMs: 200, prefersReducedMotion: false };
  assert.deepEqual(resolvePanelAnimation({ ...motion, suppressed: false }), {
    active: true,
    durationMs: 200,
  });
  assert.equal(
    resolvePanelAnimation({ ...motion, durationMs: 0, suppressed: false })
      .active,
    false,
  );
  assert.equal(
    resolvePanelAnimation({
      ...motion,
      prefersReducedMotion: true,
      suppressed: false,
    }).active,
    false,
  );
  assert.equal(
    resolvePanelAnimation({ ...motion, suppressed: true }).active,
    false,
  );
});

it("suppresses panel motion until the first frame after a navigation has painted", async () => {
  await withFakeDom(async ({ root }) => {
    const frames: (() => void)[] = [];
    Object.assign(window, {
      requestAnimationFrame: (callback: () => void) => frames.push(callback),
      cancelAnimationFrame: () => {},
    });
    const runFrame = () => act(async () => frames.shift()?.());
    let suppressed: boolean | undefined;
    function Probe({ navigationKey }: { navigationKey: string }) {
      suppressed = usePanelNavigationSuppression(navigationKey);
      return null;
    }
    await act(async () =>
      root.render(createElement(Probe, { navigationKey: "/?thread=a" })),
    );
    assert.equal(suppressed, true);
    await runFrame();
    assert.equal(suppressed, true);
    await runFrame();
    assert.equal(suppressed, false);

    await act(async () =>
      root.render(createElement(Probe, { navigationKey: "/?thread=b" })),
    );
    assert.equal(suppressed, true);
    await runFrame();
    await runFrame();
    assert.equal(suppressed, false);
  });
});
