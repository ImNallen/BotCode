// Copied from pingdotgg/t3code v0.0.45 apps/web/src/components/pullRequest/PullRequestMarkdownEditor.tsx (MIT).
import { useState } from "react";
import { ChatMarkdown } from "../chat/ChatMarkdown";
import { cn } from "../lib/cn";
import { Button, Toggle } from "../ui/controls";
import { Textarea } from "../ui/textarea";
import { SegmentedGroup } from "./chrome";

export function PullRequestMarkdownEditor({
  value,
  placeholder,
  label,
  saving,
  disabled = false,
  allowEmpty = false,
  className,
  onSave,
  onCancel,
}: {
  readonly value: string;
  readonly placeholder?: string | undefined;
  readonly label: string;
  readonly saving: boolean;
  /** Blocks saving without claiming a save is running. */
  readonly disabled?: boolean;
  /** A description may be cleared, which is how one is removed. */
  readonly allowEmpty?: boolean;
  readonly className?: string | undefined;
  readonly onSave: (next: string) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [preview, setPreview] = useState(false);
  // React keeps this instance when the same position comes round again, so
  // new words mean a new subject and the draft starts again from them.
  const [seed, setSeed] = useState(value);
  if (seed !== value) {
    setSeed(value);
    setDraft(value);
  }
  const empty = draft.trim().length === 0;
  const saveDisabled = saving || disabled || (empty && !allowEmpty);

  return (
    <div
      className={cn("space-y-2", className)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (
          event.key === "Enter" &&
          (event.metaKey || event.ctrlKey) &&
          !event.shiftKey &&
          !event.altKey
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (!saveDisabled && !event.repeat) onSave(draft);
          return;
        }
        if (event.key !== "Escape" || saving) return;
        event.preventDefault();
        onCancel();
      }}
    >
      <SegmentedGroup label="Markdown editor mode">
        <Toggle
          size="segmented"
          variant="segmented"
          disabled={saving}
          pressed={!preview}
          onClick={() => setPreview(false)}
        >
          Write
        </Toggle>
        <Toggle
          size="segmented"
          variant="segmented"
          disabled={saving}
          pressed={preview}
          onClick={() => setPreview(true)}
        >
          Preview
        </Toggle>
      </SegmentedGroup>
      {preview ? (
        <div className="rounded-lg border border-border/60 px-3 py-2">
          {empty ? (
            <p className="text-xs text-muted-foreground">Nothing to preview.</p>
          ) : (
            <ChatMarkdown text={draft} />
          )}
        </div>
      ) : (
        <Textarea
          autoFocus
          disabled={saving}
          value={draft}
          rows={6}
          placeholder={placeholder}
          aria-label={label}
          onChange={(event) => setDraft(event.target.value)}
        />
      )}
      <div className="flex justify-end gap-2">
        <Button size="xs" variant="ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={saveDisabled}
          onClick={() => onSave(draft)}
        >
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
