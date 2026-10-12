import assert from "node:assert/strict";
import { it } from "node:test";
import {
  applyRootState,
  resolveRootState,
  type RootState,
  type RootTarget,
} from "./root";
import { defaultAppearance, type AppearanceSettings } from "./settings";

function resolve(patch: Partial<AppearanceSettings>, systemDark = false) {
  return resolveRootState({
    appearance: { ...defaultAppearance, ...patch },
    systemDark,
  });
}

function recordingRoot() {
  const writes: string[] = [];
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const style = new Map<string, string>();
  const root: RootTarget = {
    classList: {
      toggle(token, force) {
        writes.push(`class ${token} ${force}`);
        if (force) classes.add(token);
        else classes.delete(token);
        return force;
      },
    },
    setAttribute(name, value) {
      writes.push(`set ${name}=${value}`);
      attributes.set(name, value);
    },
    removeAttribute(name) {
      writes.push(`remove ${name}`);
      attributes.delete(name);
    },
    style: {
      setProperty(name, value) {
        writes.push(`set ${name}=${value}`);
        style.set(name, value);
      },
      removeProperty(name) {
        writes.push(`remove ${name}`);
        const previous = style.get(name) ?? "";
        style.delete(name);
        return previous;
      },
    },
  };
  return { root, writes, classes, attributes, style };
}

it("writes T3's contrast mix for low, default and high contrast", () => {
  const contrast = (appearanceContrast: number) => {
    const { style } = resolve({ appearanceContrast });
    return [
      style["--appearance-contrast-base"],
      style["--appearance-contrast-boost"],
      style["--appearance-contrast-border-boost"],
    ];
  };
  assert.deepEqual(contrast(50), ["50%", "0%", "0%"]);
  assert.deepEqual(contrast(100), ["100%", "0%", "0%"]);
  assert.deepEqual(contrast(150), ["100%", "50%", "12.5%"]);
  assert.deepEqual(contrast(200), ["100%", "100%", "25%"]);
});

it("zeroes the glass blur only at full glass opacity", () => {
  assert.equal(resolve({ glassOpacity: 80 }).style["--glass-opacity"], "80%");
  assert.equal("--glass-blur" in resolve({ glassOpacity: 95 }).style, false);
  assert.equal(resolve({ glassOpacity: 100 }).style["--glass-blur"], "0px");
});

it("sets the chat width, diff colors and font sizes on the root", () => {
  const state = resolve({
    chatWidth: "wide",
    diffColorScheme: "blue-orange",
    fontSizePrompt: 17,
    fontSizeCode: 11,
  });
  assert.deepEqual(state.attributes, {
    "data-chat-width": "wide",
    "data-diff-color-scheme": "blue-orange",
  });
  assert.equal(state.style["--font-size-prompt"], "17px");
  assert.equal(state.style["--font-size-code"], "11px");
  assert.equal(state.style["--diffs-font-size"], "11px");
});

it("follows the system scheme only in system mode", () => {
  assert.equal(resolve({ themeAppearanceMode: "system" }, true).dark, true);
  assert.equal(resolve({ themeAppearanceMode: "system" }, false).dark, false);
  assert.equal(resolve({ themeAppearanceMode: "light" }, true).dark, false);
  assert.equal(resolve({ themeAppearanceMode: "dark" }, false).dark, true);
});

it("removes stale properties, writes only changes, and writes nothing when reapplied", () => {
  const { root, writes, classes, attributes, style } = recordingRoot();
  const solid = resolve({ glassOpacity: 100, themeAppearanceMode: "dark" });
  applyRootState(root, null, solid);
  assert.deepEqual(Object.fromEntries(style), solid.style);
  assert.deepEqual(Object.fromEntries(attributes), solid.attributes);
  assert.equal(classes.has("dark"), true);

  writes.length = 0;
  const translucent: RootState = resolve({ glassOpacity: 85 });
  applyRootState(root, solid, translucent);
  assert.deepEqual(writes.toSorted(), [
    "class dark false",
    "remove --glass-blur",
    "set --glass-opacity=85%",
  ]);
  assert.deepEqual(Object.fromEntries(style), translucent.style);
  assert.equal(classes.has("dark"), false);

  writes.length = 0;
  applyRootState(root, translucent, translucent);
  assert.deepEqual(writes, []);

  applyRootState(root, translucent, { ...translucent, attributes: {} });
  assert.deepEqual(writes.toSorted(), [
    "remove data-chat-width",
    "remove data-diff-color-scheme",
  ]);
});
