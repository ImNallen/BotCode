// Ported from pingdotgg/t3code v0.0.45 apps/web/src/appearanceFonts.ts (MIT).
/**
 * Font preferences from Settings → Appearance, applied as CSS custom
 * properties. The default stacks mirror the `--font-sans` / `--font-mono`
 * definitions in `t3-theme.css`; a custom family is always prepended to the
 * matching default stack so glyph coverage never regresses.
 */
import type { AppearanceSettings } from "./appearance/settings";
import { ipc } from "./ipc";

export const DEFAULT_SANS_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

// Concrete names first: some engines alias `ui-monospace` to the
// proportional system UI font, which would break every code surface.
export const DEFAULT_CODE_FONT_STACK =
  '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace';

/**
 * Simple typography treats the terminal as another monospace surface. In
 * Advanced mode an empty terminal preference means the terminal default,
 * keeping later code-font changes isolated to code surfaces.
 */
export function resolveTerminalFontPreference(input: {
  readonly advanced: boolean;
  readonly code: string;
  readonly terminal: string;
}): string {
  if (input.advanced) return input.terminal;
  return input.code;
}

export function resolveTerminalFontSizePreference(input: {
  readonly advanced: boolean;
  readonly code: number;
  readonly terminal: number;
}): number {
  if (input.advanced) return input.terminal;
  return input.code;
}

// An empty family is the terminal surface's own default.
export type TerminalFont = Readonly<{ family: string; size: number }>;

export function resolveTerminalFont(
  appearance: AppearanceSettings,
): TerminalFont {
  const advanced = appearance.typographyAdvanced;
  return {
    family: resolveTerminalFontPreference({
      advanced,
      code: appearance.fontFamilyCode,
      terminal: appearance.fontFamilyTerminal,
    }),
    size: resolveTerminalFontSizePreference({
      advanced,
      code: appearance.fontSizeCode,
      terminal: appearance.fontSizeTerminal,
    }),
  };
}

function quoteFontFamilyName(name: string): string {
  const bare = name.trim();
  if (bare.length === 0) return "";
  // Already quoted, or a single ident that needs no quoting.
  if (/^(['"]).*\1$/.test(bare)) return bare;
  if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(bare)) return bare;
  return `"${bare.replaceAll('"', "")}"`;
}

/**
 * Normalize a user-entered family (single name or comma-separated list) into a
 * safe CSS font-family list, or null when the input is effectively empty.
 */
export function cssFontFamilies(input: string): string | null {
  const families = input
    .split(",")
    .map(quoteFontFamilyName)
    .filter((name) => name.length > 0);
  return families.length > 0 ? families.join(", ") : null;
}

/**
 * T3's applyAppearanceFontVariables, returning the declarations so the root
 * writer stays the only code that touches <html>. Unset families are absent,
 * so the stylesheet defaults (and theme changes) stay in charge.
 *
 * Sizes are always present: the interface size drives the root font size (and
 * with it every rem-based dimension), while the prompt and code sizes stay in
 * absolute pixels so they do not scale twice.
 */
export function appearanceFontStyle(
  appearance: AppearanceSettings,
): Readonly<Record<string, string>> {
  const style: Record<string, string> = {};
  const families: ReadonlyArray<
    readonly [variable: string, custom: string, fallback: string]
  > = [
    ["--font-sans", appearance.fontFamilySans, DEFAULT_SANS_FONT_STACK],
    ["--font-mono", appearance.fontFamilyCode, DEFAULT_CODE_FONT_STACK],
    // The composer falls back to whatever the sans preference resolves to.
    ["--font-composer", appearance.fontFamilyComposer, "var(--font-sans)"],
  ];
  for (const [variable, custom, fallback] of families) {
    const list = cssFontFamilies(custom);
    if (list !== null) style[variable] = `${list}, ${fallback}`;
  }
  style["font-size"] = `${appearance.fontSizeInterface}px`;
  style["--font-size-prompt"] = `${appearance.fontSizePrompt}px`;
  style["--font-size-code"] = `${appearance.fontSizeCode}px`;
  // The @pierre/diffs surfaces read their own hook for code text.
  style["--diffs-font-size"] = `${appearance.fontSizeCode}px`;
  // Inherited from the root; only macOS engines honor the property, so no
  // platform gate is needed here. Smoothing on means grayscale `antialiased`
  // (thinner strokes); off restores the platform default, which macOS renders
  // with heavier stem darkening.
  if (appearance.fontSmoothing) style["-webkit-font-smoothing"] = "antialiased";
  return style;
}

const FONT_PROBE_TEXT = "mmmmmmmmMMWli1O0@# fjord";
let fontProbeContext: CanvasRenderingContext2D | null | undefined;

function probeWidth(fontList: string): number | null {
  if (fontProbeContext === undefined) {
    fontProbeContext = document.createElement("canvas").getContext("2d");
  }
  if (fontProbeContext === null) return null;
  fontProbeContext.font = `16px ${fontList}`;
  return fontProbeContext.measureText(FONT_PROBE_TEXT).width;
}

/**
 * Canvas metric probing instead of document.fonts.check(): check() reports
 * true for families that are not installed at all (nothing needs loading), so
 * it cannot filter the dropdown. A family exists when falling back to at
 * least one generic changes the measured advance.
 */
export function isFontFamilyAvailable(family: string): boolean {
  const families = cssFontFamilies(family);
  if (families === null) return false;
  if (/^(system-ui|sans-serif|serif|monospace|ui-monospace)$/i.test(families))
    return true;
  try {
    for (const generic of ["monospace", "serif", "sans-serif"]) {
      const baseline = probeWidth(generic);
      const candidate = probeWidth(`${families}, ${generic}`);
      if (baseline === null || candidate === null) return false;
      if (candidate !== baseline) return true;
    }
    return false;
  } catch {
    return false;
  }
}

const MONOSPACE_PROBE_VARIANTS = [
  "normal 400",
  "normal 700",
  "italic 400",
  "italic 700",
] as const;
const MONOSPACE_PROBE_GLYPHS = [
  "i",
  "M",
  "W",
  "0",
  "@",
  "#",
  ".",
  " ",
] as const;
const MONOSPACE_ADVANCE_TOLERANCE = 0.01;

export function areFontAdvancesMonospace(advances: readonly number[]): boolean {
  const reference = advances[0];
  if (
    reference === undefined ||
    reference <= 0 ||
    advances.some((advance) => !Number.isFinite(advance) || advance <= 0)
  ) {
    return true;
  }
  return advances.every(
    (advance) => Math.abs(advance - reference) < MONOSPACE_ADVANCE_TOLERANCE,
  );
}

/**
 * Whether a family renders every character on the same advance. Cell-grid
 * surfaces (the terminal) require this: a proportional face draws its text
 * narrower than the lattice the cursor and selection are placed on, which
 * reads as ragged gaps and a cursor stranded to the right of the text.
 *
 * Unmeasurable environments answer true, so a missing canvas never blocks a
 * legitimate font.
 */
export function isMonospaceFamily(family: string): boolean {
  const families = cssFontFamilies(family);
  if (families === null) return true;
  try {
    if (fontProbeContext === undefined) {
      fontProbeContext = document.createElement("canvas").getContext("2d");
    }
    if (fontProbeContext === null) return true;
    const context = fontProbeContext;
    // Fall back to a generic mono so an absent face measures as monospace and
    // is left for the normal fallback chain to resolve.
    for (const variant of MONOSPACE_PROBE_VARIANTS) {
      context.font = `${variant} 32px ${families}, monospace`;
      const advances = MONOSPACE_PROBE_GLYPHS.map(
        (glyph) => context.measureText(glyph).width,
      );
      if (!areFontAdvancesMonospace(advances)) return false;
    }
    return true;
  } catch {
    return true;
  }
}

// Nameable faces the platform generics commonly map to, likeliest first.
// Pixel-comparing a generic against these names the actual face; Apple's own
// UI fonts are deliberately not CSS-nameable, so a miss on an Apple platform
// identifies San Francisco itself.
const SANS_GENERIC_CANDIDATES = [
  "Segoe UI",
  "Roboto",
  "Noto Sans",
  "Ubuntu",
  "Cantarell",
  "DejaVu Sans",
  "Liberation Sans",
  "Helvetica Neue",
  "Arial",
] as const;
const MONO_GENERIC_CANDIDATES = [
  "Menlo",
  "Consolas",
  "Cascadia Mono",
  "DejaVu Sans Mono",
  "Ubuntu Mono",
  "Liberation Mono",
  "Noto Sans Mono",
  "Roboto Mono",
  "Monaco",
  "Courier New",
] as const;

const GENERIC_PROBE_TEXT = "RagIl10O@ fjord quiz";

/**
 * Advance width of the probe text laid out by the DOM - not canvas, whose
 * generic-family mapping diverges from real rendering (this engine draws
 * `ui-monospace` as the proportional UI font on canvas but not in CSS).
 * Identical widths at this size mean the same face for practical purposes.
 */
function measureDomProbeWidth(fontFamily: string): number | null {
  try {
    const body = document.body;
    if (!body) return null;
    const span = document.createElement("span");
    span.style.cssText =
      "position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;font-size:100px;";
    span.style.fontFamily = fontFamily;
    span.textContent = GENERIC_PROBE_TEXT;
    body.appendChild(span);
    const width = span.getBoundingClientRect().width;
    span.remove();
    return width > 0 ? width : null;
  } catch {
    return null;
  }
}

function widthsMatch(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.01;
}

/**
 * Name the concrete face a generic keyword renders as, by measuring the
 * generic against nameable candidates. Null when the face cannot be
 * identified (and the platform gives no definitional answer).
 */
function resolveGenericFamilyLabel(generic: string): string | null {
  const lower = generic.toLowerCase();
  if (lower === "serif") return null;
  const monoLike = lower === "ui-monospace" || lower === "monospace";
  const genericWidth = measureDomProbeWidth(generic);
  if (genericWidth === null) return null;
  for (const candidate of monoLike
    ? MONO_GENERIC_CANDIDATES
    : SANS_GENERIC_CANDIDATES) {
    if (!isFontFamilyAvailable(candidate)) continue;
    const candidateWidth = measureDomProbeWidth(`"${candidate}"`);
    if (candidateWidth !== null && widthsMatch(genericWidth, candidateWidth)) {
      return candidate;
    }
  }
  // No nameable face matched; on Apple platforms that means one of the San
  // Francisco faces, which CSS cannot name. Comparing against -apple-system
  // tells the UI face apart from SF Mono.
  if (/mac|iphone|ipad|ipod/i.test(navigator.platform)) {
    const systemWidth = measureDomProbeWidth("-apple-system");
    if (systemWidth !== null && widthsMatch(genericWidth, systemWidth))
      return "SF Pro";
    return monoLike ? "SF Mono" : "SF Pro";
  }
  return null;
}

/**
 * The first family of a default stack that will actually render - what the
 * "Default" choice means on this machine. Concrete names are probed for
 * availability; generic keywords are resolved to the face they draw with
 * where identifiable. Null when nothing can be named.
 */
export function resolveDefaultFamilyLabel(stack: string): string | null {
  for (const raw of stack.split(",")) {
    const family = raw.trim().replace(/^(['"])(.*)\1$/, "$2");
    if (family.length === 0) continue;
    if (
      /^(system-ui|sans-serif|serif|monospace|ui-monospace|-apple-system|BlinkMacSystemFont)$/i.test(
        family,
      )
    ) {
      const resolved = resolveGenericFamilyLabel(family);
      if (resolved !== null) return resolved;
      continue;
    }
    if (isFontFamilyAvailable(family)) return family;
  }
  return null;
}

export interface InstalledFontFamiliesResult {
  readonly families: readonly string[];
  /**
   * "unsupported" - this platform cannot list its fonts, so the rows keep the
   * plain family-name input.
   */
  readonly status: "granted" | "unsupported";
}

let installedFamiliesCache: Promise<InstalledFontFamiliesResult> | null = null;

/**
 * Every installed family. T3 asks Chromium's Local Font Access API, which
 * WKWebView lacks, so Bot Code asks the native side (NSFontManager on macOS;
 * an empty list elsewhere). Rust already dedupes, drops the "."-prefixed
 * macOS-internal faces and sorts. No permission prompt exists, so callers
 * can discover eagerly.
 */
export function queryInstalledFontFamilies(): Promise<InstalledFontFamiliesResult> {
  installedFamiliesCache ??= ipc.installedFontFamilies().then(
    (families): InstalledFontFamiliesResult =>
      families.length > 0
        ? { families, status: "granted" }
        : { families: [], status: "unsupported" },
    (): InstalledFontFamiliesResult => ({
      families: [],
      status: "unsupported",
    }),
  );
  return installedFamiliesCache;
}
