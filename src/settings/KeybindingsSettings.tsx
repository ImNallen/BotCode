// Ported from pingdotgg/t3code v0.0.45 components/settings/KeybindingsSettings.tsx and settingsLayout.tsx (MIT).
import {
  ChevronDownIcon,
  EllipsisIcon,
  KeyboardIcon,
  PlusIcon,
  RotateCwIcon,
  SearchIcon,
  SquarePenIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { parseRule } from "../keybindings/config";
import {
  formatShortcutKeyLabel,
  formatShortcutLabel,
  keybindingFromKeyboardEvent,
} from "../keybindings/keyboard";
import {
  type KeybindingRule,
  type KeybindingShortcut,
} from "../keybindings/rules";
import { keybindings, useKeybindings } from "../keybindings/store";
import { actionIds, actions } from "../lib/actions";
import { cn } from "../lib/cn";
import { isMacPlatform } from "../lib/utils";
import { Badge } from "../ui/badge";
import { Button, selectItem, selectTrigger } from "../ui/controls";
import { Input } from "../ui/input";
import { Kbd, KbdGroup } from "../ui/kbd";
import { Menu, MenuItem } from "../ui/menu";
import {
  buildKeybindingRows,
  buildWhenVariableOptions,
  filterKeybindingRows,
  isProjectCommand,
  keybindingConflictLabels,
  projectCommandLabel,
  validateWhenDraft,
  type KeybindingCommandOption,
  type KeybindingRow,
} from "./KeybindingsSettings.logic";

type SaveKeybinding = (
  rule: KeybindingRule,
  replace?: KeybindingRule,
) => Promise<boolean>;
type BindingEntry = { kind: "existing"; row: KeybindingRow } | { kind: "new" };
type KeyControlMode = "pill" | "editing" | "recording";

const revealListeners = new Set<(command: string) => void>();
export function revealKeybinding(command: string) {
  for (const listener of revealListeners) listener(command);
}

function KeybindingPill({ shortcut }: { shortcut: KeybindingShortcut }) {
  const mac = isMacPlatform(navigator.platform);
  const parts = [
    ...(shortcut.ctrlKey || (shortcut.modKey && !mac)
      ? [mac ? "⌃" : "Ctrl"]
      : []),
    ...(shortcut.altKey ? [mac ? "⌥" : "Alt"] : []),
    ...(shortcut.shiftKey ? [mac ? "⇧" : "Shift"] : []),
    ...(shortcut.metaKey || (shortcut.modKey && mac)
      ? [mac ? "⌘" : "Meta"]
      : []),
    formatShortcutKeyLabel(shortcut.key),
  ];
  return (
    <KbdGroup>
      {parts.map((part, index) => (
        <Kbd key={`${part}-${index}`}>{part}</Kbd>
      ))}
    </KbdGroup>
  );
}

function ConflictWarning({ labels }: { labels: readonly string[] }) {
  if (!labels.length) return null;
  const description = `Conflicts with ${labels.slice(0, 3).join(", ")}${labels.length > 3 ? ", and more" : ""}. The most recent matching binding wins when both conditions can apply.`;
  return (
    <span
      tabIndex={0}
      aria-label={description}
      title={description}
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-warning outline-none transition-colors hover:bg-warning/10 focus-visible:ring-3 focus-visible:ring-warning/25"
    >
      <TriangleAlertIcon className="size-3.5" aria-hidden />
    </span>
  );
}

function WhenClauseControl({
  label,
  expression,
  variables,
  disabled,
  onChange,
}: {
  label: string;
  expression: string;
  variables: readonly string[];
  disabled: boolean;
  onChange: (expression: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const validation = validateWhenDraft(expression, variables);
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      popupKind={{ kind: "dialog", label: `When clause for ${label}` }}
      sideOffset={6}
      contentClassName="max-h-none p-3"
      trigger={(props) => (
        <Button
          {...props}
          disabled={disabled}
          variant={expression ? "ghost" : "ghost-muted"}
          size="micro"
          className="min-w-0 shrink"
          aria-label={`Edit when clause for ${label}`}
        >
          <span className="truncate font-mono">{expression || "Always"}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
        </Button>
      )}
    >
      <div className="w-[min(34rem,calc(100vw-2rem))] space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="text-sm font-medium text-foreground">When</div>
          <Button
            size="icon-micro"
            variant="ghost-muted"
            aria-label="Close when editor"
            onClick={() => setOpen(false)}
          >
            <XIcon />
          </Button>
        </div>
        <div className="space-y-1.5">
          <Input
            data-keybinding-capture=""
            aria-label={`When expression for ${label}`}
            aria-invalid={validation.kind === "invalid"}
            disabled={disabled}
            size="sm"
            className="font-mono"
            value={expression}
            placeholder="Always"
            onChange={(event) => onChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
            }}
          />
          {validation.kind === "invalid" ? (
            <p role="alert" className="text-2xs text-destructive">
              {validation.message}
            </p>
          ) : validation.unknownVariables.length ? (
            <p className="text-2xs text-warning">
              Unknown conditions {validation.unknownVariables.join(", ")}. They
              evaluate to false unless the runtime provides them.
            </p>
          ) : null}
          <p className="text-2xs text-muted-foreground">
            Use !, &&, ||, and parentheses. Leave empty to run in every context.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {variables.map((variable) => (
            <Button
              key={variable}
              size="micro"
              variant="outline"
              disabled={disabled}
              className="font-mono"
              onClick={() =>
                onChange(
                  expression.trim()
                    ? `${expression.trim()} && ${variable}`
                    : variable,
                )
              }
            >
              {variable}
            </Button>
          ))}
        </div>
        <Button
          size="compact"
          variant="ghost-muted"
          disabled={disabled || !expression}
          onClick={() => onChange("")}
        >
          Clear conditions
        </Button>
      </div>
    </Menu>
  );
}

function BindingRowLayout({
  id,
  title,
  description,
  control,
  isNew = false,
}: {
  id?: string;
  title: ReactNode;
  description: ReactNode;
  control: ReactNode;
  isNew?: boolean;
}) {
  return (
    <div
      id={id}
      tabIndex={id ? -1 : undefined}
      data-slot="settings-row"
      className={cn(
        "@container/settings-row rounded-xl px-3 sm:px-4 aria-disabled:opacity-64 aria-disabled:[&_*]:text-muted-foreground py-3 group/row rounded-none",
        isNew && "bg-muted/15",
      )}
    >
      <div className="flex flex-col gap-3 @min-[32rem]/settings-row:grid @min-[32rem]/settings-row:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] @min-[32rem]/settings-row:items-center @min-[32rem]/settings-row:gap-8">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="text-sm font-medium text-foreground">{title}</h3>
          </div>
          <div className="max-w-xl text-xs leading-normal text-muted-foreground/80">
            {description}
          </div>
        </div>
        <div className="flex w-full min-w-0 shrink-0 items-center gap-2 @min-[32rem]/settings-row:w-auto @min-[32rem]/settings-row:justify-end">
          {control}
        </div>
      </div>
    </div>
  );
}

function BindingSettingsRow({
  entry,
  anchorId,
  allRows,
  commands,
  variables,
  extensions,
  pending,
  onSave,
  onReset,
  onRemove,
  onCancel,
}: {
  entry: BindingEntry;
  anchorId?: string;
  allRows: readonly KeybindingRow[];
  commands: readonly KeybindingCommandOption[];
  variables: readonly string[];
  extensions: ReadonlySet<string>;
  pending: boolean;
  onSave: SaveKeybinding;
  onReset: (row: KeybindingRow) => void;
  onRemove: (row: KeybindingRow) => void;
  onCancel: () => void;
}) {
  const row = entry.kind === "existing" ? entry.row : null;
  const [draft, setDraft] = useState({
    command: row?.rule.command ?? "",
    key: row?.rule.key ?? "",
    when: row?.rule.when ?? "",
  });
  const [keyMode, setKeyMode] = useState<KeyControlMode>(
    row ? "pill" : "editing",
  );
  const captureInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (keyMode === "recording") captureInput.current?.focus();
  }, [keyMode]);
  const label =
    row?.label ??
    commands.find((option) => option.command === draft.command)?.label ??
    "new keybinding";
  const rule: KeybindingRule = {
    command: draft.command,
    key: draft.key.trim(),
    ...(draft.when.trim() ? { when: draft.when.trim() } : {}),
  };
  const parsed = parseRule(rule, extensions);
  const whenValidation = validateWhenDraft(draft.when, variables);
  const dirty =
    row === null ||
    draft.key !== row.rule.key ||
    draft.when !== (row.rule.when ?? "");
  const conflicts = keybindingConflictLabels(
    allRows,
    { rowId: row?.id ?? "new", rule },
    navigator.platform,
  );
  const update = (patch: Partial<typeof draft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const save = async () => {
    if (parsed.error !== undefined || pending) return;
    if (await onSave(parsed.rule, row?.rule)) {
      setDraft({
        command: parsed.rule.command,
        key: parsed.rule.key,
        when: parsed.rule.when ?? "",
      });
      setKeyMode(row ? "pill" : "editing");
    }
  };
  const cancelKeyEdit = () => {
    update({ key: row?.rule.key ?? "" });
    setKeyMode(row ? "pill" : "editing");
  };
  const capture = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelKeyEdit();
      return;
    }
    if (keyMode !== "recording") return;
    event.preventDefault();
    event.stopPropagation();
    const key = keybindingFromKeyboardEvent(
      event.nativeEvent,
      navigator.platform,
    );
    if (!key) return;
    update({ key });
    setKeyMode("editing");
  };
  const canReset = row?.source === "Custom" && row.defaultRule !== null;
  const canRemove = row !== null && row.source !== "Default";
  const showPill = row !== null && keyMode === "pill" && !dirty;
  return (
    <BindingRowLayout
      id={anchorId}
      isNew={entry.kind === "new"}
      title={
        row ? (
          <span className="flex items-center gap-2" title={row.rule.command}>
            {row.label}
            {row.source !== "Default" ? (
              <Badge
                variant="outline"
                className="h-5 min-w-5 rounded-[.25rem] px-[calc(--spacing(1)-1px)] text-xs leading-none sm:h-4 sm:min-w-4 sm:text-[.625rem]"
              >
                {row.source}
              </Badge>
            ) : null}
          </span>
        ) : (
          "New keybinding"
        )
      }
      description={
        <>
          <span className="flex h-6 items-center gap-1.5">
            <span className="text-xs leading-none text-muted-foreground/70">
              When
            </span>
            <WhenClauseControl
              label={label}
              expression={draft.when}
              variables={variables}
              disabled={pending}
              onChange={(when) => update({ when })}
            />
          </span>
          {whenValidation.kind === "invalid" ? (
            <p role="alert" className="text-2xs text-destructive">
              {whenValidation.message}
            </p>
          ) : null}
        </>
      }
      control={
        <div
          className={cn(
            "flex flex-wrap items-center gap-1.5",
            row && "justify-end",
          )}
        >
          {entry.kind === "new" ? (
            <Menu
              align="end"
              className="w-72"
              trigger={(props) => (
                <button
                  {...props}
                  type="button"
                  disabled={pending}
                  aria-label="Command"
                  className={cn(selectTrigger({ size: "sm" }), "w-56")}
                >
                  <span className="truncate">
                    {draft.command ? label : "Command"}
                  </span>
                  <ChevronDownIcon />
                </button>
              )}
            >
              {commands.map((option) => (
                <MenuItem
                  key={option.command}
                  className={selectItem}
                  role="menuitemradio"
                  aria-checked={draft.command === option.command}
                  title={option.command}
                  disabled={pending}
                  onClick={() => update({ command: option.command })}
                >
                  {option.label}
                </MenuItem>
              ))}
            </Menu>
          ) : null}
          <ConflictWarning labels={conflicts} />
          {row && (canReset || canRemove) ? (
            <span className="flex items-center opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 has-data-popup-open:opacity-100 pointer-coarse:opacity-100">
              <Menu
                align="end"
                trigger={(props) => (
                  <Button
                    {...props}
                    variant="ghost-muted"
                    size="icon-sm"
                    disabled={pending}
                    aria-label={`Actions for ${row.label}`}
                  >
                    <EllipsisIcon className="size-3.5" />
                  </Button>
                )}
              >
                {canReset ? (
                  <MenuItem disabled={pending} onClick={() => onReset(row)}>
                    Reset to default
                  </MenuItem>
                ) : null}
                {canRemove ? (
                  <MenuItem
                    variant="destructive"
                    disabled={pending}
                    onClick={() => onRemove(row)}
                  >
                    Remove
                  </MenuItem>
                ) : null}
              </Menu>
            </span>
          ) : null}
          {dirty && row ? (
            <Button
              size="sm"
              disabled={pending || parsed.error !== undefined}
              onClick={() => void save()}
            >
              {pending ? "Saving" : "Save"}
            </Button>
          ) : null}
          {showPill ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => setKeyMode("recording")}
              aria-label={`Edit shortcut for ${label}: ${formatShortcutLabel(row.binding.shortcut)}`}
              className="inline-flex h-8 cursor-pointer items-center rounded-md border border-transparent px-1.5 sm:h-7 outline-none transition-colors hover:border-border/70 hover:bg-accent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/24 -mr-1.5 disabled:pointer-events-none disabled:opacity-64"
            >
              <KeybindingPill shortcut={row.binding.shortcut} />
            </button>
          ) : (
            <>
              <Input
                ref={captureInput}
                data-keybinding-capture=""
                autoFocus={keyMode === "recording"}
                disabled={pending}
                aria-label={`Keybinding for ${label}`}
                aria-invalid={
                  Boolean(draft.key.trim()) &&
                  parsed.error !== undefined &&
                  whenValidation.kind === "valid" &&
                  Boolean(draft.command)
                }
                value={keyMode === "recording" ? "" : draft.key}
                placeholder={
                  keyMode === "recording" ? "Press shortcut" : "Unassigned"
                }
                size="sm"
                className="w-44 font-mono"
                onChange={(event) => update({ key: event.currentTarget.value })}
                onBlur={() => {
                  if (keyMode === "recording") setKeyMode("editing");
                }}
                onKeyDown={capture}
              />
              <Button
                variant="ghost-muted"
                size="icon-micro"
                disabled={pending}
                aria-label={`${keyMode === "recording" ? "Type" : "Record"} shortcut for ${label}`}
                title={
                  keyMode === "recording" ? "Type shortcut" : "Record shortcut"
                }
                onClick={() => {
                  setKeyMode(keyMode === "recording" ? "editing" : "recording");
                  captureInput.current?.focus();
                }}
              >
                {keyMode === "recording" ? <SquarePenIcon /> : <KeyboardIcon />}
              </Button>
            </>
          )}
          {entry.kind === "new" ? (
            <>
              <Button
                size="sm"
                disabled={pending || parsed.error !== undefined}
                onClick={() => void save()}
              >
                {pending ? "Saving" : "Save"}
              </Button>
              <Button
                variant="ghost-muted"
                size="icon-sm"
                disabled={pending}
                aria-label="Cancel new keybinding"
                title="Cancel"
                onClick={onCancel}
              >
                <XIcon className="size-3.5" />
              </Button>
            </>
          ) : null}
          {row && dirty && keyMode !== "recording" ? (
            <Button
              variant="ghost-muted"
              size="icon-micro"
              disabled={pending}
              aria-label={`Cancel changes to ${label}`}
              title="Cancel changes"
              onClick={() => {
                setDraft({
                  command: row.rule.command,
                  key: row.rule.key,
                  when: row.rule.when ?? "",
                });
                setKeyMode("pill");
              }}
            >
              <XIcon />
            </Button>
          ) : null}
          {draft.key.trim() &&
          draft.command &&
          parsed.error !== undefined &&
          whenValidation.kind === "valid" ? (
            <p
              role="alert"
              className="w-full text-right text-2xs text-destructive"
            >
              {parsed.error}
            </p>
          ) : null}
        </div>
      }
    />
  );
}

export function KeybindingsSettings() {
  const state = useKeybindings();
  const [query, setQuery] = useState("");
  useEffect(() => {
    const reveal = (command: string) => {
      flushSync(() => setQuery(""));
      const target = document.getElementById(command);
      target?.scrollIntoView({ block: "nearest" });
      target?.focus({ preventScroll: true });
    };
    revealListeners.add(reveal);
    return () => {
      revealListeners.delete(reveal);
    };
  }, []);
  const [searchOpen, setSearchOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const commands = useMemo(() => {
    const options: KeybindingCommandOption[] = actionIds
      .filter(
        (id) => !actions[id].submenu && actions[id].shortcutOwner !== "palette",
      )
      .map((command) => ({ command, label: actions[command].title }));
    const included = new Set(options.map((option) => option.command));
    for (const rule of state.effective) {
      if (!isProjectCommand(rule.command) || included.has(rule.command))
        continue;
      included.add(rule.command);
      options.push({
        command: rule.command,
        label: projectCommandLabel(rule.command),
      });
    }
    return options.sort((left, right) => left.label.localeCompare(right.label));
  }, [state.effective]);
  const extensions = useMemo(
    () => new Set(commands.map((option) => option.command)),
    [commands],
  );
  const allRows = useMemo(
    () => buildKeybindingRows(state.effective, state.defaults, commands),
    [state.effective, state.defaults, commands],
  );
  const rows = useMemo(
    () => filterKeybindingRows(allRows, query),
    [allRows, query],
  );
  const variables = useMemo(
    () => buildWhenVariableOptions(state.defaults),
    [state.defaults],
  );
  const anchors = useMemo(() => {
    const seen = new Set<string>();
    return new Map(
      rows.flatMap((row) => {
        if (seen.has(row.rule.command)) return [];
        seen.add(row.rule.command);
        return [[row.id, row.rule.command]];
      }),
    );
  }, [rows]);
  const run = async (operation: () => Promise<void>): Promise<boolean> => {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    setOperationError(null);
    try {
      await operation();
      return true;
    } catch (cause) {
      setOperationError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  const save: SaveKeybinding = async (rule, replace) => {
    const saved = await run(() => keybindings.upsert(rule, replace));
    if (saved && !replace) setAdding(false);
    return saved;
  };
  const error = operationError ?? state.error;
  return (
    <section id="keybindings" tabIndex={-1} className="space-y-2.5">
      <div
        data-settings-scroll-target
        className="flex min-h-7 items-start justify-between gap-4 px-3 sm:px-4"
      >
        <h2 className="flex min-h-7 items-center gap-2 text-sm font-normal text-foreground/70">
          Keybindings
        </h2>
        <div className="flex min-h-7 min-w-7 items-center justify-end">
          <div className="flex items-center gap-1.5">
            {searchOpen ? (
              <Input
                autoFocus
                type="search"
                size="sm"
                className="w-44"
                value={query}
                placeholder="Search keybindings"
                aria-label="Search keybindings"
                onChange={(event) => setQuery(event.currentTarget.value)}
                onBlur={() => {
                  if (!query) setSearchOpen(false);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  event.stopPropagation();
                  setQuery("");
                  setSearchOpen(false);
                }}
              />
            ) : (
              <>
                <span className="text-2xs text-muted-foreground">
                  {rows.length + (adding ? 1 : 0)}{" "}
                  {rows.length + (adding ? 1 : 0) === 1
                    ? "binding"
                    : "bindings"}
                </span>
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="Search keybindings"
                  title="Search keybindings"
                  onClick={() => setSearchOpen(true)}
                >
                  <SearchIcon />
                </Button>
              </>
            )}
            <Button
              size="icon-xs"
              variant="ghost-muted"
              disabled={pending || adding}
              aria-label="Add keybinding"
              title="Add keybinding"
              onClick={() => setAdding(true)}
            >
              <PlusIcon />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              disabled={pending}
              aria-label="Reload keybindings.json"
              title="Reload keybindings.json"
              onClick={() => void run(() => keybindings.reload())}
            >
              <RotateCwIcon />
            </Button>
          </div>
        </div>
      </div>
      {state.path ? (
        <p className="select-text break-all px-3 font-mono text-2xs text-muted-foreground sm:px-4">
          {state.path}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-error/32 bg-error-surface px-3 py-2 text-sm text-error-foreground"
        >
          {error}
        </p>
      ) : null}
      {state.issues.length ? (
        <div
          role="alert"
          className="rounded-lg border border-warning/32 bg-warning-surface px-3 py-2 text-xs text-warning-foreground"
        >
          <p>
            Some keybinding rules could not be loaded. Defaults remain active
            for commands without a valid override.
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {state.issues.map((issue, index) => (
              <li key={`${issue.index ?? "file"}-${index}`}>
                {issue.index !== undefined ? `Rule ${issue.index + 1}. ` : ""}
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="relative overflow-visible text-foreground rounded-xl border border-border/60 bg-card/40 shadow-xs/5 [&>*+*]:border-t [&>*+*]:border-border/50 [&>[data-slot=settings-row]]:rounded-none">
        {adding ? (
          <BindingSettingsRow
            entry={{ kind: "new" }}
            allRows={allRows}
            commands={commands}
            variables={variables}
            extensions={extensions}
            pending={pending}
            onSave={save}
            onReset={() => undefined}
            onRemove={() => undefined}
            onCancel={() => setAdding(false)}
          />
        ) : null}
        {rows.map((row) => (
          <BindingSettingsRow
            key={row.id}
            entry={{ kind: "existing", row }}
            anchorId={anchors.get(row.id)}
            allRows={allRows}
            commands={commands}
            variables={variables}
            extensions={extensions}
            pending={pending}
            onSave={save}
            onReset={(target) => {
              const defaultRule = target.defaultRule;
              if (defaultRule)
                void run(() => keybindings.upsert(defaultRule, target.rule));
            }}
            onRemove={(target) =>
              void run(() => keybindings.remove(target.rule))
            }
            onCancel={() => undefined}
          />
        ))}
        {!rows.length && !adding ? (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground">
            No keybindings match your search.
          </div>
        ) : null}
      </div>
    </section>
  );
}
