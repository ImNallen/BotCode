// Ported from T3 Code v0.0.45 settings/SettingsPanels.tsx, SettingsSidebarNav.tsx, SettingsGroup.tsx, settingsLayout.tsx, WorkspacePageContainer.tsx, WorkspacePageHeader.tsx and ui/number-field.tsx (MIT).
import { NotificationSettings } from "./NotificationSettings";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowLeftIcon, SearchIcon, XIcon } from "lucide-react";
import { SidebarMenuButton } from "../SidebarFooter";
import { Menu, MenuItem } from "../ui/menu";
import { ChevronDownIcon } from "lucide-react";
import {
  Button,
  Switch,
  Toggle,
  selectTrigger,
  selectItem,
} from "../ui/controls";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { actionIds } from "../lib/actions";
import { useEditorActions } from "../lib/editorActions";
import { editorById } from "../lib/editors";
import { shortcutLabel } from "../lib/shortcuts";

import { cn } from "../lib/cn";
import { ProjectSettingRow } from "./ProjectSettingRow";
import { usePreferences } from "./preferences";
import { ArchivedThreadsPanel } from "./ArchivedThreadsPanel";
import { ProjectsSettings } from "./ProjectsSettings";
import { RetentionControl } from "./RetentionControl";
import {
  categories,
  settingsSection,
  visibleRows,
  visibleSections,
  type SettingsRowInfo,
  type SettingsSection,
} from "./settingsCatalog";
import { SettingsScopeSentence, useSettingsScope } from "./settingsScope";
import { SettingsGroup, SettingsRow } from "./settingsLayout";

function useCategory() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const section = settingsSection
    .catch("general")
    .parse(pathname.split("/")[2]);
  return { section, ...categories[section] };
}

export function SettingsSidebar() {
  const category = useCategory();
  const navigate = useNavigate();
  const selection = useSearch({ from: "__root__" });
  const { scope } = useSettingsScope();
  const visible = visibleSections(scope).map((section) => ({
    section,
    ...categories[section],
  }));
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const needle = query.trim().toLowerCase();
  const searching = needle.length > 0;
  const results = visible
    .flatMap((item) => [
      {
        section: item.section,
        category: item.title,
        icon: item.icon,
        id: `section-${item.section}`,
        title: item.title,
        text: item.title,
      },
      ...item.groups.flatMap((group) => {
        const rows = visibleRows(group, scope);
        if (rows === undefined) return [];
        return [
          ...(group.hideTitle
            ? []
            : [
                {
                  section: item.section,
                  category: item.title,
                  icon: item.icon,
                  id: group.id,
                  title: group.title,
                  text: `${item.title} ${group.title}`,
                },
              ]),
          ...rows.map((row) => ({
            section: item.section,
            category: item.title,
            icon: item.icon,
            id: row.id,
            title: row.title,
            text: `${item.title} ${group.title} ${row.title} ${row.description} ${row.keywords ?? ""}`,
          })),
        ];
      }),
    ])
    .filter((result) => result.text.toLowerCase().includes(needle));
  const active = results[activeIndex];
  const go = (section: SettingsSection, hash = "") => {
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
                : visible.map((item) => (
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

function PreferredEditorControl() {
  const { preferences, update } = usePreferences();
  const editors = useEditorActions();
  const stored = preferences.preferredEditor;
  return (
    <Menu
      trigger={(props) => (
        <button
          type="button"
          {...props}
          className={selectTrigger({
            size: "sm",
            className: "w-auto min-w-0",
          })}
          aria-label="Preferred editor"
        >
          {stored === null ? "Automatic" : editorById(stored).label}
          <ChevronDownIcon className="size-3.5" />
        </button>
      )}
    >
      <MenuItem
        className={selectItem}
        role="menuitemradio"
        aria-checked={stored === null}
        onClick={() => update({ preferredEditor: null })}
      >
        Automatic
      </MenuItem>
      {editors.installed.map(({ id, label, Icon }) => (
        <MenuItem
          key={id}
          className={selectItem}
          role="menuitemradio"
          aria-checked={stored === id}
          onClick={() => update({ preferredEditor: id })}
        >
          <Icon aria-hidden="true" className="me-2" />
          {label}
        </MenuItem>
      ))}
    </Menu>
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

export function SettingsPage() {
  const category = useCategory();
  const hash = useLocation({ select: (location) => location.hash });
  const navigate = useNavigate();
  const selection = useSearch({ from: "__root__" });
  const { preferences, update, reset, persistenceError } = usePreferences();
  const { scope, workspaces } = useSettingsScope();
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
    if (id === "worktree-on-delete")
      return (
        <Switch
          aria-label="Delete worktrees with deleted threads"
          checked={preferences.storageCleanup.worktreeOnDelete}
          onCheckedChange={(worktreeOnDelete) =>
            update({
              storageCleanup: {
                ...preferences.storageCleanup,
                worktreeOnDelete,
              },
            })
          }
        />
      );
    if (id === "worktree-after-days")
      return (
        <RetentionControl
          label="Delete inactive worktrees"
          value={preferences.storageCleanup.worktreeAfterDays}
          onChange={(worktreeAfterDays) =>
            update({
              storageCleanup: {
                ...preferences.storageCleanup,
                worktreeAfterDays,
              },
            })
          }
        />
      );
    if (id === "worktree-unchanged")
      return (
        <Switch
          aria-label="Delete unchanged worktrees"
          checked={preferences.storageCleanup.worktreeUnchanged}
          onCheckedChange={(worktreeUnchanged) =>
            update({
              storageCleanup: {
                ...preferences.storageCleanup,
                worktreeUnchanged,
              },
            })
          }
        />
      );
    if (id === "in-app-notifications")
      return (
        <Switch
          aria-label="In-app notifications"
          checked={preferences.inAppNotificationsEnabled}
          onCheckedChange={(inAppNotificationsEnabled) =>
            update({ inAppNotificationsEnabled })
          }
        />
      );
    if (id === "follow-up-behavior")
      return (
        <Menu
          trigger={(props) => (
            <button
              type="button"
              {...props}
              className={selectTrigger({
                size: "sm",
                className: "w-auto min-w-0",
              })}
              aria-label="Follow-up behavior"
            >
              {preferences.followUpBehavior === "queue" ? "Queue" : "Steer"}
              <ChevronDownIcon className="size-3.5" />
            </button>
          )}
        >
          {(["queue", "steer"] as const).map((value) => (
            <MenuItem
              key={value}
              className={selectItem}
              role="menuitemradio"
              aria-checked={preferences.followUpBehavior === value}
              onClick={() => update({ followUpBehavior: value })}
            >
              {value === "queue" ? "Queue" : "Steer"}
            </MenuItem>
          ))}
        </Menu>
      );
    if (id === "preferred-editor") return <PreferredEditorControl />;
    if (id === "context-window-indicator")
      return (
        <Switch
          aria-label="Context window indicator"
          checked={preferences.contextWindowMeter}
          onCheckedChange={(contextWindowMeter) =>
            update({ contextWindowMeter })
          }
        />
      );
    if (id === "restore")
      return (
        <Button size="sm" variant="outline" onClick={reset}>
          Restore defaults
        </Button>
      );
    const actionId = actionIds.find((actionId) => actionId === id);
    const shortcut = actionId ? shortcutLabel(actionId) : undefined;
    if (shortcut)
      return (
        <kbd className="rounded-md border border-border bg-muted px-2 py-1 font-mono text-xs">
          {shortcut}
        </kbd>
      );
    return null;
  };
  const row = (info: SettingsRowInfo) =>
    info.id === "thread-notifications" ? (
      <NotificationSettings key={info.id} info={info} />
    ) : info.setting ? (
      <ProjectSettingRow
        key={info.id}
        id={info.id}
        setting={info.setting}
        scope={scope}
      />
    ) : (
      <SettingsRow key={info.id} {...info} control={control(info.id)} />
    );
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
              search: { ...selection, project: undefined },
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
        <div
          className={cn(
            "mx-auto flex w-full flex-col px-5 pt-6 pb-12 sm:px-6 max-w-4xl",
            category.section === "projects" ? "gap-6" : "gap-8",
          )}
        >
          <h1
            id={`section-${category.section}`}
            tabIndex={-1}
            className="sr-only"
          >
            {category.title} settings
          </h1>
          {category.scoped ? <SettingsScopeSentence /> : null}
          {persistenceError ? (
            <p
              role="alert"
              className="rounded-lg border border-error/32 bg-error-surface px-3 py-2 text-sm text-error-foreground"
            >
              {persistenceError}
            </p>
          ) : null}
          {category.section === "archived" ? (
            <ArchivedThreadsPanel />
          ) : category.section === "projects" ? (
            scope && <ProjectsSettings scope={scope} workspaces={workspaces} />
          ) : (
            category.groups.map((group) => {
              const rows = visibleRows(group, scope);
              if (rows === undefined) return null;
              return (
                <SettingsGroup key={group.id} id={group.id} title={group.title}>
                  {rows.length > 0 ? (
                    rows.map(row)
                  ) : (
                    <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
                      This project is no longer available.
                    </p>
                  )}
                </SettingsGroup>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
