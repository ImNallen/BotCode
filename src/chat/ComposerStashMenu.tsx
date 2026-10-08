// Ported from T3 Code v0.0.45 apps/web/src/components/chat/ComposerStashMenu.tsx (MIT).
import { BookmarkIcon, FileIcon, FileTextIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { contextReferences } from "./composerContext";

import { formatRelativeTimeLabel } from "../lib/time";
import { cn } from "../lib/cn";
import { isTerminalFocused } from "../terminal/terminalKeys";
import { type PromptStashEntry } from "./promptStash";
import { attachmentUrl } from "./composerAttachments";
import { ComposerBanner } from "./ComposerBanner";

const SNIPPET_MAX_CHARS = 90;

function stashEntrySnippet(entry: PromptStashEntry): string {
  let prompt = entry.payload.text;
  for (const ref of contextReferences(prompt).toReversed())
    prompt = prompt.slice(0, ref.start) + ref.label + prompt.slice(ref.end);
  const trimmed = prompt.trim().replace(/\s+/g, " ");
  if (trimmed)
    return trimmed.length > SNIPPET_MAX_CHARS
      ? `${trimmed.slice(0, SNIPPET_MAX_CHARS)}…`
      : trimmed;
  const count = entry.payload.attachments.length;
  return count
    ? `(${count} attachment${count === 1 ? "" : "s"})`
    : entry.payload.records.length
      ? `(${entry.payload.records.length} context chips)`
      : "(empty)";
}
/**
 * Attached banner listing the stashed prompts. Opened by the stash badge or ⌘S
 * when the empty composer cannot restore a single entry. Navigated with arrows,
 * restored with Enter, dismissed with Escape. The listener runs capture-phase
 * on window so it wins over the composer's handlers while the menu is open.
 */
export const ComposerStashMenu = memo(function ComposerStashMenu(props: {
  entries: ReadonlyArray<PromptStashEntry>;
  stashShortcutLabel: string | null;
  onRestore: (entry: PromptStashEntry) => void;
  onDelete: (entry: PromptStashEntry) => void;
  onClose: () => void;
}) {
  const { entries, stashShortcutLabel, onRestore, onDelete, onClose } = props;
  const drawerRef = useRef<HTMLDivElement>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(
    entries[0]?.id ?? null,
  );

  const highlightedEntry =
    entries.find((entry) => entry.id === highlightedId) ?? entries[0];

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const drawer = drawerRef.current;
      if (
        (drawer && event.composedPath().includes(drawer)) ||
        (event.target instanceof Element &&
          event.target.closest('[data-prompt-stash-badge="true"]'))
      ) {
        return;
      }
      onClose();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () =>
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [onClose]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        isTerminalFocused() ||
        document.querySelector("dialog[open], [data-command-palette]")
      )
        return;
      const deleteShortcut =
        event.key === "Backspace" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey;
      if (
        !deleteShortcut &&
        (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
      )
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (entries.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        const currentIndex = entries.findIndex(
          (entry) => entry.id === highlightedEntry?.id,
        );
        const offset = event.key === "ArrowDown" ? 1 : -1;
        const normalizedIndex =
          currentIndex >= 0 ? currentIndex : offset === 1 ? -1 : 0;
        const nextIndex =
          (normalizedIndex + offset + entries.length) % entries.length;
        setHighlightedId(entries[nextIndex]?.id ?? null);
        const nextButton =
          drawerRef.current?.querySelectorAll<HTMLButtonElement>(
            "[data-stash-restore]",
          )[nextIndex];
        nextButton?.scrollIntoView({ block: "nearest" });
        if (drawerRef.current?.contains(document.activeElement)) {
          nextButton?.focus({ preventScroll: true });
        }
        return;
      }
      if (event.key === "Enter") {
        // A focused control inside the row (the delete button) owns its own
        // activation; swallowing Enter here would restore instead of delete.
        if (
          event.target instanceof HTMLElement &&
          event.target.closest("button[aria-label]")
        ) {
          return;
        }
        if (!highlightedEntry) return;
        event.preventDefault();
        event.stopPropagation();
        onRestore(highlightedEntry);
        return;
      }
      if (deleteShortcut) {
        if (!highlightedEntry) return;
        event.preventDefault();
        event.stopPropagation();
        onDelete(highlightedEntry);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [entries, highlightedEntry, onClose, onDelete, onRestore]);

  return (
    <ComposerBanner.Root ref={drawerRef} data-composer-stash-drawer="true">
      <ComposerBanner.ButtonRow
        aria-label="Close stash"
        aria-expanded="true"
        onPointerDown={(event) => event.preventDefault()}
        onClick={onClose}
      >
        <ComposerBanner.Icon>
          <BookmarkIcon />
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="text-muted-foreground">
          Stash
        </ComposerBanner.Content>
        <ComposerBanner.Actions>
          <ComposerBanner.Count>{entries.length}</ComposerBanner.Count>
          <ComposerBanner.ToggleIcon expanded />
        </ComposerBanner.Actions>
      </ComposerBanner.ButtonRow>
      <ComposerBanner.Scroll>
        <ul
          role="list"
          className="grid gap-px [&_[data-composer-banner-row]]:min-h-5"
          aria-label="Stashed prompts"
        >
          {entries.length === 0 ? (
            <ComposerBanner.ListRow>
              <ComposerBanner.Icon />
              <ComposerBanner.Content className="text-muted-foreground">
                Nothing stashed yet.
                {stashShortcutLabel
                  ? ` Press ${stashShortcutLabel} with a prompt in the composer to stash it.`
                  : null}
              </ComposerBanner.Content>
            </ComposerBanner.ListRow>
          ) : (
            entries.map((entry) => (
              <ComposerBanner.ListRow
                key={entry.id}
                data-stash-entry={entry.id}
                data-highlighted={
                  highlightedEntry?.id === entry.id || undefined
                }
                className={cn(
                  "relative rounded-sm",
                  highlightedEntry?.id === entry.id &&
                    "bg-accent text-accent-foreground",
                )}
                onMouseMove={() => {
                  if (highlightedId !== entry.id) setHighlightedId(entry.id);
                }}
                onFocus={() => setHighlightedId(entry.id)}
              >
                <ComposerBanner.Icon>
                  <FileTextIcon />
                </ComposerBanner.Icon>
                <ComposerBanner.Content>
                  <button
                    type="button"
                    className="min-w-0 flex-1 cursor-pointer truncate text-left text-foreground/80 outline-none before:absolute before:inset-0 before:rounded-sm focus-visible:before:ring-2 focus-visible:before:ring-ring"
                    data-stash-restore={entry.id}
                    aria-label={`Restore stashed prompt: ${stashEntrySnippet(entry)}`}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => onRestore(entry)}
                  >
                    {stashEntrySnippet(entry)}
                  </button>
                </ComposerBanner.Content>
                <ComposerBanner.Actions>
                  {entry.payload.attachments.some(
                    (attachment) => attachment.kind === "image",
                  ) ? (
                    <span className="flex shrink-0 items-center -space-x-1.5">
                      {entry.payload.attachments
                        .filter((attachment) => attachment.kind === "image")
                        .slice(0, 3)
                        .map((attachment) => (
                          <img
                            key={attachment.id}
                            src={attachmentUrl(attachment)}
                            alt=""
                            aria-hidden="true"
                            className="size-4 rounded border border-border/70 object-cover"
                          />
                        ))}
                    </span>
                  ) : null}
                  {entry.payload.attachments.some(
                    (attachment) => attachment.kind === "file",
                  ) ? (
                    <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                      <FileIcon className="size-3" aria-hidden />
                      {
                        entry.payload.attachments.filter(
                          (attachment) => attachment.kind === "file",
                        ).length
                      }
                    </span>
                  ) : null}
                  <time
                    dateTime={entry.createdAt}
                    className="shrink-0 text-muted-foreground tabular-nums max-sm:hidden"
                  >
                    {formatRelativeTimeLabel(entry.createdAt)}
                  </time>
                  <ComposerBanner.Dismiss
                    className="z-10"
                    aria-label="Delete stashed prompt"
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => onDelete(entry)}
                  />
                </ComposerBanner.Actions>
              </ComposerBanner.ListRow>
            ))
          )}
        </ul>
      </ComposerBanner.Scroll>
    </ComposerBanner.Root>
  );
});
