// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/settings/FontFamilyPicker.tsx and ui/combobox.tsx (MIT).
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  cssFontFamilies,
  isMonospaceFamily,
  queryInstalledFontFamilies,
} from "../appearanceFonts";
import { cn } from "../lib/cn";
import { candidateKeyboardIndex } from "../panel/pullRequestPickers.logic";
import { selectTrigger } from "../ui/controls";
import { Menu } from "../ui/menu";

export const DEFAULT_FONT_VALUE = "__default__";
// LegendList is not a Bot Code dependency, so the list windows fixed-height
// rows itself. T3 estimates 30px rows, caps the list at 288px and draws 360px
// beyond the viewport.
const ROW_HEIGHT = 30;
const MAX_LIST_HEIGHT = 288;
const OVERSCAN_ROWS = 12;

type FontEnumerationState =
  | { readonly status: "unknown" }
  | { readonly status: "granted"; readonly families: readonly string[] }
  | { readonly status: "unavailable" };

// Shared across every row: once one row learns the fonts, the others follow
// without re-querying, and the rows swap to the picker together.
let enumerationState: FontEnumerationState = { status: "unknown" };
const enumerationListeners = new Set<() => void>();
let enumerationLoad: Promise<void> | null = null;

function subscribeToEnumeration(listener: () => void): () => void {
  enumerationListeners.add(listener);
  return () => enumerationListeners.delete(listener);
}

function readEnumerationState(): FontEnumerationState {
  return enumerationState;
}

export function discoverInstalledFonts(): void {
  if (enumerationState.status !== "unknown" || enumerationLoad !== null) return;
  enumerationLoad = queryInstalledFontFamilies().then((result) => {
    enumerationState =
      result.status === "granted"
        ? { status: "granted", families: result.families }
        : { status: "unavailable" };
    enumerationLoad = null;
    for (const listener of enumerationListeners) listener();
  });
}

/**
 * Whether this platform can list installed fonts. Rows render a plain
 * family-name input until the state is known granted, then upgrade to the
 * picker. The native list needs no permission prompt, so discovery starts at
 * mount.
 */
export function useFontEnumeration(): FontEnumerationState {
  useEffect(discoverInstalledFonts, []);
  return useSyncExternalStore(
    subscribeToEnumeration,
    readEnumerationState,
    readEnumerationState,
  );
}

/** The default sentinel first while the query is empty, then every match. */
export function fontPickerItems(
  families: readonly string[],
  query: string,
): string[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [DEFAULT_FONT_VALUE, ...families];
  return families.filter((family) => family.toLowerCase().includes(needle));
}

/** The rows to render for a scroll position: the viewport plus overscan. */
export function fontPickerWindow(
  scrollTop: number,
  count: number,
): { start: number; end: number } {
  const first = Math.floor(scrollTop / ROW_HEIGHT);
  const last = Math.ceil((scrollTop + MAX_LIST_HEIGHT) / ROW_HEIGHT);
  return {
    start: Math.max(0, first - OVERSCAN_ROWS),
    end: Math.min(count, last + OVERSCAN_ROWS),
  };
}

/**
 * A searchable picker over every installed family, the way native editors
 * list system fonts. The trigger always names the font in use: the committed
 * family, or what the default stack resolves to on this machine.
 */
export function FontFamilyPicker({
  ariaLabel,
  defaultFamily,
  selectedFamily,
  requireMonospace = false,
  initialOpen = false,
  onSelect,
}: {
  ariaLabel: string;
  /** What an unset preference renders as, e.g. "Menlo". */
  defaultFamily: string;
  /** Committed family name; empty string means the default is in use. */
  selectedFamily: string;
  requireMonospace?: boolean;
  /** Open the popup on mount - set when the control upgrades under focus. */
  initialOpen?: boolean;
  onSelect: (family: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (initialOpen) setOpen(true);
    // The prop is only meaningful at mount - the control just swapped in
    // under an active focus - so later changes are deliberately ignored.
  }, []);
  const enumeration = useFontEnumeration();

  const families = useMemo(() => {
    if (enumeration.status !== "granted") return [];
    return requireMonospace
      ? enumeration.families.filter(isMonospaceFamily)
      : enumeration.families;
  }, [enumeration, requireMonospace]);
  const items = useMemo(
    () => fontPickerItems(families, query),
    [families, query],
  );
  const activeIndex = Math.min(active, Math.max(0, items.length - 1));
  const selectedValue =
    selectedFamily.length === 0 ? DEFAULT_FONT_VALUE : selectedFamily;
  const listHeight = Math.min(items.length * ROW_HEIGHT, MAX_LIST_HEIGHT);
  const { start, end } = fontPickerWindow(scrollTop, items.length);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setQuery("");
      setActive(0);
      setScrollTop(0);
    }
  };

  const handlePick = (value: string) => {
    setOpen(false);
    onSelect(value === DEFAULT_FONT_VALUE ? "" : value);
  };

  // Keyboard highlights must pull the windowed row into view, or arrow keys
  // walk past the rendered rows and navigate blind.
  const highlight = (index: number) => {
    setActive(index);
    const element = list.current;
    if (!element) return;
    const top = index * ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + ROW_HEIGHT > element.scrollTop + listHeight)
      element.scrollTop = top + ROW_HEIGHT - listHeight;
  };

  return (
    <Menu
      open={open}
      onOpenChange={handleOpenChange}
      popupKind={{ kind: "dialog", label: ariaLabel }}
      align="end"
      className="flex w-72 flex-col"
      contentClassName="flex min-w-0 flex-1 flex-col overflow-hidden text-foreground p-0"
      trigger={(props) => (
        <button
          type="button"
          {...props}
          aria-label={ariaLabel}
          data-slot="select-trigger"
          className={selectTrigger({ size: "sm" })}
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {selectedFamily.length === 0 ? defaultFamily : selectedFamily}
          </span>
          <ChevronDownIcon
            aria-hidden
            className="-me-1 size-3 shrink-0 opacity-50"
          />
        </button>
      )}
    >
      <div className="min-w-0 shrink-0 px-3 pt-2.5">
        <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
          />
          <input
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={`${id}-list`}
            aria-activedescendant={
              items.length ? `${id}-${activeIndex}` : undefined
            }
            aria-label="Search fonts"
            placeholder="Search fonts…"
            value={query}
            spellCheck={false}
            onChange={(event) => {
              setQuery(event.target.value);
              highlight(0);
            }}
            className="h-6.5 w-full bg-transparent ps-5 font-sans text-sm leading-6.5 outline-none"
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              const next = candidateKeyboardIndex(
                event.key,
                activeIndex,
                items.length,
              );
              if (next !== undefined) {
                event.preventDefault();
                highlight(next);
              } else if (event.key === "Enter") {
                event.preventDefault();
                const item = items[activeIndex];
                if (item !== undefined) handlePick(item);
              }
            }}
          />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {items.length === 0 ? (
          <div className="p-2 text-center text-base text-muted-foreground sm:text-sm">
            No fonts found.
          </div>
        ) : null}
        <div
          ref={list}
          role="listbox"
          id={`${id}-list`}
          aria-label={ariaLabel}
          className="relative min-h-0 w-full overflow-y-auto px-1 not-empty:py-1"
          style={{ height: items.length ? listHeight + 8 : 0 }}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          {items.length ? (
            <div
              className="relative"
              style={{ height: items.length * ROW_HEIGHT }}
            >
              {items.slice(start, end).map((item, offset) => {
                const index = start + offset;
                const isDefault = item === DEFAULT_FONT_VALUE;
                const family = isDefault ? defaultFamily : item;
                return (
                  <button
                    type="button"
                    role="option"
                    id={`${id}-${index}`}
                    key={item}
                    aria-selected={item === selectedValue}
                    tabIndex={-1}
                    data-selected={item === selectedValue ? "" : undefined}
                    data-highlighted={index === activeIndex ? "" : undefined}
                    onPointerMove={() => setActive(index)}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => handlePick(item)}
                    style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
                    className={cn(
                      "absolute inset-x-0 flex cursor-pointer items-center rounded-sm px-2 py-1 text-left text-base outline-none not-data-disabled:hover:bg-accent data-selected:bg-foreground/[0.08] data-selected:text-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground [&[data-highlighted][data-selected]]:bg-accent [&[data-highlighted][data-selected]]:text-accent-foreground sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
                    )}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2 [&_svg:not([class*='text-'])]:text-muted-foreground">
                      <div className="flex w-full min-w-0 items-center justify-between gap-2">
                        <span
                          className="min-w-0 truncate"
                          style={{
                            fontFamily: cssFontFamilies(family) ?? undefined,
                          }}
                        >
                          {family}
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          {isDefault ? (
                            <span className="text-3xs text-muted-foreground/60">
                              default
                            </span>
                          ) : null}
                          {item === selectedValue ? (
                            <CheckIcon className="size-3.5 text-muted-foreground" />
                          ) : null}
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
    </Menu>
  );
}
