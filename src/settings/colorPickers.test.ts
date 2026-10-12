// Theme cases ported from pingdotgg/t3code v0.0.45 apps/web/src/components/settings/colorPickers.test.tsx (MIT).
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "../test/expectShim";
import { findAll, withFakeDom, type FakeNode } from "../test/fakeDom";
import { ThemeColorPickerPanel } from "./ThemeColorPicker";

let nextFrameId = 0;
const frames = new Map<number, FrameRequestCallback>();

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrameId, callback);
    return nextFrameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

afterEach(() => {
  frames.clear();
  vi.unstubAllGlobals();
});

type Props = Record<string, (event: unknown) => void> & {
  value?: number;
  "aria-valuenow"?: number;
};

function props(node: FakeNode): Props {
  const key = Object.keys(node).find((name) =>
    name.startsWith("__reactProps$"),
  );
  return Reflect.get(node, key ?? "") as Props;
}

async function renderPanel(
  value: string,
  run: (picker: {
    onChange: ReturnType<typeof vi.fn<[string], void>>;
    slider: (label: string) => Props;
    plane: (label: string) => Props;
    key: (label: string, key: string, shiftKey?: boolean) => Promise<void>;
    rerender: (value: string) => Promise<void>;
    root: Root;
  }) => Promise<void>,
) {
  await withFakeDom(async ({ subtree, root }) => {
    const onChange = vi.fn<[string], void>();
    const render = (next: string) =>
      createElement(ThemeColorPickerPanel, {
        label: "Accent color",
        value: next,
        onChange,
      });
    await act(async () => root.render(render(value)));
    const byLabel = (tags: string[], label: string) => {
      const match = tags
        .flatMap((tag) => findAll(subtree, tag))
        .find((node) => node.attributes.get("aria-label") === label);
      expect(match).not.toBeUndefined();
      return props(match!);
    };
    const slider = (label: string) => byLabel(["DIV", "INPUT"], label);
    await run({
      onChange,
      slider,
      plane: (label) => byLabel(["DIV"], label),
      key: async (label, key, shiftKey = false) => {
        await act(async () =>
          slider(label).onKeyDown?.({ key, shiftKey, preventDefault() {} }),
        );
      },
      rerender: async (next) => {
        await act(async () => root.render(render(next)));
      },
      root,
    });
  });
}

function pointer(clientX: number, clientY = 0, pointerId = 1) {
  return {
    button: 0,
    clientX,
    clientY,
    pointerId,
    currentTarget: {
      focus: vi.fn(),
      setPointerCapture: vi.fn(),
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 100,
        height: 100,
      }),
    },
  };
}

async function frame() {
  await act(async () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  });
}

const lastCall = (mock: { mock: { calls: unknown[][] } }) =>
  mock.mock.calls.at(-1)?.[0];

describe("shared color controls in settings", () => {
  it("persists independent native range changes through theme batching with alpha", async () => {
    await renderPanel("#ff000080", async ({ onChange, slider, key }) => {
      const saturation = "Accent color saturation";
      const brightness = "Accent color brightness";
      await act(async () =>
        slider(saturation).onChange?.({ currentTarget: { valueAsNumber: 50 } }),
      );
      await act(async () =>
        slider(brightness).onChange?.({ currentTarget: { valueAsNumber: 50 } }),
      );
      expect(onChange).not.toHaveBeenCalled();
      expect(frames.size).toBe(1);
      await frame();
      expect(onChange).toHaveBeenCalledOnce();
      expect(lastCall(onChange)).toBe("#80404080");
      await key(brightness, "ArrowDown", true);
      await frame();
      expect(lastCall(onChange)).toBe("#66333380");
      expect(slider(saturation).value).toBe(50);
    });
  });

  it("batches theme drag updates and flushes the final color with alpha on pointer release", async () => {
    await renderPanel("#ff000080", async ({ onChange, slider }) => {
      const hue = "Accent color hue";
      await act(async () => slider(hue).onPointerDown?.(pointer(25)));
      await act(async () => slider(hue).onPointerMove?.(pointer(50)));
      expect(onChange).not.toHaveBeenCalled();
      expect(frames.size).toBe(1);
      // A second pointer cannot change or end the active drag.
      await act(async () => slider(hue).onPointerMove?.(pointer(75, 0, 2)));
      await act(async () => slider(hue).onPointerUp?.(pointer(75, 0, 2)));
      expect(onChange).not.toHaveBeenCalled();
      await act(async () => slider(hue).onPointerUp?.(pointer(50)));
      expect(onChange).toHaveBeenCalledOnce();
      expect(lastCall(onChange)).toBe("#00ffff80");
      await act(async () => slider(hue).onLostPointerCapture?.(pointer(50)));
      await frame();
      expect(onChange).toHaveBeenCalledTimes(1);
    });
  });

  it("clamps out-of-bounds drags and flushes theme changes on cancellation and unmount", async () => {
    await renderPanel("#ff000080", async ({ onChange, plane, root }) => {
      const planeLabel = "Accent color saturation and brightness";
      await act(async () =>
        plane(planeLabel).onPointerDown?.(pointer(-50, -50)),
      );
      await act(async () =>
        plane(planeLabel).onPointerCancel?.(pointer(-50, -50)),
      );
      expect(lastCall(onChange)).toBe("#ffffff80");
      await act(async () =>
        plane(planeLabel).onPointerDown?.(pointer(150, 150)),
      );
      await act(async () => root.render(null));
      expect(lastCall(onChange)).toBe("#00000080");
      expect(frames.size).toBe(0);
    });
  });

  it("preserves the selected hue when a grey color is echoed back from theme settings", async () => {
    await renderPanel(
      "#ff0000",
      async ({ onChange, slider, plane, key, rerender }) => {
        const hue = "Accent color hue";
        const planeLabel = "Accent color saturation and brightness";
        await key(hue, "ArrowRight", true);
        await act(async () => plane(planeLabel).onPointerDown?.(pointer(0, 0)));
        await frame();
        expect(lastCall(onChange)).toBe("#ffffff");
        await rerender("#ffffff");
        expect(slider(hue)["aria-valuenow"]).toBe(10);
      },
    );
  });
});
