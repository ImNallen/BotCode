// Ported from T3 Code v0.0.45 apps/web/src/components/diffs/DiffCommentAnnotation.tsx (MIT).
import { MessageCircleIcon, Trash2Icon } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { Button } from "../ui/controls";
import { Textarea } from "../ui/textarea";
import { isCommentSubmitShortcut } from "./commentSubmitShortcut";

type DiffCommentAnnotationProps =
  | {
      kind: "draft";
      rangeLabel: string;
      text: string;
      onTextChange: (text: string) => void;
      onCancel: () => void;
      onComment: (text: string) => void;
      pending: boolean;
    }
  | {
      kind: "comment";
      text: string;
      onDelete?: () => void;
    };

export function DiffCommentAnnotation(props: DiffCommentAnnotationProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    if (props.kind !== "draft") return;
    const frame = window.requestAnimationFrame(() => {
      textareaRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [props.kind]);

  if (props.kind === "comment") {
    return (
      <div
        data-diff-comment-annotation
        className="group/comment flex min-w-0 items-start gap-2.5 border-s-2 border-primary/55 bg-primary/[0.045] px-3 py-2.5 font-sans text-foreground"
        contentEditable={false}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <MessageCircleIcon
          className="mt-0.5 size-3.5 shrink-0 text-primary/70"
          aria-hidden="true"
        />
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-5">
          {props.text}
        </p>
        {props.onDelete ? (
          <span className="-my-1 -mr-1 flex shrink-0 opacity-0 transition-opacity group-hover/comment:opacity-100 focus-within:opacity-100 max-sm:opacity-100">
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label="Delete comment"
              onClick={props.onDelete}
            >
              <Trash2Icon className="size-3" />
            </Button>
          </span>
        ) : null}
      </div>
    );
  }

  const { rangeLabel, text, onTextChange, onCancel, onComment, pending } =
    props;
  const trimmedText = text.trim();
  return (
    <div
      data-diff-comment-annotation
      className="px-3 py-2 font-sans text-foreground"
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Textarea
        ref={textareaRef}
        autoFocus
        size="sm"
        value={text}
        placeholder="Add a comment…"
        aria-label={`Comment on lines ${rangeLabel}`}
        onChange={(event) => onTextChange(event.target.value)}
        onFocus={(event) => {
          const end = event.currentTarget.value.length;
          event.currentTarget.setSelectionRange(end, end);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
          if (isCommentSubmitShortcut(event, trimmedText, pending)) {
            event.preventDefault();
            onComment(trimmedText);
          }
        }}
      />
      <div className="mt-1.5 flex items-center gap-1">
        <span className="mr-auto text-3xs text-muted-foreground/70">
          ⌘/Ctrl Enter to send
        </span>
        <Button variant="ghost-muted" size="xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="xs"
          disabled={pending || !trimmedText}
          onClick={() => onComment(trimmedText)}
        >
          Comment
        </Button>
      </div>
    </div>
  );
}
