// Classes copied from pingdotgg/t3code v0.0.45 components/chat/ModelPickerContent.tsx, ModelPickerSidebar.tsx, ModelListRow.tsx and components/ui/combobox.tsx (MIT).
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ComponentProps,
} from "react";
import { SearchIcon, StarIcon } from "lucide-react";
import type { ModelOption, SessionSettings } from "../ipc";
import { Menu, MenuItem } from "../ui/menu";
import { Button } from "../ui/controls";
import { cn } from "../lib/cn";
import { usePreferences } from "../settings/preferences";
import { OpenAI } from "../ui/icons";

const codexProvider = { id: "codex", label: "Codex", Icon: OpenAI } satisfies {
  id: string;
  label: string;
  Icon: typeof OpenAI;
};

export function ModelPicker({
  trigger,
  models,
  settings,
  loading,
  error,
  disabled,
  onRetry,
  onChange,
  open: controlledOpen,
  onOpenChange,
}: {
  trigger: ComponentProps<typeof Menu>["trigger"];
  models: ModelOption[];
  settings: SessionSettings;
  loading: boolean;
  error?: string;
  disabled: boolean;
  onRetry: () => void;
  onChange: (settings: SessionSettings) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean) => {
    setLocalOpen(next);
    onOpenChange?.(next);
  };
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const listId = useId();
  const { preferences, persistenceError, setFavorite } = usePreferences();
  const [rail, setRail] = useState<"favorites" | "codex">("codex");
  const search = useRef<HTMLInputElement>(null);
  const recovery = useRef<{
    model: string;
    index: number;
    cell: "model" | "star";
  } | null>(null);
  const isFavorite = (model: ModelOption) =>
    preferences.favoriteModels.some(
      (pair) =>
        pair.provider === codexProvider.id && pair.model === model.model,
    );
  const searching = query.trim().length > 0;
  const filtered = searching
    ? models.filter((model) =>
        `${model.displayName} ${model.model}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      )
    : rail === "favorites"
      ? models.filter(isFavorite)
      : [
          ...models.filter(isFavorite),
          ...models.filter((model) => !isFavorite(model)),
        ];
  const selected = models.find(
    (model) =>
      settings.model === model.model ||
      (settings.model === null && model.isDefault),
  );
  const active =
    filtered.find((model) => model.model === highlighted) ??
    filtered.find((model) => model === selected) ??
    filtered[0];
  const optionId = (model: ModelOption) =>
    `${listId}-${encodeURIComponent(model.model)}`;
  useLayoutEffect(() => {
    if (open && active)
      document
        .getElementById(optionId(active))
        ?.scrollIntoView({ block: "nearest" });
  }, [open, active?.model]);
  const focusCell = (model: ModelOption, cell: "model" | "star") => {
    setHighlighted(model.model);
    document.getElementById(`${optionId(model)}-${cell}`)?.focus();
  };
  const rowKeys = (
    event: KeyboardEvent<HTMLButtonElement>,
    model: ModelOption,
    cell: "model" | "star",
  ) => {
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.nativeEvent.isComposing
    )
      return;
    const index = filtered.indexOf(model);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next =
        filtered[
          (index + (event.key === "ArrowDown" ? 1 : -1) + filtered.length) %
            filtered.length
        ];
      if (next) focusCell(next, cell);
    } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      focusCell(model, event.key === "ArrowRight" ? "star" : "model");
    }
  };
  useLayoutEffect(() => {
    const pending = recovery.current;
    if (!pending) return;
    recovery.current = null;
    const next =
      filtered.find((model) => model.model === pending.model) ??
      filtered[Math.min(pending.index, filtered.length - 1)];
    if (next) focusCell(next, pending.cell);
    else search.current?.focus();
  }, [preferences.favoriteModels]);
  const select = (model: ModelOption) => {
    if (disabled) return;
    onChange({
      ...settings,
      model: model.isDefault ? null : model.model,
      effort:
        settings.effort &&
        model.supportedReasoningEfforts.some(
          (option) => option.reasoningEffort === settings.effort,
        )
          ? settings.effort
          : null,
    });
    setOpen(false);
  };
  return (
    <Menu
      side="top"
      trigger={trigger}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setQuery("");
          setHighlighted(null);
          setRail(preferences.favoriteModels.length ? "favorites" : "codex");
        }
      }}
      popupKind={{ kind: "dialog", label: "Choose model" }}
      className="overflow-hidden"
      contentClassName="max-h-86.5 flex flex-col overflow-hidden p-0"
    >
      <div
        className="relative flex min-h-0 h-screen max-h-86.5 w-screen max-w-90 flex-row overflow-hidden"
        data-model-picker-content="true"
      >
        {!searching ? (
          <div
            role="toolbar"
            aria-label="Providers"
            aria-orientation="vertical"
            className="w-11 shrink-0 overflow-hidden bg-muted/30"
            data-model-picker-sidebar="true"
          >
            <div className="h-full overflow-y-auto overscroll-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <div className="relative flex min-h-full flex-col gap-1 p-1">
                {(["favorites", "codex"] satisfies Array<typeof rail>).map(
                  (provider, index) => (
                    <div
                      key={provider}
                      className="relative w-full"
                      data-model-picker-provider={provider}
                    >
                      {index === 1 ? (
                        <div
                          className="mb-1 border-b border-border/70"
                          aria-hidden="true"
                        />
                      ) : null}
                      <button
                        type="button"
                        id={`${listId}-rail-${provider}`}
                        disabled={disabled}
                        tabIndex={rail === provider ? 0 : -1}
                        aria-label={
                          provider === "favorites" ? "Favorites" : "Codex"
                        }
                        title={provider === "favorites" ? "Favorites" : "Codex"}
                        aria-pressed={rail === provider}
                        className="relative isolate flex w-full cursor-pointer aspect-square items-center justify-center rounded-md transition-colors hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none"
                        onClick={() => {
                          setRail(provider);
                          setHighlighted(null);
                          search.current?.focus();
                        }}
                        onKeyDown={(event) => {
                          if (
                            event.altKey ||
                            event.ctrlKey ||
                            event.metaKey ||
                            event.shiftKey
                          )
                            return;
                          if (event.key === "ArrowRight") {
                            event.preventDefault();
                            search.current?.focus();
                          } else if (
                            event.key === "ArrowDown" ||
                            event.key === "ArrowUp"
                          ) {
                            event.preventDefault();
                            document
                              .getElementById(
                                `${listId}-rail-${provider === "favorites" ? "codex" : "favorites"}`,
                              )
                              ?.focus();
                          }
                        }}
                      >
                        {provider === "favorites" ? (
                          <StarIcon
                            className="size-5 fill-current shrink-0"
                            aria-hidden="true"
                          />
                        ) : (
                          <OpenAI className="size-5" />
                        )}
                        {rail === provider ? (
                          <span
                            data-model-picker-selected-indicator="true"
                            className="pointer-events-none absolute -right-1 top-1/2 z-10 h-5 w-0.75 -translate-y-1/2 rounded-l-full bg-primary"
                          />
                        ) : null}
                      </button>
                    </div>
                  ),
                )}
              </div>
            </div>
          </div>
        ) : null}
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/40",
            !searching && "border-l border-border/70",
          )}
        >
          <div className="min-w-0 shrink-0 px-3 pt-2.5">
            <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
              <SearchIcon
                aria-hidden="true"
                className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
              />
              <div className="[&_input]:h-6.5 [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-6.5">
                <input
                  ref={search}
                  aria-haspopup="grid"
                  role="combobox"
                  aria-label="Search models"
                  aria-expanded="true"
                  aria-autocomplete="list"
                  aria-controls={listId}
                  aria-activedescendant={
                    !disabled && active ? optionId(active) : undefined
                  }
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Search models..."
                  disabled={disabled}
                  value={query}
                  className="w-full rounded-none bg-transparent text-sm outline-none"
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setHighlighted(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return;
                    if (
                      !searching &&
                      !event.altKey &&
                      !event.ctrlKey &&
                      !event.metaKey &&
                      ((event.key === "ArrowLeft" &&
                        !event.shiftKey &&
                        query.length === 0) ||
                        (event.key === "Tab" && event.shiftKey))
                    ) {
                      event.preventDefault();
                      document
                        .getElementById(`${listId}-rail-${rail}`)
                        ?.focus();
                    } else if (event.key === "Enter") {
                      event.preventDefault();
                      event.stopPropagation();
                      if (active) select(active);
                    } else if (
                      (event.key === "ArrowDown" || event.key === "ArrowUp") &&
                      !event.altKey &&
                      !event.ctrlKey &&
                      !event.metaKey
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                      const index = filtered.findIndex(
                        (model) => model === active,
                      );
                      const next =
                        filtered[
                          (index +
                            (event.key === "ArrowDown" ? 1 : -1) +
                            filtered.length) %
                            filtered.length
                        ];
                      if (next) setHighlighted(next.model);
                    }
                  }}
                />
              </div>
            </div>
          </div>
          <div className="relative min-h-0 flex-1 overflow-hidden pr-px">
            <div className="scrollbar-gutter-stable h-full overflow-x-hidden overscroll-y-contain py-1.5 [&::-webkit-scrollbar-track]:my-2 overflow-y-auto">
              {loading ? (
                <div
                  role="status"
                  className="px-2 py-1.5 text-sm text-muted-foreground"
                >
                  Loading models…
                </div>
              ) : null}
              {settings.model && !selected && !loading && !error ? (
                <div
                  role="status"
                  className="px-2 py-1.5 text-sm text-error-foreground"
                >
                  Selected model is unavailable. Choose another model.
                </div>
              ) : null}
              {error ? (
                <div
                  role="status"
                  className="px-2 py-1.5 text-sm text-error-foreground"
                >
                  {error}
                </div>
              ) : null}
              <div
                id={listId}
                role="grid"
                aria-label="Models"
                aria-colcount={2}
                aria-disabled={disabled}
                className="pl-2 pr-px"
              >
                {filtered.map((model, index) => (
                  <div
                    key={model.model}
                    role="row"
                    aria-selected={model === selected}
                    className="flex min-h-8 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-pointer items-center rounded-sm px-2 py-1 text-base outline-none not-data-disabled:hover:bg-accent data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-selected:bg-foreground/[0.08] data-selected:text-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground [&[data-highlighted][data-selected]]:bg-accent [&[data-highlighted][data-selected]]:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 group relative w-full !min-w-0 max-w-full cursor-pointer"
                    data-highlighted={model === active ? "" : undefined}
                    data-selected={model === selected ? "" : undefined}
                    data-disabled={disabled ? "" : undefined}
                  >
                    <div
                      role="gridcell"
                      id={optionId(model)}
                      className="min-w-0 flex-1"
                    >
                      <button
                        key={model.model}
                        id={`${optionId(model)}-model`}
                        type="button"
                        aria-label={model.displayName}
                        disabled={disabled}
                        tabIndex={model === active ? 0 : -1}
                        title={model.description}
                        data-selected={model === selected ? "" : undefined}
                        data-highlighted={model === active ? "" : undefined}
                        data-disabled={disabled ? "" : undefined}
                        className="flex w-full min-w-0 cursor-pointer items-center text-left outline-none"
                        onFocus={() => setHighlighted(model.model)}
                        onKeyDown={(event) => rowKeys(event, model, "model")}
                        onMouseMove={() => setHighlighted(model.model)}
                        onClick={() => select(model)}
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-2 [&_svg:not([class*='text-'])]:text-muted-foreground">
                          <div className="min-w-0 flex-1 text-left">
                            <div className="flex min-w-0 items-center gap-2">
                              <div className="min-w-0 truncate text-xs font-medium leading-snug">
                                {model.displayName}
                              </div>
                            </div>
                            <div className="mt-1 flex items-center gap-1.5">
                              <codexProvider.Icon className="size-3 shrink-0" />
                              <span className="truncate text-xs font-normal leading-snug text-muted-foreground/70">
                                {codexProvider.label}
                              </span>
                            </div>
                          </div>
                        </div>
                      </button>
                    </div>
                    <div role="gridcell" className="shrink-0">
                      <Button
                        id={`${optionId(model)}-star`}
                        type="button"
                        size="icon-xs"
                        variant="ghost-muted"
                        className="-mr-1 shrink-0"
                        disabled={disabled}
                        tabIndex={model === active ? 0 : -1}
                        aria-label={`${isFavorite(model) ? "Remove" : "Add"} ${model.displayName} ${isFavorite(model) ? "from" : "to"} favorites`}
                        aria-pressed={isFavorite(model)}
                        onFocus={() => setHighlighted(model.model)}
                        onKeyDown={(event) => rowKeys(event, model, "star")}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (disabled) return;
                          if (document.activeElement === event.currentTarget)
                            recovery.current = {
                              model: model.model,
                              index,
                              cell: "star",
                            };
                          setFavorite(
                            { provider: codexProvider.id, model: model.model },
                            !isFavorite(model),
                          );
                        }}
                      >
                        <StarIcon
                          className={cn(
                            "size-3.5 sm:size-3",
                            isFavorite(model) && "fill-current text-warning",
                          )}
                          aria-hidden="true"
                        />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              {!loading && !filtered.length ? (
                <div
                  role="status"
                  className="not-empty:p-2 text-center text-base text-muted-foreground sm:text-sm"
                >
                  {!searching && rail === "favorites"
                    ? "No favorite models. Add favorites from Codex."
                    : models.length
                      ? "No models found"
                      : "Use Codex default"}
                </div>
              ) : null}
            </div>
          </div>
          {persistenceError ? (
            <div
              role="status"
              className="shrink-0 border-t border-border/70 px-2 py-1.5 text-xs text-error-foreground"
            >
              {persistenceError}
            </div>
          ) : null}
          {!loading && error ? (
            <div className="shrink-0 border-t border-border/70 p-2">
              <MenuItem role="button" disabled={disabled} onClick={onRetry}>
                Retry
              </MenuItem>
            </div>
          ) : null}
        </div>
      </div>
    </Menu>
  );
}
