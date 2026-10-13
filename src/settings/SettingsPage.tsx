// Ported from T3 Code v0.0.45 settings/SettingsPanels.tsx, SettingsSidebarNav.tsx, SettingsGroup.tsx, settingsLayout.tsx, WorkspacePageContainer.tsx, WorkspacePageHeader.tsx and ui/number-field.tsx (MIT).
import { MacPermissions, isMac } from "../permissions/MacPermissions";
import { GitHubProviderSettings } from "./GitHubProviderSettings";
import {
  SourceControlWritingRow,
  GitFetchIntervalSettings,
} from "./SourceControlSettings";
import { NotificationSettings } from "./NotificationSettings";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowLeftIcon, SearchIcon, XIcon } from "lucide-react";
import { SidebarMenuButton } from "../SidebarFooter";
import { Menu, MenuItem } from "../ui/menu";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { Button, Switch, selectTrigger, selectItem } from "../ui/controls";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { useEditorActions } from "../lib/editorActions";
import { editorById } from "../lib/editors";
import { KeybindingsSettings, revealKeybinding } from "./KeybindingsSettings";
import { useKeybindings } from "../keybindings/store";

import { cn } from "../lib/cn";
import { isMacPlatform } from "../lib/utils";
import { ProjectSettingRow } from "./ProjectSettingRow";
import {
  defaults,
  quitShortcutSchema,
  usePreferences,
  type QuitShortcut,
} from "./preferences";
import type { LinkTarget } from "../preview/linkTarget";
import { ArchivedThreadsPanel } from "./ArchivedThreadsPanel";
import { DiagnosticsSettings } from "./DiagnosticsSettings";
import { OpenSourceLicensesPanel } from "./OpenSourceLicenses";
import { ProjectsSettings } from "./ProjectsSettings";
import { StorageSettingsRow } from "./StorageSettings";
import { ThemeLibrary } from "./ThemeSettings";
import {
  AppearanceSettingsRow,
  TypographyAdvancedSwitch,
} from "./AppearanceSettings";
import { useAppearance } from "../appearance/AppearanceRoot";
import {
  categories,
  settingsSection,
  visibleRows,
  visibleSections,
  type SettingsRowInfo,
  type SettingsSection,
} from "./settingsCatalog";
import { SettingsScopeSentence, useSettingsScope } from "./settingsScope";
import {
  SettingResetButton,
  SettingsGroup,
  SettingsRow,
} from "./settingsLayout";

function useCategory() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const section = settingsSection
    .catch("general")
    .parse(pathname.split("/")[2]);
  return {
    section,
    licenses: pathname === "/settings/open-source-licenses",
    ...categories[section],
  };
}

export function SettingsSidebar() {
  const keybindings = useKeybindings();
  const category = useCategory();
  const navigate = useNavigate();
  const selection = useSearch({ from: "__root__" });
  const { scope } = useSettingsScope();
  const { preferences } = usePreferences();
  const { appearance, update: updateAppearance } = useAppearance();
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
        const rows = visibleRows(group, scope, preferences);
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
          ...rows
            .filter(
              (row) =>
                item.section !== "keybindings" ||
                keybindings.effective.some((rule) => rule.command === row.id),
            )
            .map((row) => ({
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
    const advanced = categories[section].groups.some((group) =>
      group.rows.some((row) => row.id === hash && row.advanced),
    );
    if (advanced && !appearance.typographyAdvanced)
      updateAppearance({ typographyAdvanced: true });
    setQuery("");
    setActiveIndex(0);
    if (section === "keybindings" && category.section === "keybindings")
      revealKeybinding(hash);
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

const modifierLabel = isMacPlatform(navigator.platform) ? "⌘" : "Ctrl";
const sendShortcutOptions = [
  { value: "enter", label: "Enter" },
  {
    value: "mod-enter-multiline",
    label: `${modifierLabel} + Enter for multiline prompts`,
  },
  { value: "mod-enter", label: `${modifierLabel} + Enter always` },
] as const;

const QUIT_CONFIRMATION_MODE_LABELS: Readonly<Record<QuitShortcut, string>> = {
  direct: "Direct",
  hold: "Hold",
  "double-click": "Double press",
};

function QuitShortcutControl() {
  const { preferences, update } = usePreferences();
  return (
    <Menu
      align="end"
      trigger={(props) => (
        <button
          type="button"
          {...props}
          className={selectTrigger({ size: "sm", className: "w-full sm:w-40" })}
          aria-label="Quit shortcut behavior"
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {QUIT_CONFIRMATION_MODE_LABELS[preferences.confirmQuit]}
          </span>
          <ChevronDownIcon className="size-3.5" />
        </button>
      )}
    >
      {quitShortcutSchema.options.map((mode) => (
        <MenuItem
          key={mode}
          className={selectItem}
          role="menuitemradio"
          aria-checked={preferences.confirmQuit === mode}
          onClick={() => update({ confirmQuit: mode })}
        >
          {QUIT_CONFIRMATION_MODE_LABELS[mode]}
        </MenuItem>
      ))}
    </Menu>
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

const LINK_TARGET_LABELS: Readonly<Record<LinkTarget, string>> = {
  system: "Your default browser",
  app: "L1 Code",
};

function LinkTargetControl() {
  const { preferences, update } = usePreferences();
  const current = preferences.browserLinkTarget;
  return (
    <Menu
      align="end"
      trigger={(props) => (
        <button
          type="button"
          {...props}
          className={selectTrigger({ size: "sm", className: "w-full sm:w-40" })}
          aria-label="Open links in"
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {LINK_TARGET_LABELS[current]}
          </span>
          <ChevronDownIcon className="size-3.5" />
        </button>
      )}
    >
      {(Object.keys(LINK_TARGET_LABELS) as LinkTarget[]).map((target) => (
        <MenuItem
          key={target}
          className={selectItem}
          role="menuitemradio"
          aria-checked={current === target}
          onClick={() => update({ browserLinkTarget: target })}
        >
          {LINK_TARGET_LABELS[target]}
        </MenuItem>
      ))}
    </Menu>
  );
}

export function SettingsPage() {
  const category = useCategory();
  const hash = useLocation({ select: (location) => location.hash });
  const navigate = useNavigate();
  const selection = useSearch({ from: "__root__" });
  const { preferences, update, reset, persistenceError } = usePreferences();
  const { scope, workspaces } = useSettingsScope();
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = document.getElementById(
      hash || `section-${category.section}`,
    );
    if (hash) target?.scrollIntoView({ block: "nearest" });
    else scrollRef.current?.scrollTo({ top: 0 });
    target?.focus({ preventScroll: true });
  }, [category.section, category.licenses, hash]);
  const control = (id: string) => {
    if (id === "working-shelf")
      return (
        <Switch
          aria-label="Working section (beta)"
          checked={preferences.sidebarWorkingShelfEnabled}
          onCheckedChange={(sidebarWorkingShelfEnabled) =>
            update({ sidebarWorkingShelfEnabled })
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
    if (id === "composer-rich-text")
      return (
        <Switch
          aria-label="Rich text composer"
          checked={preferences.composerRichTextEnabled}
          onCheckedChange={(composerRichTextEnabled) =>
            update({ composerRichTextEnabled })
          }
        />
      );
    if (id === "composer-collapse")
      return (
        <Switch
          aria-label="Collapse composer on scroll"
          checked={preferences.composerCollapseOnScroll}
          onCheckedChange={(composerCollapseOnScroll) =>
            update({ composerCollapseOnScroll })
          }
        />
      );
    if (id === "send-shortcut")
      return (
        <Menu
          align="end"
          trigger={(props) => (
            <button
              type="button"
              {...props}
              className={selectTrigger({
                size: "sm",
                className: "w-auto min-w-0 max-w-full",
              })}
              aria-label="Send shortcut"
            >
              {
                sendShortcutOptions.find(
                  (option) => option.value === preferences.sendShortcut,
                )?.label
              }
              <ChevronDownIcon className="size-3.5" />
            </button>
          )}
        >
          {sendShortcutOptions.map((option) => (
            <MenuItem
              key={option.value}
              className={selectItem}
              role="menuitemradio"
              aria-checked={preferences.sendShortcut === option.value}
              onClick={() => update({ sendShortcut: option.value })}
            >
              <span className="flex items-center justify-between gap-4">
                {option.label}
                {preferences.sendShortcut === option.value && (
                  <CheckIcon aria-hidden="true" />
                )}
              </span>
            </MenuItem>
          ))}
        </Menu>
      );
    if (id === "quit-confirmation") return <QuitShortcutControl />;
    if (id === "preferred-editor") return <PreferredEditorControl />;
    if (id === "browser-link-target") return <LinkTargetControl />;
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
    if (id === "diagnostics")
      return (
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void navigate({
              to: "/settings/$section",
              params: { section: "diagnostics" },
              search: selection,
              hash: "",
              resetScroll: false,
              hashScrollIntoView: false,
            })
          }
        >
          View diagnostics
        </Button>
      );
    if (id === "open-source-licenses")
      return (
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void navigate({
              to: "/settings/open-source-licenses",
              search: selection,
              hash: "",
              resetScroll: false,
              hashScrollIntoView: false,
            })
          }
        >
          View licenses
        </Button>
      );
    return null;
  };
  const resettable = {
    "working-shelf": ["working section", "sidebarWorkingShelfEnabled"],
    "composer-rich-text": ["rich text composer", "composerRichTextEnabled"],
    "composer-collapse": [
      "collapse composer on scroll",
      "composerCollapseOnScroll",
    ],
    "send-shortcut": ["send shortcut", "sendShortcut"],
    "quit-confirmation": ["quit shortcut behavior", "confirmQuit"],
    "browser-link-target": ["link target", "browserLinkTarget"],
  } as const;
  const resetAction = (id: string) => {
    if (!(id in resettable)) return undefined;
    const [label, key] = resettable[id as keyof typeof resettable];
    return preferences[key] !== defaults[key] ? (
      <SettingResetButton
        label={label}
        onClick={() => update({ [key]: defaults[key] })}
      />
    ) : undefined;
  };
  const row = (info: SettingsRowInfo) =>
    category.section === "storage" ? (
      <StorageSettingsRow key={info.id} info={info} scope={scope} />
    ) : category.section === "appearance" ? (
      <AppearanceSettingsRow key={info.id} info={info} />
    ) : info.id === "source-control-writing-style" ||
      info.id === "follow-change-request-templates" ? (
      <SourceControlWritingRow
        key={info.id}
        scope={scope}
        templates={info.id === "follow-change-request-templates"}
      />
    ) : info.id === "git-fetch-interval" ? (
      <GitFetchIntervalSettings key={info.id} />
    ) : info.id === "thread-notifications" ? (
      <NotificationSettings key={info.id} info={info} />
    ) : info.setting ? (
      <ProjectSettingRow
        key={info.id}
        id={info.id}
        setting={info.setting}
        scope={scope}
      />
    ) : (
      <SettingsRow
        key={info.id}
        {...info}
        description={
          info.id === "follow-up-behavior"
            ? `${info.description} ${
                preferences.sendShortcut === "mod-enter-multiline"
                  ? `Press ${modifierLabel} + Enter for single-line prompts or ${modifierLabel} + Shift + Enter for multiline prompts to do the opposite for one message.`
                  : `Press ${modifierLabel}${preferences.sendShortcut === "mod-enter" ? " + Shift" : ""} + Enter to do the opposite for one message.`
              }`
            : info.description
        }
        control={control(info.id)}
        resetAction={resetAction(info.id)}
      />
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
            {category.licenses ? "Open source licenses" : category.title}
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
        ref={scrollRef}
        data-settings-page-scroll
        className="topbar-scroll-fade scrollbar-gutter-both flex-1 overflow-y-auto"
      >
        <div
          className={cn(
            "mx-auto flex w-full flex-col px-5 pt-6 pb-12 sm:px-6",
            category.section === "diagnostics" ? "max-w-6xl" : "max-w-4xl",
            category.section === "projects"
              ? "gap-6"
              : category.section === "diagnostics"
                ? "gap-10"
                : "gap-8",
          )}
        >
          <h1
            id={`section-${category.section}`}
            tabIndex={-1}
            className="sr-only"
          >
            {category.licenses
              ? "Open source licenses"
              : `${category.title} settings`}
          </h1>
          {category.scoped && !category.licenses ? (
            <SettingsScopeSentence />
          ) : null}
          {persistenceError ? (
            <p
              role="alert"
              className="rounded-lg border border-error/32 bg-error-surface px-3 py-2 text-sm text-error-foreground"
            >
              {persistenceError}
            </p>
          ) : null}
          {category.licenses ? (
            <OpenSourceLicensesPanel />
          ) : category.section === "archived" ? (
            <ArchivedThreadsPanel />
          ) : category.section === "diagnostics" ? (
            <DiagnosticsSettings />
          ) : category.section === "projects" ? (
            scope && <ProjectsSettings scope={scope} workspaces={workspaces} />
          ) : category.section === "keybindings" ? (
            <KeybindingsSettings />
          ) : (
            category.groups.map((group) => {
              if (group.id === "mac-permissions")
                return isMac ? (
                  <SettingsGroup
                    key={group.id}
                    id={group.id}
                    title={group.title}
                  >
                    <div
                      id="mac-permissions-controls"
                      className="px-3 py-3 sm:px-4"
                    >
                      <MacPermissions />
                    </div>
                  </SettingsGroup>
                ) : null;
              if (group.id === "source-control-providers")
                return <GitHubProviderSettings key={group.id} />;
              if (group.id === "appearance")
                return (
                  <SettingsGroup
                    key={group.id}
                    id={group.id}
                    title={group.title}
                    hideTitle
                    variant="plain"
                  >
                    <div id="theme" tabIndex={-1} className="outline-none">
                      <ThemeLibrary />
                    </div>
                  </SettingsGroup>
                );
              const rows = visibleRows(group, scope, preferences)?.filter(
                (row) =>
                  !row.advanced || preferences.appearance.typographyAdvanced,
              );
              if (rows === undefined) return null;
              return (
                <SettingsGroup
                  key={group.id}
                  id={group.id}
                  title={group.title}
                  headerAction={
                    group.id === "typography" ? (
                      <TypographyAdvancedSwitch />
                    ) : undefined
                  }
                >
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
