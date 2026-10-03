// Classes copied from pingdotgg/t3code v0.0.45 components/chat/ModelPickerContent.tsx, ModelListRow.tsx and components/ui/combobox.tsx (MIT).
import { useId, useLayoutEffect, useState, type ComponentProps } from "react";
import { SearchIcon } from "lucide-react";
import type { ModelOption, SessionSettings } from "../ipc";
import { Menu, MenuItem } from "../ui/menu";
import { OpenAI } from "../ui/icons";

export function ModelPicker({
  trigger,
  models,
  settings,
  loading,
  error,
  disabled,
  onRetry,
  onChange,
}: {
  trigger: ComponentProps<typeof Menu>["trigger"];
  models: ModelOption[];
  settings: SessionSettings;
  loading: boolean;
  error?: string;
  disabled: boolean;
  onRetry: () => void;
  onChange: (settings: SessionSettings) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const listId = useId();
  const filtered = models.filter((model) =>
    `${model.displayName} ${model.model}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
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
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/40">
          <div className="min-w-0 shrink-0 px-3 pt-2.5">
            <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
              <SearchIcon
                aria-hidden="true"
                className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
              />
              <div className="[&_input]:h-6.5 [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-6.5">
                <input
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
                    if (event.key === "Enter") {
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
                role="listbox"
                aria-label="Models"
                aria-disabled={disabled}
                className="pl-2 pr-px"
              >
                {filtered.map((model) => (
                  <button
                    key={model.model}
                    id={optionId(model)}
                    type="button"
                    role="option"
                    aria-selected={model === selected}
                    aria-label={model.displayName}
                    disabled={disabled}
                    tabIndex={-1}
                    title={model.description}
                    data-selected={model === selected ? "" : undefined}
                    data-highlighted={model === active ? "" : undefined}
                    data-disabled={disabled ? "" : undefined}
                    className="flex min-h-8 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-pointer items-center rounded-sm px-2 py-1 text-base outline-none not-data-disabled:hover:bg-accent data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-selected:bg-foreground/[0.08] data-selected:text-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground [&[data-highlighted][data-selected]]:bg-accent [&[data-highlighted][data-selected]]:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 group relative w-full !min-w-0 max-w-full cursor-pointer"
                    onMouseDown={(event) => event.preventDefault()}
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
                          <OpenAI className="size-3 shrink-0" />
                          <span className="truncate text-xs font-normal leading-snug text-muted-foreground/70">
                            Codex
                          </span>
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
              {!loading && !filtered.length ? (
                <div
                  role="status"
                  className="not-empty:p-2 text-center text-base text-muted-foreground sm:text-sm"
                >
                  {models.length ? "No models found" : "Use Codex default"}
                </div>
              ) : null}
            </div>
          </div>
          {!loading ? (
            <div className="shrink-0 border-t border-border/70 p-2">
              <MenuItem role="button" disabled={disabled} onClick={onRetry}>
                {error ? "Retry" : "Reload models"}
              </MenuItem>
            </div>
          ) : null}
        </div>
      </div>
    </Menu>
  );
}
