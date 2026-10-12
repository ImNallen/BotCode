// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/settings/themeInspector.test.ts (MIT).
import { describe, expect, it } from "../test/expectShim";

import {
  changedThemePaintKinds,
  restoreInlineProperty,
  themeRoleFromUtilityClass,
  type ThemePaintSnapshot,
} from "./themeInspector";

// Custom properties as WKWebView stores them: a write without a priority
// cannot replace an !important declaration.
function webKitStyle() {
  const declarations = new Map<string, { value: string; priority: string }>();
  return {
    declarations,
    setProperty(name: string, value: string | null, priority = "") {
      if (declarations.get(name)?.priority === "important" && !priority) return;
      declarations.set(name, { value: value ?? "", priority });
    },
    removeProperty(name: string) {
      const value = declarations.get(name)?.value ?? "";
      declarations.delete(name);
      return value;
    },
  };
}

describe("restoreInlineProperty", () => {
  it("puts the theme color back over WebKit's !important probe", () => {
    const style = webKitStyle();
    style.setProperty("--app-theme-canvas", "#0b2a33");
    style.setProperty("--app-theme-canvas", "#01fea7", "important");
    restoreInlineProperty(style, "--app-theme-canvas", "#0b2a33", "");
    expect(style.declarations.get("--app-theme-canvas")).toEqual({
      value: "#0b2a33",
      priority: "",
    });
    style.setProperty("--app-theme-canvas", "#123456");
    expect(style.declarations.get("--app-theme-canvas")?.value).toBe("#123456");
  });

  it("removes a probe that had no theme color under it", () => {
    const style = webKitStyle();
    style.setProperty("--app-theme-canvas", "#01fea7", "important");
    restoreInlineProperty(style, "--app-theme-canvas", "", "");
    expect(style.declarations.has("--app-theme-canvas")).toBe(false);
  });
});

const WHITE_PAINT: ThemePaintSnapshot = {
  background: "rgb(255, 255, 255)\nnone",
  border: "rgb(255, 255, 255)\nnone",
  foreground: "rgb(255, 255, 255)\nnone",
};

describe("changedThemePaintKinds", () => {
  it("does not match an identical hardcoded color", () => {
    expect(changedThemePaintKinds(WHITE_PAINT, { ...WHITE_PAINT })).toEqual([]);
  });

  it("reports only paint that changed with the probed token", () => {
    expect(
      changedThemePaintKinds(WHITE_PAINT, {
        ...WHITE_PAINT,
        background: "rgb(1, 254, 167)\nnone",
        foreground: "rgb(1, 254, 167)\nnone",
      }),
    ).toEqual(["background", "foreground"]);
  });
});

describe("themeRoleFromUtilityClass", () => {
  it("maps semantic utilities to their actual palette role", () => {
    expect(themeRoleFromUtilityClass("text-foreground", "foreground")).toBe(
      "text",
    );
    expect(
      themeRoleFromUtilityClass("text-muted-foreground", "foreground"),
    ).toBe("mutedForeground");
    expect(themeRoleFromUtilityClass("bg-primary/90", "background")).toBe(
      "messageAction",
    );
    expect(themeRoleFromUtilityClass("ring-ring", "border")).toBe("focus");
  });

  it("does not infer hardcoded or potentially inactive colors", () => {
    expect(themeRoleFromUtilityClass("bg-white", "background")).toBeNull();
    expect(
      themeRoleFromUtilityClass("hover:bg-accent", "background"),
    ).toBeNull();
  });
});
