// Ported from pingdotgg/t3code v0.0.45 apps/web/src/panelAnimations.ts and components/AppSidebarLayout.tsx (MIT).
import { useLocation } from "@tanstack/react-router";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useAppearance } from "./appearance/AppearanceRoot";
import { useMediaQuery } from "./lib/useMediaQuery";

const PanelAnimationSuppressionContext = createContext(false);

export const PanelAnimationSuppressionProvider =
  PanelAnimationSuppressionContext.Provider;

/**
 * Suppresses panel motion for the first painted frame of an initial route or navigation.
 * State restored by a route must be visible immediately; later user actions can animate.
 */
export function usePanelNavigationSuppression(navigationKey: string): boolean {
  const [paintedNavigationKey, setPaintedNavigationKey] = useState<
    string | null
  >(null);
  const suppressed = paintedNavigationKey !== navigationKey;

  useEffect(() => {
    if (!suppressed) return;
    let releaseFrame = 0;
    const paintFrame = window.requestAnimationFrame(() => {
      releaseFrame = window.requestAnimationFrame(() =>
        setPaintedNavigationKey(navigationKey),
      );
    });
    return () => {
      window.cancelAnimationFrame(paintFrame);
      window.cancelAnimationFrame(releaseFrame);
    };
  }, [navigationKey, suppressed]);

  return suppressed;
}

export type PanelAnimation = Readonly<{ active: boolean; durationMs: number }>;

export function resolvePanelAnimation(input: {
  durationMs: number;
  prefersReducedMotion: boolean;
  suppressed: boolean;
}): PanelAnimation {
  return {
    active:
      input.durationMs > 0 && !input.prefersReducedMotion && !input.suppressed,
    durationMs: input.durationMs,
  };
}

function usePanelAnimation(suppressed: boolean): PanelAnimation {
  return resolvePanelAnimation({
    durationMs: useAppearance().appearance.panelAnimationDurationMs,
    prefersReducedMotion: useMediaQuery("(prefers-reduced-motion: reduce)"),
    suppressed,
  });
}

export function usePanelAnimationSettings(): PanelAnimation {
  return usePanelAnimation(useContext(PanelAnimationSuppressionContext));
}

export function useShellPanelAnimations(): {
  suppressed: boolean;
  active: boolean;
  style: CSSProperties;
} {
  const navigationKey = useLocation({
    select: (location) => `${location.pathname}${location.searchStr}`,
  });
  const suppressed = usePanelNavigationSuppression(navigationKey);
  const { active, durationMs } = usePanelAnimation(suppressed);
  return {
    suppressed,
    active,
    style: { "--panel-animation-duration": `${durationMs}ms` } as CSSProperties,
  };
}

/** Keeps closing panel content mounted until its opt-in transition ends. */
export function usePanelPresence<T>(
  open: boolean,
  value: T | null,
  animated: boolean,
  scopeKey: string | null,
  durationMs: number,
): { present: boolean; value: T | null } {
  const [present, setPresent] = useState(open);
  const retainedRef = useRef<{
    scopeKey: string | null;
    value: T | null;
  } | null>(open ? { scopeKey, value } : null);

  useEffect(() => {
    if (open) retainedRef.current = { scopeKey, value };
  }, [open, scopeKey, value]);

  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    if (!animated) {
      setPresent(false);
      return;
    }

    const timeout = window.setTimeout(() => setPresent(false), durationMs);
    return () => window.clearTimeout(timeout);
  }, [animated, durationMs, open]);

  const retainedValue =
    retainedRef.current?.scopeKey === scopeKey
      ? retainedRef.current.value
      : null;
  const visible =
    open || (animated && present && retainedRef.current?.scopeKey === scopeKey);
  return {
    present: visible,
    value: open ? value : visible ? retainedValue : null,
  };
}
