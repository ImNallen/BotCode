// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/chat/OpenInPicker.tsx (MIT).
import { ChevronDownIcon } from "lucide-react";
import type { OpenTarget } from "../ipc";
import { cn } from "../lib/cn";
import { useEditorActions } from "../lib/editorActions";
import { editorById, type Editor } from "../lib/editors";
import { shortcutLabel } from "../lib/shortcuts";
import { Button } from "../ui/controls";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuShortcut } from "../ui/menu";

function getOpenInIconClass(kind: Editor["kind"]) {
  return cn(
    kind === "brand" ? "text-foreground opacity-100" : "text-muted-foreground",
  );
}

export function OpenInPicker({
  target,
  compact = false,
}: {
  target: OpenTarget;
  compact?: boolean;
}) {
  const editors = useEditorActions();
  const primary = editors.preferred ? editorById(editors.preferred) : null;
  const openFavoriteEditorShortcutLabel = shortcutLabel("editor.openFavorite");
  return (
    <Group aria-label="Open in editor" className="shrink-0">
      <Button
        aria-label={compact ? "Open file in preferred editor" : undefined}
        size="xs"
        variant="outline"
        disabled={!primary}
        onClick={() => editors.open(target)}
      >
        {primary ? (
          <primary.Icon
            aria-hidden="true"
            className={cn("size-3.5", getOpenInIconClass(primary.kind))}
          />
        ) : null}
        <span
          className={
            compact
              ? "sr-only"
              : "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5"
          }
        >
          Open
        </span>
      </Button>
      <GroupSeparator
        {...(!compact ? { className: "hidden @3xl/header-actions:block" } : {})}
      />
      <Menu
        align="end"
        trigger={(props) => (
          <Button
            {...props}
            aria-label="Choose editor"
            size="icon-xs"
            variant="outline"
          >
            <ChevronDownIcon aria-hidden="true" className="size-4" />
          </Button>
        )}
      >
        {editors.installed.length === 0 ? (
          <MenuItem disabled>No installed editors found</MenuItem>
        ) : null}
        {editors.installed.map(({ label, Icon, id, kind }) => (
          <MenuItem
            key={id}
            onClick={() => {
              editors.choose(id);
              editors.open(target, null, id);
            }}
          >
            <Icon aria-hidden="true" className={getOpenInIconClass(kind)} />
            <span className="min-w-0 truncate">{label}</span>
            {id === editors.preferred && openFavoriteEditorShortcutLabel ? (
              <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
            ) : null}
          </MenuItem>
        ))}
      </Menu>
    </Group>
  );
}
