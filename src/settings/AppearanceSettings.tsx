// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/settings/SettingsPanels.tsx AppearanceSettingsPanel (MIT).
import { ChevronDownIcon } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useAppearance } from "../appearance/AppearanceRoot";
import {
  appearanceRanges,
  defaultAppearance,
  type AppearanceSettings,
  type ChatWidth,
  type DiffColorScheme,
} from "../appearance/settings";
import { cn } from "../lib/cn";
import { Toggle, selectItem, selectTrigger } from "../ui/controls";
import { Menu, MenuItem } from "../ui/menu";
import { PanelAnimationsPreview } from "./PanelAnimationsPreview";
import type { SettingsRowInfo } from "./settingsCatalog";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

const readoutClass =
  "rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground";

// Previews on every input event. React's onChange also fires on input, so the
// commit listens to the native change event (pointer release, keyboard step or
// blur), and a drag saves settings once.
export function SettingsSlider({
  id,
  label,
  min,
  max,
  step,
  value,
  readout,
  className,
  readoutClassName = "min-w-12",
  onPreview,
  onCommit,
}: {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  readout: string;
  className: string;
  readoutClassName?: string;
  onPreview: (value: number) => void;
  onCommit: (value: number) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const parse = (text: string) => {
    const next = Number(text);
    return Number.isInteger(next) && next >= min && next <= max ? next : null;
  };
  const commit = useRef<(text: string) => void>(() => {});
  commit.current = (text) => {
    const next = parse(text);
    if (next !== null) onCommit(next);
  };
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    const onChange = () => commit.current(element.value);
    element.addEventListener("change", onChange);
    return () => element.removeEventListener("change", onChange);
  }, []);
  const ratio = (value - min) / (max - min);
  return (
    <div className={className}>
      <output className={cn(readoutClassName, readoutClass)} htmlFor={id}>
        {readout}
      </output>
      <input
        ref={input}
        aria-label={label}
        className="settings-slider min-w-0 flex-1"
        id={id}
        max={max}
        min={min}
        onInput={(event) => {
          const next = parse(event.currentTarget.value);
          if (next !== null) onPreview(next);
        }}
        step={step}
        style={
          {
            "--settings-slider-progress": `${ratio * 100}%`,
            "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
          } as CSSProperties
        }
        type="range"
        value={value}
      />
    </div>
  );
}

type SliderKey =
  | "appearanceContrast"
  | "glassOpacity"
  | "panelAnimationDurationMs";
const sliders = {
  "setting-appearance-contrast": {
    key: "appearanceContrast",
    inputId: "appearance-contrast",
    label: "Contrast",
    resetLabel: "contrast",
    unit: "%",
  },
  "setting-glass-opacity": {
    key: "glassOpacity",
    inputId: "glass-opacity",
    label: "Glass opacity",
    resetLabel: "glass opacity",
    unit: "%",
  },
  "panel-animations": {
    key: "panelAnimationDurationMs",
    inputId: "panel-animation-duration",
    label: "Panel animation duration",
    resetLabel: "panel animations",
    unit: " ms",
  },
} as const satisfies Record<
  string,
  {
    key: SliderKey;
    inputId: string;
    label: string;
    resetLabel: string;
    unit: string;
  }
>;

const diffColorLabels: Readonly<
  Record<DiffColorScheme, { value: string; item: string }>
> = {
  "red-green": { value: "Red & green", item: "Red & green (default)" },
  "blue-orange": { value: "Blue & orange", item: "Blue & orange" },
};
const chatWidthLabels: Readonly<
  Record<ChatWidth, { value: string; item: string }>
> = {
  comfortable: { value: "Comfortable", item: "Comfortable (default)" },
  wide: { value: "Wide", item: "Wide" },
  full: { value: "Full", item: "Full" },
};

function AppearanceSelect<T extends string>({
  label,
  value,
  labels,
  adornment,
  onChange,
}: {
  label: string;
  value: T;
  labels: Readonly<Record<T, { value: string; item: string }>>;
  adornment?: ReactNode;
  onChange: (value: T) => void;
}) {
  return (
    <div className="w-full sm:w-40">
      <Menu
        align="end"
        trigger={(props) => (
          <button
            type="button"
            {...props}
            aria-label={label}
            className={selectTrigger({
              size: "sm",
              className: "w-full min-w-0",
            })}
          >
            {adornment}
            <span className="min-w-0 flex-1 truncate text-left">
              {labels[value].value}
            </span>
            <ChevronDownIcon className="size-3.5" />
          </button>
        )}
      >
        {(Object.keys(labels) as T[]).map((option) => (
          <MenuItem
            key={option}
            className={selectItem}
            role="menuitemradio"
            aria-checked={value === option}
            onClick={() => onChange(option)}
          >
            {labels[option].item}
          </MenuItem>
        ))}
      </Menu>
    </div>
  );
}

function FontSizeControl({
  value,
  min,
  max,
  label,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  label: string;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <div
      data-size="sm"
      data-slot="number-field"
      className="flex w-28 flex-col items-start gap-2"
    >
      <div
        data-slot="number-field-group"
        className="relative flex w-full justify-between rounded-lg border border-input bg-background not-dark:bg-clip-padding text-base text-foreground shadow-xs/5 ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-data-disabled:not-focus-within:not-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] focus-within:border-ring focus-within:ring-[3px] has-aria-invalid:border-destructive/36 has-autofill:bg-foreground/4 focus-within:has-aria-invalid:border-destructive/64 focus-within:has-aria-invalid:ring-destructive/48 data-disabled:pointer-events-none data-disabled:opacity-64 sm:text-sm dark:bg-input/32 dark:has-autofill:bg-foreground/8 dark:has-aria-invalid:ring-destructive/24 dark:not-data-disabled:not-focus-within:not-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)] [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 [[data-disabled],:focus-within,[aria-invalid]]:shadow-none"
      >
        <input
          type="number"
          min={min}
          max={max}
          step={1}
          aria-label={label}
          value={draft}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            onChange(event.currentTarget.valueAsNumber);
          }}
          onBlur={() => setDraft(String(value))}
          className="h-8.5 in-data-[size=lg]:h-9.5 in-data-[size=sm]:h-7.5 w-full min-w-0 grow bg-transparent in-data-[size=sm]:px-[calc(--spacing(2.5)-1px)] px-[calc(--spacing(3)-1px)] text-center tabular-nums in-data-[size=lg]:leading-9.5 in-data-[size=sm]:leading-7.5 leading-8.5 outline-none [transition:background-color_5000000s_ease-in-out_0s] sm:h-7.5 sm:in-data-[size=lg]:h-8.5 sm:in-data-[size=sm]:h-6.5 sm:in-data-[size=lg]:leading-8.5 sm:in-data-[size=sm]:leading-8.5 sm:leading-7.5"
        />
      </div>
    </div>
  );
}

export function AppearanceSettingsRow({ info }: { info: SettingsRowInfo }) {
  const { appearance, update, preview } = useAppearance();
  const resetAction = <K extends keyof AppearanceSettings>(
    key: K,
    label: string,
  ) =>
    appearance[key] !== defaultAppearance[key] ? (
      <SettingResetButton
        label={label}
        onClick={() => update({ [key]: defaultAppearance[key] })}
      />
    ) : null;
  const row = (control: ReactNode, reset: ReactNode) => (
    <SettingsRow
      id={info.id}
      title={info.title}
      description={info.description}
      control={control}
      resetAction={reset}
    />
  );
  if (info.id in sliders) {
    const slider = sliders[info.id as keyof typeof sliders];
    const value = appearance[slider.key];
    const control = (
      <SettingsSlider
        id={slider.inputId}
        label={slider.label}
        {...appearanceRanges[slider.key]}
        value={value}
        readout={`${value}${slider.unit}`}
        className={
          slider.key === "panelAnimationDurationMs"
            ? "flex w-full items-center gap-3"
            : "flex w-full items-center gap-3 sm:w-52"
        }
        readoutClassName={
          slider.key === "panelAnimationDurationMs" ? "min-w-16" : "min-w-12"
        }
        onPreview={(next) => preview({ [slider.key]: next })}
        onCommit={(next) => update({ [slider.key]: next })}
      />
    );
    return row(
      slider.key === "panelAnimationDurationMs" ? (
        <div className="grid w-full grid-cols-[5rem_minmax(0,1fr)] items-center gap-3 sm:w-auto sm:grid-cols-[7rem_13rem] sm:gap-4">
          <PanelAnimationsPreview durationMs={value} />
          {control}
        </div>
      ) : (
        control
      ),
      resetAction(slider.key, slider.resetLabel),
    );
  }
  if (info.id === "diff-color-scheme")
    return row(
      <AppearanceSelect
        label="Diff colors"
        value={appearance.diffColorScheme}
        labels={diffColorLabels}
        adornment={
          <span
            aria-hidden="true"
            className={
              appearance.diffColorScheme === "blue-orange"
                ? "flex shrink-0 flex-row-reverse gap-1"
                : "flex shrink-0 gap-1"
            }
          >
            <span className="size-2 rounded-full bg-diff-deletion" />
            <span className="size-2 rounded-full bg-diff-addition" />
          </span>
        }
        onChange={(diffColorScheme) => update({ diffColorScheme })}
      />,
      resetAction("diffColorScheme", "diff colors"),
    );
  if (info.id === "theme")
    return row(
      <div
        className="flex items-center gap-1"
        role="group"
        aria-label="Appearance"
      >
        {(["system", "light", "dark"] as const).map((mode) => (
          <Toggle
            key={mode}
            variant="outline"
            size="sm"
            pressed={appearance.themeAppearanceMode === mode}
            onClick={() => update({ themeAppearanceMode: mode })}
          >
            {mode === "system" ? "System" : mode === "light" ? "Light" : "Dark"}
          </Toggle>
        ))}
      </div>,
      null,
    );
  if (info.id === "prompt-font" || info.id === "code-font") {
    const key = info.id === "prompt-font" ? "fontSizePrompt" : "fontSizeCode";
    return row(
      <FontSizeControl
        value={appearance[key]}
        {...appearanceRanges[key]}
        label={
          info.id === "prompt-font" ? "Prompt font size" : "Code font size"
        }
        onChange={(value) => update({ [key]: value })}
      />,
      null,
    );
  }
  if (info.id === "chat-width")
    return row(
      <AppearanceSelect
        label="Chat width"
        value={appearance.chatWidth}
        labels={chatWidthLabels}
        onChange={(chatWidth) => update({ chatWidth })}
      />,
      resetAction("chatWidth", "chat width"),
    );
  return null;
}
