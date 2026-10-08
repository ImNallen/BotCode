// Ported from pingdotgg/t3code v0.0.45 components/CommandPaletteResults.tsx (MIT).
import { ChevronRightIcon } from "lucide-react";
import { ThreadSearchMatchExcerpt } from "./ThreadSearchMatch";
import type { MessageMatch } from "./commandPaletteSearch";
import type { ReactNode } from "react";
import {
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "../ui/command";
export type PaletteItem = {
  id: string;
  title: string;
  icon: ReactNode;
  description?: ReactNode;
  threadContentMatch?: MessageMatch;
  shortcut?: string;
  submenu?: boolean;
  execute: () => void;
};
export type PaletteGroup = { label: string; items: PaletteItem[] };
export function CommandPaletteResults({
  groups,
  activeId,
  onHighlight,
  emptyMessage,
}: {
  groups: PaletteGroup[];
  activeId: string | undefined;
  onHighlight: (id: string) => void;
  emptyMessage: string;
}) {
  if (!groups.some((group) => group.items.length))
    return (
      <div
        className="py-10 text-center text-sm text-muted-foreground"
        role="status"
      >
        {emptyMessage}
      </div>
    );
  return (
    <CommandList
      role="listbox"
      id="command-palette-results"
      aria-label="Commands and threads"
    >
      {groups
        .filter((group) => group.items.length > 0)
        .map((group) => (
          <CommandGroup key={group.label} role="group" aria-label={group.label}>
            <CommandGroupLabel>{group.label}</CommandGroupLabel>
            {group.items.map((item) => (
              <CommandItem
                key={item.id}
                id={item.id}
                role="option"
                aria-selected={activeId === item.id}
                active={activeId === item.id}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => onHighlight(item.id)}
                onClick={item.execute}
              >
                {item.icon}
                {item.description || item.threadContentMatch ? (
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
                      <span className="truncate">{item.title}</span>
                    </span>
                    {item.threadContentMatch ? (
                      <ThreadSearchMatchExcerpt
                        match={item.threadContentMatch}
                      />
                    ) : null}
                    {item.description ? (
                      <span className="min-w-0 text-muted-foreground/70 text-xs">
                        {item.description}
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-foreground">
                    <span className="truncate">{item.title}</span>
                  </span>
                )}
                {item.shortcut ? (
                  <CommandShortcut>{item.shortcut}</CommandShortcut>
                ) : null}
                {item.submenu ? (
                  <ChevronRightIcon className="-me-0.5 ms-auto size-4 shrink-0 text-muted-foreground/70" />
                ) : null}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
    </CommandList>
  );
}
