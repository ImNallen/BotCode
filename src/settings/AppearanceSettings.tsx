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
import {
  DEFAULT_CODE_FONT_STACK,
  DEFAULT_SANS_FONT_STACK,
  isFontFamilyAvailable,
  isMonospaceFamily,
  resolveDefaultFamilyLabel,
  resolveTerminalFont,
} from "../appearanceFonts";
import { Switch, Toggle, selectItem, selectTrigger } from "../ui/controls";
import { Input } from "../ui/input";
import { Menu, MenuItem } from "../ui/menu";
import {
  discoverInstalledFonts,
  FontFamilyPicker,
  useFontEnumeration,
} from "./FontFamilyPicker";
import { PanelAnimationsPreview } from "./PanelAnimationsPreview";
import {
  CodeFontPreview,
  PromptFontPreview,
  TerminalFontPreview,
} from "./SettingsFontPreviews";
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

export function fontSizeOptions(
  key:
    | "fontSizeInterface"
    | "fontSizePrompt"
    | "fontSizeCode"
    | "fontSizeTerminal",
): number[] {
  const { min, max } = appearanceRanges[key];
  return Array.from({ length: max - min + 1 }, (_, index) => min + index);
}

function FontSizeSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: number;
  options: readonly number[];
  onChange: (value: number) => void;
}) {
  return (
    <Menu
      align="end"
      trigger={(props) => (
        <button
          type="button"
          {...props}
          aria-label={label}
          data-slot="select-trigger"
          className={selectTrigger({ size: "sm", className: "w-22 shrink-0" })}
        >
          <span className="flex-1 truncate">{value} px</span>
          <ChevronDownIcon className="-me-1 size-3 opacity-50" />
        </button>
      )}
    >
      {options.map((px) => (
        <MenuItem
          key={px}
          className={selectItem}
          role="menuitemradio"
          aria-checked={value === px}
          onClick={() => onChange(px)}
        >
          {px} px
        </MenuItem>
      ))}
    </Menu>
  );
}

let defaultFamilyLabels: { sans: string; code: string } | undefined;
// An unset preference shows the font it resolves to on this machine; the
// default stacks are the platform's own faces, so the name is probed, not
// hardcoded. Probing measures the DOM, so it runs once.
function fontDefaultFamilies() {
  defaultFamilyLabels ??= {
    sans:
      resolveDefaultFamilyLabel(DEFAULT_SANS_FONT_STACK) ?? "System default",
    code:
      resolveDefaultFamilyLabel(DEFAULT_CODE_FONT_STACK) ?? "System monospace",
  };
  return defaultFamilyLabels;
}

// The family a settled draft commits, or null when it stays in the field
// flagged: the terminal would silently fall back to its default, so the row
// must not claim it took the value. Empty is an explicit clear.
export function fontFamilyCommit(
  draft: string,
  requireMonospace: boolean,
): string | null {
  if (draft.trim().length === 0) return draft;
  return isFontFamilyAvailable(draft) &&
    (!requireMonospace || isMonospaceFamily(draft))
    ? draft
    : null;
}

// Flag an unknown name only once typing pauses, and never for an empty
// field - that is the starting state, not a rejected entry.
export function fontDraftInvalid(
  draft: string,
  settled: boolean,
  committed: string,
): boolean {
  const trimmed = draft.trim();
  return settled && trimmed.length > 0 && trimmed !== committed.trim();
}

export function FontFamilySettingsRow({
  id,
  title,
  description,
  defaultFamily,
  defaultValue,
  preview,
  value,
  onValueChange,
  onReset,
  requireMonospace = false,
  size,
}: {
  id: string;
  title: string;
  description: string;
  /** What an unset preference renders as, e.g. "Menlo". */
  defaultFamily: string;
  defaultValue: string;
  preview?: ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  onReset: () => void;
  requireMonospace?: boolean;
  size: {
    label: string;
    options: readonly number[];
    value: number;
    defaultValue: number;
    onChange: (value: number) => void;
  };
}) {
  const trimmed = value.trim();
  // The fallback input edits a draft; the preference only commits once typing
  // pauses and the text probes as an available font (or is an explicit
  // clear), so the current font holds and nothing reflows mid-word.
  const [draft, setDraft] = useState(value);
  const [draftSettled, setDraftSettled] = useState(true);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastValueRef = useRef(value);
  const clearCommitTimer = () => {
    if (commitTimerRef.current === null) return;
    clearTimeout(commitTimerRef.current);
    commitTimerRef.current = null;
  };
  if (lastValueRef.current !== value) {
    // The committed value changed externally (reset, picker selection);
    // adopt it and drop any pending commit of a stale draft.
    lastValueRef.current = value;
    clearCommitTimer();
    setDraft(value);
    setDraftSettled(true);
  }
  useEffect(() => clearCommitTimer, []);
  const commitDraft = (next: string) => {
    setDraftSettled(true);
    const family = fontFamilyCommit(next, requireMonospace);
    if (family !== null) onValueChange(family);
  };
  const flushDraft = () => {
    if (commitTimerRef.current === null) return;
    clearCommitTimer();
    commitDraft(draft);
  };
  const draftPending = fontDraftInvalid(draft, draftSettled, value);
  const resetAction =
    value !== defaultValue || size.value !== size.defaultValue ? (
      <SettingResetButton
        label={title.toLowerCase()}
        onClick={() => {
          clearCommitTimer();
          setDraft(defaultValue);
          setDraftSettled(true);
          onReset();
        }}
      />
    ) : null;
  const fontEnumeration = useFontEnumeration();
  // Every row starts on the plain input. Where the platform lists its fonts,
  // the control then upgrades to the picker - popped open when the swap
  // happens under focus, so the interaction continues without a second click.
  const inputFocusedRef = useRef(false);
  const familyControl =
    fontEnumeration.status === "granted" ? (
      <FontFamilyPicker
        ariaLabel={`${title} family`}
        defaultFamily={defaultFamily}
        selectedFamily={trimmed}
        requireMonospace={requireMonospace}
        initialOpen={inputFocusedRef.current}
        onSelect={onValueChange}
      />
    ) : (
      <Input
        size="sm"
        aria-label={`${title} family`}
        aria-invalid={draftPending || undefined}
        autoCapitalize="off"
        autoComplete="off"
        className="min-w-0 flex-1"
        maxLength={200}
        onFocus={() => {
          inputFocusedRef.current = true;
          discoverInstalledFonts();
        }}
        onBlur={() => {
          inputFocusedRef.current = false;
          flushDraft();
        }}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setDraft(next);
          setDraftSettled(false);
          clearCommitTimer();
          commitTimerRef.current = setTimeout(() => {
            commitTimerRef.current = null;
            commitDraft(next);
          }, 400);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") flushDraft();
          if (event.key === "Escape") {
            // Discard uncommitted typing without closing the settings page,
            // which is what an unhandled Escape does.
            event.preventDefault();
            event.stopPropagation();
            clearCommitTimer();
            setDraft(value);
            setDraftSettled(true);
          }
        }}
        placeholder={defaultFamily}
        spellCheck={false}
        value={draft}
      />
    );
  return (
    <SettingsRow
      id={id}
      title={title}
      description={description}
      resetAction={resetAction}
      control={
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <div className="min-w-0 flex-1 sm:w-44 sm:flex-none">
            {familyControl}
          </div>
          <FontSizeSelect
            label={size.label}
            value={size.value}
            options={size.options}
            onChange={size.onChange}
          />
        </div>
      }
    >
      {preview}
    </SettingsRow>
  );
}

type FontFamilyKey =
  | "fontFamilySans"
  | "fontFamilyComposer"
  | "fontFamilyCode"
  | "fontFamilyTerminal";
type FontSizeKey =
  | "fontSizeInterface"
  | "fontSizePrompt"
  | "fontSizeCode"
  | "fontSizeTerminal";
const fontRows = {
  "interface-font": {
    family: "fontFamilySans",
    size: "fontSizeInterface",
    sizeLabel: "Interface font size",
    monospace: false,
  },
  "prompt-font": {
    family: "fontFamilyComposer",
    size: "fontSizePrompt",
    sizeLabel: "Prompt font size",
    monospace: false,
  },
  "code-font": {
    family: "fontFamilyCode",
    size: "fontSizeCode",
    sizeLabel: "Code font size",
    monospace: true,
  },
  "terminal-font": {
    family: "fontFamilyTerminal",
    size: "fontSizeTerminal",
    sizeLabel: "Terminal font size",
    monospace: true,
  },
} as const satisfies Record<
  string,
  {
    family: FontFamilyKey;
    size: FontSizeKey;
    sizeLabel: string;
    monospace: boolean;
  }
>;

function AppearanceFontRow({
  rowId,
  info,
}: {
  rowId: keyof typeof fontRows;
  info: SettingsRowInfo;
}) {
  const { appearance, update } = useAppearance();
  const row = fontRows[rowId];
  const defaults = fontDefaultFamilies();
  const advanced = appearance.typographyAdvanced;
  // The two-font view: the prompt follows the interface font and the
  // terminal follows the monospace font, so the previews under each row show
  // every surface the choice reaches.
  const simpleCode = rowId === "code-font" && !advanced;
  const preview =
    rowId === "prompt-font" || (rowId === "interface-font" && !advanced) ? (
      <PromptFontPreview />
    ) : rowId === "code-font" ? (
      <>
        <CodeFontPreview />
        {simpleCode ? (
          <TerminalFontPreview font={resolveTerminalFont(appearance)} />
        ) : null}
      </>
    ) : rowId === "terminal-font" ? (
      <TerminalFontPreview
        font={resolveTerminalFont({ ...appearance, typographyAdvanced: true })}
      />
    ) : undefined;
  return (
    <FontFamilySettingsRow
      id={info.id}
      title={simpleCode ? "Monospace font" : info.title}
      description={
        simpleCode
          ? "Code blocks, diffs, file previews, and the terminal."
          : info.description
      }
      defaultFamily={
        row.monospace
          ? defaults.code
          : rowId === "prompt-font"
            ? appearance.fontFamilySans.trim() || defaults.sans
            : defaults.sans
      }
      defaultValue={defaultAppearance[row.family]}
      value={appearance[row.family]}
      onValueChange={(family) => update({ [row.family]: family })}
      onReset={() =>
        update({
          [row.family]: defaultAppearance[row.family],
          [row.size]: defaultAppearance[row.size],
        })
      }
      requireMonospace={row.monospace}
      size={{
        label: row.sizeLabel,
        options: fontSizeOptions(row.size),
        value: appearance[row.size],
        defaultValue: defaultAppearance[row.size],
        onChange: (value) => update({ [row.size]: value }),
      }}
      preview={preview}
    />
  );
}

/**
 * T3's Typography header switch: the two-font view by default, the
 * per-surface override rows when on.
 */
export function TypographyAdvancedSwitch() {
  const { appearance, update } = useAppearance();
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground">
      Advanced
      <Switch
        checked={appearance.typographyAdvanced}
        onCheckedChange={(typographyAdvanced) => update({ typographyAdvanced })}
        aria-label="Show advanced typography settings"
      />
    </label>
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
  if (info.id in fontRows)
    return (
      <AppearanceFontRow rowId={info.id as keyof typeof fontRows} info={info} />
    );
  if (info.id === "font-smoothing")
    return row(
      <Switch
        checked={appearance.fontSmoothing}
        onCheckedChange={(fontSmoothing) => update({ fontSmoothing })}
        aria-label="Font smoothing"
      />,
      resetAction("fontSmoothing", "font smoothing"),
    );
  if (info.id === "word-wrap")
    return row(
      <Switch
        checked={appearance.wordWrap}
        onCheckedChange={(wordWrap) => update({ wordWrap })}
        aria-label="Wrap code, tables, diffs, and file previews by default"
      />,
      resetAction("wordWrap", "word wrapping"),
    );
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
