import { useSyncExternalStore } from "react";

export type ResolvedTheme = "light" | "dark";

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

const snapshot = (): ResolvedTheme =>
  document.documentElement.classList.contains("dark") ? "dark" : "light";

export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, snapshot);
}
