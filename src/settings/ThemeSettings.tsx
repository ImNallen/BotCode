// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/settings/ThemeSettings.tsx (MIT). The import dialog's open state lives here, and export goes through a native save panel.
import {
  CheckIcon,
  CopyIcon,
  MoonIcon,
  PaintbrushIcon,
  PenLineIcon,
  PlusIcon,
  SunIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  useCustomThemes,
  useThemeSelection,
} from "../appearance/AppearanceRoot";
import { ipc } from "../ipc";
import { cn } from "../lib/cn";
import { notifyEditorResult } from "../lib/editorActions";
import {
  getThemeDefinition,
  getThemeModes,
  removeCustomThemes,
  serializeThemeFile,
  type ThemeAppearance,
  type ThemeDefinition,
  T3_CHAT_THEME,
  EMBER_THEME,
  GROVE_THEME,
  IRIS_THEME,
  OCEAN_THEME,
} from "../themePalette";
import { Button } from "../ui/controls";
import { Dialog, DialogDescription, DialogTitle } from "../ui/dialog";
import { Tooltip } from "../ui/tooltip";
import {
  STANDARD_THEME_CARDS,
  getThemeCardDefinition,
  previewColorsOf,
  ThemePreviewCircles,
  ThemePreviewCircle,
  type ThemeCardDefinition,
  type ThemeMode,
} from "./ThemePreviewCircles";
import { ThemeImportDialog } from "./ThemeImportDialog";
import { ThemeWireframe } from "./ThemeWireframe";
import { useThemeEditorStore } from "./themeEditorStore";

const MAINTAINER_THEMES: ReadonlyArray<ThemeDefinition> = [
  T3_CHAT_THEME,
  GROVE_THEME,
  OCEAN_THEME,
  EMBER_THEME,
  IRIS_THEME,
];

function collectionVariantLabels(
  themes: ReadonlyArray<ThemeDefinition>,
): ReadonlyArray<string> {
  if (themes.length === 0) return [];
  const words = themes.map((theme) => theme.label.trim().split(/\s+/));
  const firstWords = words[0]!;
  const sharedWordCount = firstWords.findIndex((word, index) =>
    words.some(
      (labelWords) =>
        labelWords[index]?.toLocaleLowerCase() !== word.toLocaleLowerCase(),
    ),
  );
  const prefixLength =
    sharedWordCount === -1 ? firstWords.length - 1 : sharedWordCount;

  return themes.map((theme, index) => {
    const shortLabel = words[index]
      ?.slice(Math.max(0, prefixLength))
      .join(" ")
      .trim();
    return shortLabel || theme.label;
  });
}

async function exportThemeFile(theme: ThemeDefinition): Promise<void> {
  try {
    await ipc.exportThemeFile(`${theme.id}.json`, serializeThemeFile(theme));
  } catch (error) {
    notifyEditorResult(
      "error",
      "Couldn’t export theme",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function ThemeLibraryCard({
  theme,
  isActive,
  onUse,
  onUseMode,
  activeModes,
  onEdit,
  onDuplicate,
  onDownload,
  onRemove,
  variantNavigation,
}: {
  theme: ThemeCardDefinition;
  isActive: boolean;
  onUse: () => void;
  onUseMode: (mode: ThemeMode) => void;
  activeModes: ReadonlyArray<ThemeMode>;
  onEdit?: () => void;
  onDuplicate?: () => void;
  onDownload?: () => void;
  onRemove?: () => void;
  variantNavigation?: {
    collectionLabel: string;
    options: ReadonlyArray<{
      themeIndex: number;
      label: string;
      activeModes: ReadonlyArray<ThemeMode>;
      preview: ThemeCardDefinition["previews"][number];
    }>;
    onSelectAndUse: (themeIndex: number, mode: ThemeAppearance) => void;
  };
}) {
  const [radialModeOpen, setRadialModeOpen] = useState<ThemeAppearance | null>(
    null,
  );
  const radialModeGroups = (["light", "dark"] as const).map((mode) => {
    const options =
      variantNavigation?.options.flatMap((option) => {
        const preview = option.preview;
        return preview.mode === mode ? [{ option, preview }] : [];
      }) ?? [];
    return {
      mode,
      options,
      selected:
        options.find(({ option }) => option.activeModes.includes(mode)) ??
        options[0],
    };
  });
  return (
    // The card surface stays a plain div (buttons cannot nest inside a button
    // role); the title button and mode circles carry the accessible actions,
    // while the card click is a pointer-only convenience.
    <div
      className={cn(
        "cursor-pointer overflow-hidden rounded-xl border border-border/70 bg-card/60 transition-colors hover:bg-accent/10",
        isActive && "bg-accent/30",
      )}
      data-theme-library-card={theme.id}
      onClick={onUse}
      style={
        isActive ? { boxShadow: "inset 0 0 0 1px var(--ring)" } : undefined
      }
    >
      <div className="relative">
        {variantNavigation ? (
          <div
            aria-label="Light and dark theme variants"
            className="relative h-20"
            role="group"
            onBlurCapture={(event) => {
              const nextTarget = event.relatedTarget;
              if (
                !(nextTarget instanceof Node) ||
                !event.currentTarget.contains(nextTarget)
              ) {
                setRadialModeOpen(null);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setRadialModeOpen(null);
            }}
            onMouseLeave={() => setRadialModeOpen(null)}
          >
            {radialModeGroups.map(({ mode, options, selected }) => {
              if (!selected) return null;
              const rootOffsetX = mode === "light" ? -52 : 52;
              const isOpen = radialModeOpen === mode;
              const isActive = selected.option.activeModes.includes(mode);
              const modeLabel = mode === "light" ? "Light" : "Dark";
              return (
                <div className="contents" key={mode}>
                  <Tooltip content={`${modeLabel}: ${selected.option.label}`}>
                    <button
                      aria-label={
                        options.length > 1
                          ? `Choose ${mode} variant, ${options.length} options, currently ${selected.option.label}`
                          : `Use ${mode} variant, currently ${selected.option.label}`
                      }
                      aria-pressed={isActive}
                      className="absolute left-1/2 top-2 z-20 flex size-14 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      style={{
                        transform: `translateX(calc(-50% + ${rootOffsetX}px))`,
                      }}
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        variantNavigation.onSelectAndUse(
                          selected.option.themeIndex,
                          mode,
                        );
                      }}
                      onFocus={() => setRadialModeOpen(mode)}
                      onMouseEnter={() => setRadialModeOpen(mode)}
                    >
                      <ThemePreviewCircle
                        colors={selected.preview.colors}
                        mode={selected.preview.mode}
                      />
                      {isActive ? (
                        <span
                          aria-hidden
                          className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-ring"
                        />
                      ) : null}
                      {isActive ? (
                        <span className="pointer-events-none absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full border border-border/70 bg-background text-foreground shadow-sm">
                          {mode === "light" ? (
                            <SunIcon className="size-2.5" />
                          ) : (
                            <MoonIcon className="size-2.5" />
                          )}
                        </span>
                      ) : null}
                    </button>
                  </Tooltip>
                  <span
                    className="pointer-events-none absolute bottom-0 left-1/2 inline-flex max-w-24 -translate-x-1/2 items-center gap-1 text-2xs font-medium text-foreground"
                    style={{ marginLeft: rootOffsetX }}
                  >
                    <span className="truncate">{selected.option.label}</span>
                    {options.length > 1 ? (
                      <span className="shrink-0 rounded-full bg-muted px-1 text-3xs text-muted-foreground">
                        +{options.length - 1}
                      </span>
                    ) : null}
                  </span>
                  {options.length > 1
                    ? options.map(({ option, preview }, optionIndex) => {
                        const progress =
                          optionIndex / (options.length - 1) - 0.5;
                        const childOffsetX = rootOffsetX + progress * 68;
                        const childOffsetY = Math.abs(progress) * 10;
                        const optionIsActive =
                          option.activeModes.includes(mode);
                        return (
                          <Tooltip
                            key={option.label}
                            content={`Use ${option.label} for ${mode} mode`}
                          >
                            <button
                              aria-label={`Use ${option.label} for ${mode} mode${optionIsActive ? ", currently active" : ""}`}
                              aria-pressed={optionIsActive}
                              className={cn(
                                "absolute left-1/2 top-1 z-30 flex size-7 items-center justify-center rounded-full bg-background shadow-sm outline-none transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring",
                                optionIsActive
                                  ? "ring-2 ring-ring"
                                  : "ring-1 ring-border/70",
                              )}
                              style={{
                                opacity: isOpen ? 1 : 0,
                                pointerEvents: isOpen ? "auto" : "none",
                                transform: `translate(calc(-50% + ${isOpen ? childOffsetX : rootOffsetX}px), ${isOpen ? childOffsetY : 28}px) scale(${isOpen ? 1 : 0.55})`,
                                transitionDelay: isOpen
                                  ? `${optionIndex * 35}ms`
                                  : "0ms",
                              }}
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                variantNavigation.onSelectAndUse(
                                  option.themeIndex,
                                  mode,
                                );
                              }}
                              onFocus={() => setRadialModeOpen(mode)}
                              onMouseEnter={() => setRadialModeOpen(mode)}
                            >
                              <span className="pointer-events-none scale-[0.43]">
                                <ThemePreviewCircle
                                  colors={preview.colors}
                                  mode={preview.mode}
                                />
                              </span>
                            </button>
                          </Tooltip>
                        );
                      })
                    : null}
                </div>
              );
            })}
          </div>
        ) : (
          <ThemePreviewCircles
            label={theme.label}
            activeModes={activeModes}
            onSelectMode={onUseMode}
            previews={theme.previews}
          />
        )}
      </div>
      <div className="flex items-center gap-2 px-3 pb-3 pt-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <button
              aria-label={`Use ${variantNavigation ? `${variantNavigation.collectionLabel}, ${theme.label} variant` : `${theme.label} theme`}${isActive ? ", currently active" : ""}`}
              aria-pressed={isActive}
              className="min-w-0 cursor-pointer truncate rounded-sm text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onUse();
              }}
            >
              {variantNavigation?.collectionLabel ?? theme.label}
            </button>
          </div>
        </div>
        {onEdit || onDuplicate || onDownload || onRemove ? (
          <div className="flex shrink-0 items-center gap-1">
            {onDuplicate ? (
              <Tooltip content="Duplicate theme">
                <Button
                  aria-label={`Duplicate ${theme.label}`}
                  size="icon-xs"
                  variant="ghost"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDuplicate();
                  }}
                >
                  <CopyIcon />
                </Button>
              </Tooltip>
            ) : null}
            {onEdit ? (
              <Tooltip content="Edit theme">
                <Button
                  aria-label={`Edit ${theme.label}`}
                  size="icon-xs"
                  variant="ghost"
                  onClick={(event) => {
                    event.stopPropagation();
                    onEdit();
                  }}
                >
                  <PenLineIcon />
                </Button>
              </Tooltip>
            ) : null}
            {onDownload ? (
              <Tooltip content="Export theme file">
                <Button
                  aria-label={`Export ${theme.label}`}
                  size="icon-xs"
                  variant="ghost"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDownload();
                  }}
                >
                  <UploadIcon />
                </Button>
              </Tooltip>
            ) : null}
            {onRemove ? (
              <Tooltip
                content={variantNavigation ? "Remove themes" : "Remove theme"}
              >
                <Button
                  aria-label={
                    variantNavigation
                      ? `Remove themes from ${variantNavigation.collectionLabel}`
                      : `Remove ${theme.label}`
                  }
                  size="icon-xs"
                  variant="ghost-destructive"
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemove();
                  }}
                >
                  <Trash2Icon />
                </Button>
              </Tooltip>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CustomThemeCollectionCard({
  themes,
  activeModesFor,
  onUse,
  onUseMode,
  onDuplicate,
  onEdit,
  onDownload,
  onRemove,
}: {
  themes: ReadonlyArray<ThemeDefinition>;
  activeModesFor: (themeId: string) => ReadonlyArray<ThemeMode>;
  onUse: (theme: ThemeDefinition) => void;
  onUseMode: (theme: ThemeDefinition, mode: ThemeMode) => void;
  onDuplicate: (theme: ThemeDefinition) => void;
  onEdit: (theme: ThemeDefinition) => void;
  onDownload: (theme: ThemeDefinition) => void;
  onRemove: (theme: ThemeDefinition) => void;
}) {
  const [variantIndex, setVariantIndex] = useState(() => {
    const activeIndex = themes.findIndex(
      (theme) => activeModesFor(theme.id).length > 0,
    );
    return activeIndex < 0 ? 0 : activeIndex;
  });
  const safeIndex = Math.min(variantIndex, themes.length - 1);
  const theme = themes[safeIndex];

  useEffect(() => {
    if (variantIndex !== safeIndex) setVariantIndex(safeIndex);
  }, [safeIndex, variantIndex]);

  if (!theme) return null;
  const collectionLabel = theme.collection?.label ?? theme.label;
  const variantLabels = collectionVariantLabels(themes);
  const defaultLightTheme = themes.find((candidate) =>
    getThemeModes(candidate).includes("light"),
  );
  const defaultDarkTheme = themes.find((candidate) =>
    getThemeModes(candidate).includes("dark"),
  );
  const selectCollectionDefaults = () => {
    if (themes.length === 1) {
      onUse(theme);
      return;
    }
    if (defaultLightTheme) onUseMode(defaultLightTheme, "light");
    if (defaultDarkTheme) onUseMode(defaultDarkTheme, "dark");
    setVariantIndex(0);
  };

  return (
    <ThemeLibraryCard
      activeModes={activeModesFor(theme.id)}
      isActive={false}
      onDuplicate={() => onDuplicate(theme)}
      onEdit={() => onEdit(theme)}
      onDownload={() => onDownload(theme)}
      onRemove={() => onRemove(theme)}
      onUse={selectCollectionDefaults}
      onUseMode={(mode) => onUseMode(theme, mode)}
      theme={getThemeCardDefinition(theme)}
      {...(themes.length > 1
        ? {
            variantNavigation: {
              collectionLabel,
              options: themes.flatMap((variant, themeIndex) =>
                getThemeCardDefinition(variant).previews.map((preview) => ({
                  themeIndex,
                  label: variantLabels[themeIndex] ?? variant.label,
                  activeModes: activeModesFor(variant.id),
                  preview,
                })),
              ),
              onSelectAndUse: (themeIndex, mode) => {
                const selectedTheme = themes[themeIndex];
                if (!selectedTheme) return;
                setVariantIndex(themeIndex);
                onUseMode(selectedTheme, mode);
              },
            },
          }
        : {})}
    />
  );
}

export function ThemeLibrary() {
  const {
    theme,
    setTheme,
    appearanceMode,
    setAppearanceMode,
    themeHalves,
    themeHalvesRaw,
    setThemeHalf,
    resolvedTheme: initialAppearance,
  } = useThemeSelection();
  const customThemes = useCustomThemes();
  const openThemeEditor = useThemeEditorStore((store) => store.openThemeEditor);
  const [themeRemovalTarget, setThemeRemovalTarget] = useState<{
    theme: ThemeDefinition;
    collectionThemes: ReadonlyArray<ThemeDefinition>;
  } | null>(null);
  const [themeIdsToRemove, setThemeIdsToRemove] = useState<
    ReadonlyArray<string>
  >([]);
  const [removing, setRemoving] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const themeIdsToRemoveSet = new Set(themeIdsToRemove);
  const removeDialogTheme = themeRemovalTarget?.theme;
  const removeDialogCollectionThemes =
    themeRemovalTarget?.collectionThemes ?? [];
  const canRemoveCollection = removeDialogCollectionThemes.length > 1;
  const removeDialogCollectionLabel =
    removeDialogTheme?.collection?.label ?? removeDialogTheme?.label;
  const modeBase = appearanceMode === "system" ? "system" : appearanceMode;

  const handleRemoveTheme = (
    customTheme: ThemeDefinition,
    collectionThemes: ReadonlyArray<ThemeDefinition>,
  ) => {
    setThemeRemovalTarget({ theme: customTheme, collectionThemes });
    setThemeIdsToRemove(collectionThemes.length > 1 ? [] : [customTheme.id]);
  };

  // T3 moves the selection first because its storage writes can fail
  // synchronously. Here the durable library write is the step that can fail,
  // so it goes first and a failure leaves the selection untouched.
  const handleConfirmRemoveTheme = async () => {
    if (!themeRemovalTarget) return;
    const removedIds = new Set(themeIdsToRemove);
    if (removedIds.size === 0) return;
    const removesBase = removedIds.has(
      getThemeDefinition(theme, customThemes)?.id ?? "",
    );
    setRemoving(true);
    try {
      await removeCustomThemes([...removedIds]);
    } catch {
      notifyEditorResult("error", "Couldn’t remove theme", "Try again.");
      return;
    } finally {
      setRemoving(false);
    }
    if (removesBase) setTheme(modeBase);
    for (const appearance of ["light", "dark"] as const) {
      const half = themeHalvesRaw[appearance];
      if (half === undefined) continue;
      // Writing a base preference clears the whole mix, so halves that name
      // a surviving theme are written back; removed halves fall back to base.
      const next = removedIds.has(half) ? null : removesBase ? half : undefined;
      if (next !== undefined) setThemeHalf(appearance, next);
    }
    setThemeRemovalTarget(null);
  };

  // ----- Automatic-mode mixing -------------------------------------------
  // The pair model: one theme owns light, one owns dark, and the global
  // appearance mode (light / dark / auto) decides which is showing.
  const baseCardId = getThemeDefinition(theme, customThemes)?.id ?? null;
  const lightOwner = themeHalves?.light ?? baseCardId;
  const darkOwner = themeHalves?.dark ?? baseCardId;

  const assignHalf = (appearance: ThemeAppearance, cardId: string | null) => {
    const otherAppearance = appearance === "light" ? "dark" : "light";
    // Picking the default over a themed base cannot be stored as a half:
    // the base would still own that appearance. Convert the base into an
    // explicit half on the other side so this side falls back to default.
    if (cardId === null && baseCardId !== null) {
      const otherOwner = themeHalvesRaw[otherAppearance] ?? baseCardId;
      setTheme(modeBase);
      setThemeHalf(otherAppearance, otherOwner);
      return;
    }
    setThemeHalf(appearance, cardId);
  };

  // "Create theme" starts from whatever is on screen for the appearance being
  // edited, so tuning the theme you already use never means rebuilding it.
  const activeThemeForAppearance =
    getThemeDefinition(
      (initialAppearance === "light" ? lightOwner : darkOwner) ?? "",
      customThemes,
    ) ?? null;

  const cardDefById = (id: string | null): ThemeCardDefinition => {
    if (id === null) return STANDARD_THEME_CARDS[0]!;
    const definition = getThemeDefinition(id, customThemes);
    return definition
      ? getThemeCardDefinition(definition)
      : STANDARD_THEME_CARDS[0]!;
  };

  const pickColors = (id: string | null, appearance: ThemeAppearance) => {
    const card = cardDefById(id);
    return previewColorsOf(card, appearance) ?? card.previews[0]!.colors;
  };

  // ----- Wireframe tiles on top, two-ball cards below --------------------
  const handlePairPick = (cardId: string | null) => (mode: ThemeMode) => {
    if (mode === "system") return;
    assignHalf(mode, cardId);
  };

  // Rings always show the effective owner of each appearance: an unpicked
  // half belongs to the default card (a null owner), so a fresh install
  // shows the default selected instead of nothing.
  const pickedModesFor = (cardId: string | null): ThemeMode[] => {
    const rings: ThemeMode[] = [];
    if (lightOwner === cardId) rings.push("light");
    if (darkOwner === cardId) rings.push("dark");
    return rings;
  };

  const wireframeColors = (appearance: ThemeAppearance) =>
    pickColors(appearance === "light" ? lightOwner : darkOwner, appearance);

  const renderWireframe = (mode: ThemeMode) => (
    <ThemeWireframe
      className="h-[8.75rem]"
      panes={
        mode === "system"
          ? [
              { clip: "left", colors: wireframeColors("light") },
              { clip: "right", colors: wireframeColors("dark") },
            ]
          : [{ colors: wireframeColors(mode === "dark" ? "dark" : "light") }]
      }
    />
  );

  const renderModeTiles = () => (
    <div
      aria-label="Appearance mode"
      className="grid w-full grid-cols-3 gap-3 outline-none"
      id="color-scheme"
      role="group"
      tabIndex={-1}
    >
      {(["system", "light", "dark"] as const).map((mode) => {
        const isActive = appearanceMode === mode;
        return (
          <button
            aria-label={
              mode === "system"
                ? "Follow the system appearance"
                : `Use ${mode} mode`
            }
            aria-pressed={isActive}
            className={cn(
              "flex cursor-pointer flex-col items-stretch gap-1.5 rounded-xl border p-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              isActive
                ? "border-transparent bg-accent/30"
                : "border-border/70 bg-card/60 hover:bg-accent/10",
            )}
            key={mode}
            style={
              isActive
                ? { boxShadow: "inset 0 0 0 1px var(--ring)" }
                : undefined
            }
            onClick={() => setAppearanceMode(mode)}
            type="button"
          >
            {renderWireframe(mode)}
            <span
              className={cn(
                "flex items-center justify-center text-xs font-medium",
                isActive ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {mode === "system"
                ? "System"
                : mode === "light"
                  ? "Light"
                  : "Dark"}
            </span>
          </button>
        );
      })}
    </div>
  );

  const customThemeCollections = [
    ...customThemes
      .reduce((groups, customTheme) => {
        const groupId = customTheme.collection
          ? `collection:${customTheme.collection.id}`
          : `theme:${customTheme.id}`;
        const group = groups.get(groupId);
        if (group) group.push(customTheme);
        else groups.set(groupId, [customTheme]);
        return groups;
      }, new Map<string, ThemeDefinition[]>())
      .entries(),
  ];

  const renderPairGrid = () => (
    <div
      className="grid w-full gap-2"
      style={{
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 16rem), 1fr))",
      }}
    >
      {STANDARD_THEME_CARDS.map((standardTheme) => (
        <ThemeLibraryCard
          activeModes={pickedModesFor(null)}
          isActive={false}
          key={standardTheme.id}
          onDuplicate={() =>
            openThemeEditor({
              editingThemeId: null,
              seedThemeId: null,
              seedName: `${standardTheme.label} copy`,
              initialAppearance,
            })
          }
          onUse={() => setTheme(modeBase)}
          onUseMode={handlePairPick(null)}
          theme={standardTheme}
        />
      ))}
      {MAINTAINER_THEMES.map((maintainerTheme) => (
        <ThemeLibraryCard
          activeModes={pickedModesFor(maintainerTheme.id)}
          isActive={false}
          key={maintainerTheme.id}
          onDuplicate={() =>
            openThemeEditor({
              editingThemeId: null,
              seedThemeId: maintainerTheme.id,
              seedName: `${maintainerTheme.label} copy`,
              initialAppearance,
            })
          }
          onUse={() => setTheme(maintainerTheme.id)}
          onUseMode={handlePairPick(maintainerTheme.id)}
          theme={getThemeCardDefinition(maintainerTheme)}
        />
      ))}
      {customThemeCollections.map(([collectionId, themes]) => (
        <CustomThemeCollectionCard
          activeModesFor={pickedModesFor}
          key={collectionId}
          onDownload={(customTheme) => void exportThemeFile(customTheme)}
          onDuplicate={(customTheme) =>
            openThemeEditor({
              editingThemeId: null,
              seedThemeId: customTheme.id,
              seedName: `${customTheme.label} copy`,
              initialAppearance,
            })
          }
          onEdit={(customTheme) =>
            openThemeEditor({
              editingThemeId: customTheme.id,
              seedThemeId: null,
              seedName: null,
              initialAppearance,
            })
          }
          onRemove={(customTheme) => handleRemoveTheme(customTheme, themes)}
          onUse={(customTheme) => {
            const modes = getThemeModes(customTheme);
            if (modes.length === 1) assignHalf(modes[0]!, customTheme.id);
            else setTheme(customTheme.id);
          }}
          onUseMode={(customTheme, mode) =>
            handlePairPick(customTheme.id)(mode)
          }
          themes={themes}
        />
      ))}
    </div>
  );

  return (
    <div className="space-y-3">
      <h3 className="px-3 text-sm font-normal text-foreground/70 sm:px-4">
        Color scheme
      </h3>
      {renderModeTiles()}
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-3 px-3 pt-2 sm:px-4">
        <h3 className="text-sm font-normal text-foreground/70">Themes</h3>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              openThemeEditor({
                editingThemeId: null,
                seedThemeId: activeThemeForAppearance?.id ?? null,
                seedName: null,
                initialAppearance,
              })
            }
          >
            <PaintbrushIcon />
            Create theme
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() => setIsImportOpen(true)}
          >
            <PlusIcon />
            Add theme
          </Button>
        </div>
      </div>
      {renderPairGrid()}
      <ThemeImportDialog
        onImportedMany={(importedThemes, { updated }) => {
          const verb = updated ? "updated" : "added";
          notifyEditorResult(
            "success",
            importedThemes.length === 1
              ? `${importedThemes[0]!.label} ${verb}`
              : `${importedThemes.length} themes ${verb}`,
            importedThemes.map((imported) => imported.label).join(", "),
          );
        }}
        onImported={async (importedTheme) => {
          // Same rule as clicking the card: a one-appearance theme takes its
          // side of the mix instead of becoming the base for both.
          const modes = getThemeModes(importedTheme);
          if (modes.length === 1) {
            assignHalf(modes[0]!, importedTheme.id);
            notifyEditorResult(
              "success",
              `${importedTheme.label} added`,
              `It’s now your ${modes[0]!} theme.`,
            );
            return true;
          }
          if (!(await setTheme(importedTheme.id))) {
            notifyEditorResult(
              "error",
              "Couldn’t save theme selection",
              "Try again.",
            );
            return false;
          }
          notifyEditorResult(
            "success",
            `${importedTheme.label} added`,
            "It’s now active.",
          );
          return true;
        }}
        onOpenChange={setIsImportOpen}
        open={isImportOpen}
      />
      <Dialog
        open={themeRemovalTarget !== null}
        onOpenChange={(open) => {
          if (!open && !removing) setThemeRemovalTarget(null);
        }}
        className="row-start-2 max-h-full max-w-lg text-popover-foreground"
      >
        <div
          className="flex flex-col gap-2 p-6 text-center max-sm:pb-4 sm:text-left"
          data-slot="alert-dialog-header"
        >
          <DialogTitle>
            {canRemoveCollection
              ? `Remove themes from “${removeDialogCollectionLabel}”?`
              : `Remove “${removeDialogTheme?.label}”?`}
          </DialogTitle>
          <DialogDescription>
            {canRemoveCollection
              ? "Select the variants you want to remove. You can restore them by importing the extension again."
              : "You can bring it back anytime by importing its JSON file."}
          </DialogDescription>
        </div>
        {canRemoveCollection ? (
          <div className="grid max-h-72 grid-cols-1 gap-2 overflow-y-auto px-6 pb-6 sm:grid-cols-2">
            {removeDialogCollectionThemes.map((customTheme) => {
              const checked = themeIdsToRemoveSet.has(customTheme.id);
              const card = getThemeCardDefinition(customTheme);
              const checkboxId = `remove-theme-${customTheme.id}`;
              return (
                <label
                  className="group relative flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-border/70 bg-muted/25 p-3 has-checked:border-ring has-checked:bg-accent/20 hover:bg-muted/40"
                  htmlFor={checkboxId}
                  key={customTheme.id}
                >
                  <span className="absolute right-2 top-2 inline-grid size-5 grid-cols-1 sm:size-4">
                    <input
                      checked={checked}
                      className="col-start-1 row-start-1 size-full appearance-none rounded-sm border border-input bg-background outline-none checked:border-primary checked:bg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring dark:not-checked:bg-input/32 forced-colors:appearance-auto"
                      id={checkboxId}
                      name="themes-to-remove"
                      type="checkbox"
                      onChange={(event) => {
                        const shouldRemove = event.currentTarget.checked;
                        setThemeIdsToRemove((current) =>
                          shouldRemove
                            ? [...current, customTheme.id]
                            : current.filter(
                                (themeId) => themeId !== customTheme.id,
                              ),
                        );
                      }}
                    />
                    <CheckIcon className="pointer-events-none col-start-1 row-start-1 size-3.5 shrink-0 self-center justify-self-center stroke-primary-foreground opacity-0 group-has-checked:opacity-100 sm:size-3" />
                  </span>
                  <span className="flex min-h-12 items-center justify-center gap-1">
                    {card.previews.map((preview) => (
                      <span
                        className="flex size-11 shrink-0 items-center justify-center"
                        key={preview.mode}
                      >
                        <span className="flex scale-75">
                          <ThemePreviewCircle
                            colors={preview.colors}
                            mode={preview.mode}
                          />
                        </span>
                      </span>
                    ))}
                  </span>
                  <p className="max-w-full truncate text-center text-base font-medium text-foreground sm:text-sm">
                    {customTheme.label}
                  </p>
                </label>
              );
            })}
          </div>
        ) : null}
        <div
          className="flex flex-col-reverse gap-2 px-6 sm:flex-row sm:justify-end sm:rounded-b-[calc(var(--radius-2xl)-1px)] border-t bg-muted/72 py-4"
          data-slot="alert-dialog-footer"
        >
          <Button
            variant="outline"
            disabled={removing}
            onClick={() => setThemeRemovalTarget(null)}
          >
            Cancel
          </Button>
          <Button
            disabled={themeIdsToRemove.length === 0 || removing}
            variant="destructive"
            onClick={() => void handleConfirmRemoveTheme()}
          >
            {canRemoveCollection
              ? `Remove selected${themeIdsToRemove.length > 0 ? ` (${themeIdsToRemove.length})` : ""}`
              : "Remove theme"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
