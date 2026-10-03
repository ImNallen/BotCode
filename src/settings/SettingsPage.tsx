// Classes copied from pingdotgg/t3code v0.0.45 settings/SettingsSidebarNav.tsx, SettingsGroup.tsx,
// settingsLayout.tsx, WorkspacePageContainer.tsx, WorkspacePageHeader.tsx and ui/number-field.tsx (MIT).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  KeyboardIcon,
  PaletteIcon,
  SearchIcon,
  Settings2Icon,
  XIcon,
} from "lucide-react";
import { z } from "zod";
import { SidebarMenuButton } from "../SidebarFooter";
import {
  Button,
  Switch,
  Toggle,
  selectItem,
  selectTrigger,
} from "../ui/controls";
import { Menu, MenuItem } from "../ui/menu";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { newWithoutProjectShortcut } from "../lib/shortcuts";
import { checkoutModeLabels, usePreferences } from "./preferences";

export const settingsSection = z.enum(["general", "appearance", "keybindings"]);
const categories = [
  {
    section: "general",
    title: "General",
    icon: Settings2Icon,
    groups: [
      {
        id: "application",
        title: "Application",
        rows: [
          {
            id: "provider",
            title: "Provider",
            description: "Z1 Code runs your conversations with Codex.",
          },
          {
            id: "approval",
            title: "Approval mode",
            description:
              "Choose Supervised, Auto-accept edits, Auto, or Full access in each conversation composer.",
          },
        ],
      },
      {
        id: "new-threads",
        title: "New threads",
        rows: [
          {
            id: "workspace",
            title: "Workspace",
            description: "Where new threads start.",
            keywords: "default mode draft current local checkout new worktree",
          },
          {
            id: "start-from-origin",
            title: "Start from origin",
            description:
              "Creates the worktree from the latest matching branch on origin instead of your local branch.",
            keywords: "new worktrees latest matching remote branch local",
          },
        ],
      },
      {
        id: "preferences",
        title: "Device preferences",
        rows: [
          {
            id: "restore",
            title: "Restore defaults",
            description:
              "Reset appearance, font sizes and new thread defaults on this device.",
          },
        ],
      },
    ],
  },
  {
    section: "appearance",
    title: "Appearance",
    icon: PaletteIcon,
    groups: [
      {
        id: "colors",
        title: "Colors",
        rows: [
          {
            id: "theme",
            title: "Appearance",
            description:
              "Use a light or dark interface, or follow your system.",
          },
        ],
      },
      {
        id: "typography",
        title: "Typography",
        rows: [
          {
            id: "prompt-font",
            title: "Prompt font size",
            description: "Set the font size of the message composer.",
          },
          {
            id: "code-font",
            title: "Code font size",
            description:
              "Set the font size of code blocks, tool output, file previews and diffs.",
          },
        ],
      },
    ],
  },
  {
    section: "keybindings",
    title: "Keyboard shortcuts",
    icon: KeyboardIcon,
    groups: [
      {
        id: "navigation",
        title: "Navigation",
        rows: [
          {
            id: "toggle-sidebar",
            title: "Toggle sidebar",
            description: "Show or hide the main sidebar.",
          },
          {
            id: "new-without-project",
            title: "New thread without a project",
            description:
              "Start a thread in its own folder instead of a project.",
            keywords: "scratch no project",
          },
          {
            id: "open-settings",
            title: "Open settings",
            description:
              "Open General settings from anywhere in the workbench.",
          },
          {
            id: "close-settings",
            title: "Back to conversation",
            description:
              "Leave settings. Search and open menus handle Escape first.",
          },
        ],
      },
    ],
  },
] as const satisfies {
  section: z.infer<typeof settingsSection>;
  title: string;
  icon: typeof Settings2Icon;
  groups: {
    id: string;
    title: string;
    rows: {
      id: string;
      title: string;
      description: string;
      keywords?: string;
    }[];
  }[];
}[];

function useCategory() {
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    categories.find(
      (category) => pathname === `/settings/${category.section}`,
    ) ?? categories[0]
  );
}

export function SettingsSidebar() {
  const category = useCategory();
  const navigate = useNavigate();
  const selection = useSearch({ from: "__root__" });
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const needle = query.trim().toLowerCase();
  const searching = needle.length > 0;
  const results = categories
    .flatMap((item) => [
      {
        section: item.section,
        category: item.title,
        icon: item.icon,
        id: `section-${item.section}`,
        title: item.title,
        text: item.title,
      },
      ...item.groups.flatMap((group) => [
        {
          section: item.section,
          category: item.title,
          icon: item.icon,
          id: group.id,
          title: group.title,
          text: `${item.title} ${group.title}`,
        },
        ...group.rows.map((row) => ({
          section: item.section,
          category: item.title,
          icon: item.icon,
          id: row.id,
          title: row.title,
          text: `${item.title} ${group.title} ${row.title} ${row.description} ${"keywords" in row ? row.keywords : ""}`,
        })),
      ]),
    ])
    .filter((result) => result.text.toLowerCase().includes(needle));
  const active = results[activeIndex];
  const go = (section: z.infer<typeof settingsSection>, hash = "") => {
    setQuery("");
    setActiveIndex(0);
    void navigate({
      to: "/settings/$section",
      params: { section },
      search: selection,
      hash,
      resetScroll: false,
      hashScrollIntoView: false,
    });
    if (section === category.section)
      requestAnimationFrame(() => {
        const target = document.getElementById(hash || `section-${section}`);
        target?.scrollIntoView({ block: "nearest" });
        target?.focus({ preventScroll: true });
      });
  };
  useEffect(() => {
    document
      .getElementById(`settings-search-result-${active?.id}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active?.id]);
  return (
    <div className="h-auto min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div
        data-sidebar="content"
        className="flex w-full min-w-0 flex-col [overflow-anchor:none] group-data-[collapsible=icon]:overflow-hidden [&>[data-sidebar=group]+[data-sidebar=group]]:pt-0 overflow-x-hidden"
      >
        <div
          data-sidebar="group"
          className="relative flex w-full min-w-0 flex-col p-[var(--sidebar-content-inset)]"
        >
          <div className="flex flex-col gap-2">
            <div className="flex h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground">
              <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
              <input
                ref={searchRef}
                type="search"
                placeholder="Search"
                aria-label="Search settings"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={searching && results.length > 0}
                aria-controls={
                  searching && results.length > 0
                    ? "settings-search-results"
                    : undefined
                }
                aria-activedescendant={
                  searching && active
                    ? `settings-search-result-${active.id}`
                    : undefined
                }
                value={query}
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                  setActiveIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && query) {
                    event.preventDefault();
                    event.stopPropagation();
                    setQuery("");
                    setActiveIndex(0);
                  }
                  if (!searching || results.length === 0) return;
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    setActiveIndex(
                      (index) =>
                        (index +
                          (event.key === "ArrowDown"
                            ? 1
                            : results.length - 1)) %
                        results.length,
                    );
                  }
                  if (event.key === "Enter" && active) {
                    event.preventDefault();
                    go(active.section, active.id);
                  }
                }}
                className="min-w-0 flex-1 bg-transparent p-0 font-medium text-sidebar-foreground text-sm leading-normal outline-none placeholder:text-sidebar-muted-foreground [&::-webkit-search-cancel-button]:hidden"
              />
              {searching ? (
                <Button
                  size="icon-micro"
                  variant="ghost-muted"
                  className="shrink-0"
                  aria-label="Clear settings search"
                  onClick={() => {
                    setQuery("");
                    setActiveIndex(0);
                    searchRef.current?.focus();
                  }}
                >
                  <XIcon className="size-3" />
                </Button>
              ) : null}
            </div>
            {searching && results.length === 0 ? (
              <p
                role="status"
                className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
              >
                No settings found
              </p>
            ) : null}
            <ul
              id={
                searching && results.length
                  ? "settings-search-results"
                  : undefined
              }
              role={searching && results.length ? "listbox" : undefined}
              aria-label={
                searching && results.length
                  ? "Settings search results"
                  : undefined
              }
              className="flex w-full min-w-0 flex-col gap-1"
            >
              {searching
                ? results.map((result, index) => (
                    <li
                      key={result.id}
                      role="presentation"
                      className="group/menu-item relative"
                    >
                      <SidebarMenuButton
                        id={`settings-search-result-${result.id}`}
                        role="option"
                        aria-selected={index === activeIndex}
                        tabIndex={-1}
                        data-active={index === activeIndex}
                        className="h-7 rounded-lg p-2 text-xs h-auto min-h-10 items-start"
                        onMouseMove={() => setActiveIndex(index)}
                        onClick={() => go(result.section, result.id)}
                      >
                        <result.icon className="mt-0.5 size-3.5 shrink-0 text-sidebar-muted-foreground/60" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-sidebar-foreground">
                            {result.title}
                          </span>
                          <span className="block truncate text-2xs text-sidebar-muted-foreground/75">
                            {result.category}
                          </span>
                        </span>
                      </SidebarMenuButton>
                    </li>
                  ))
                : categories.map((item) => (
                    <li key={item.section} className="group/menu-item relative">
                      <SidebarMenuButton
                        data-active={item.section === category.section}
                        aria-current={
                          item.section === category.section ? "page" : undefined
                        }
                        onClick={() => go(item.section)}
                      >
                        <item.icon />
                        <span className="truncate">{item.title}</span>
                      </SidebarMenuButton>
                    </li>
                  ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

function FontSizeControl({
  value,
  min,
  label,
  onChange,
}: {
  value: number;
  min: number;
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
          max={20}
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

function SettingsRow({
  id,
  title,
  description,
  control,
}: {
  id: string;
  title: string;
  description: string;
  control: ReactNode;
}) {
  return (
    <div
      id={id}
      tabIndex={-1}
      data-slot="settings-row"
      className="@container/settings-row rounded-xl px-3 sm:px-4 aria-disabled:opacity-64 aria-disabled:[&_*]:text-muted-foreground py-3 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex flex-col gap-3 @min-[32rem]/settings-row:grid @min-[32rem]/settings-row:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] @min-[32rem]/settings-row:items-center @min-[32rem]/settings-row:gap-8">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="text-sm font-medium text-foreground">{title}</h3>
          </div>
          <p className="max-w-xl text-xs leading-normal text-muted-foreground/80">
            {description}
          </p>
        </div>
        {control ? (
          <div className="flex w-full min-w-0 shrink-0 items-center gap-2 @min-[32rem]/settings-row:w-auto @min-[32rem]/settings-row:justify-end">
            {control}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function SettingsPage() {
  const category = useCategory();
  const hash = useLocation({ select: (location) => location.hash });
  const navigate = useNavigate();
  const selection = useSearch({ from: "__root__" });
  const { preferences, update, reset, persistenceError } = usePreferences();
  const modifier = /Mac/.test(navigator.userAgent) ? "⌘" : "Ctrl+";
  useEffect(() => {
    const target = document.getElementById(
      hash || `section-${category.section}`,
    );
    target?.scrollIntoView({ block: "nearest" });
    target?.focus({ preventScroll: true });
  }, [category.section, hash]);
  const control = (id: string) => {
    if (id === "theme")
      return (
        <div
          className="flex items-center gap-1"
          role="group"
          aria-label="Appearance"
        >
          {(["system", "light", "dark"] as const).map((appearance) => (
            <Toggle
              key={appearance}
              variant="outline"
              size="sm"
              pressed={preferences.appearance === appearance}
              onClick={() => update({ appearance })}
            >
              {appearance === "system"
                ? "System"
                : appearance === "light"
                  ? "Light"
                  : "Dark"}
            </Toggle>
          ))}
        </div>
      );
    if (id === "prompt-font" || id === "code-font") {
      const prompt = id === "prompt-font";
      return (
        <FontSizeControl
          value={prompt ? preferences.promptFontSize : preferences.codeFontSize}
          min={prompt ? 12 : 11}
          label={prompt ? "Prompt font size" : "Code font size"}
          onChange={(value) =>
            update(prompt ? { promptFontSize: value } : { codeFontSize: value })
          }
        />
      );
    }
    if (id === "workspace")
      return (
        <Menu
          align="end"
          trigger={(props) => (
            <button
              type="button"
              {...props}
              aria-label="Default workspace"
              className={selectTrigger()}
            >
              <span className="min-w-0 flex-1 truncate text-left">
                {checkoutModeLabels[preferences.newThreadCheckout]}
              </span>
              <ChevronDownIcon
                aria-hidden
                className="-me-1 size-3 shrink-0 opacity-50"
              />
            </button>
          )}
        >
          {(["local", "worktree"] as const).map((mode) => (
            <MenuItem
              key={mode}
              role="menuitemradio"
              aria-checked={preferences.newThreadCheckout === mode}
              data-selected={
                preferences.newThreadCheckout === mode ? "" : undefined
              }
              className={selectItem}
              onClick={() => update({ newThreadCheckout: mode })}
            >
              {checkoutModeLabels[mode]}
            </MenuItem>
          ))}
        </Menu>
      );
    if (id === "start-from-origin")
      return (
        <Switch
          checked={preferences.newWorktreesStartFromOrigin}
          onCheckedChange={(checked) =>
            update({ newWorktreesStartFromOrigin: checked })
          }
          aria-label="Start new worktrees from origin by default"
        />
      );
    if (id === "restore")
      return (
        <Button size="sm" variant="outline" onClick={reset}>
          Restore defaults
        </Button>
      );
    if (
      id === "toggle-sidebar" ||
      id === "new-without-project" ||
      id === "open-settings" ||
      id === "close-settings"
    )
      return (
        <kbd className="rounded-md border border-border bg-muted px-2 py-1 font-mono text-xs">
          {id === "toggle-sidebar"
            ? `${modifier}B`
            : id === "new-without-project"
              ? newWithoutProjectShortcut
              : id === "open-settings"
                ? `${modifier},`
                : "Escape"}
        </kbd>
      );
    return null;
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      <header
        data-tauri-drag-region="deep"
        className="flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-3 pl-(--workspace-gutter-start) pr-(--workspace-gutter-end) drag-region [[data-sidebar-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)]"
      >
        <WorkspaceBreadcrumb ariaLabel="Settings breadcrumb">
          <WorkspaceBreadcrumbItem>Settings</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
          <WorkspaceBreadcrumbItem current className="truncate">
            {category.title}
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto md:hidden [[data-sidebar-state=collapsed]_&]:inline-flex"
          onClick={() =>
            void navigate({
              to: "/",
              search: selection,
              hash: "",
              resetScroll: false,
            })
          }
        >
          <ArrowLeftIcon className="size-4" />
          Back
        </Button>
      </header>
      <div
        data-settings-page-scroll
        className="topbar-scroll-fade scrollbar-gutter-both flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex w-full flex-col gap-6 px-5 pt-6 pb-12 sm:px-6 max-w-4xl gap-8">
          <h1
            id={`section-${category.section}`}
            tabIndex={-1}
            className="sr-only"
          >
            {category.title} settings
          </h1>
          {persistenceError ? (
            <p
              role="alert"
              className="rounded-lg border border-error/32 bg-error-surface px-3 py-2 text-sm text-error-foreground"
            >
              {persistenceError}
            </p>
          ) : null}
          {category.groups.map((group) => (
            <section
              key={group.id}
              id={group.id}
              tabIndex={-1}
              className="space-y-2.5 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div
                data-settings-scroll-target
                className="flex min-h-7 items-start justify-between gap-4 px-3 sm:px-4"
              >
                <div className="min-w-0">
                  <h2 className="flex min-h-7 items-center gap-2 text-sm font-normal text-foreground/70">
                    {group.title}
                  </h2>
                </div>
              </div>
              <div className="relative overflow-visible text-foreground rounded-xl border border-border/60 bg-card/40 shadow-xs/5 [&>*+*]:border-t [&>*+*]:border-border/50 [&>[data-slot=settings-row]]:rounded-none">
                {group.rows.map((row) => (
                  <SettingsRow
                    key={row.id}
                    {...row}
                    control={control(row.id)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
