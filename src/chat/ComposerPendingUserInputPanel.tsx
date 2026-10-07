// Ported from T3 Code v0.0.45 apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx and ComposerPrimaryActions.tsx (MIT).
import { CheckIcon } from "lucide-react";
import { useState } from "react";
import type { UserQuestionRequest, UserQuestionAnswers } from "../ipc";
import { cn } from "../lib/cn";
import { Button } from "../ui/controls";
import { ComposerBanner } from "./ComposerBanner";

export function ComposerPendingUserInputPanel({
  request,
  busy,
  onAnswer,
}: {
  request: UserQuestionRequest;
  busy: boolean;
  onAnswer: (answers: UserQuestionAnswers) => void;
}) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const question = request.questions[index];
  if (!question) return null;
  const selected = answers[question.id] ?? "";
  const complete = request.questions.every((question) =>
    answers[question.id]?.trim(),
  );
  const next = () => {
    if (!selected.trim() || busy) return;
    if (index < request.questions.length - 1) setIndex(index + 1);
    else if (complete)
      onAnswer(
        Object.fromEntries(
          request.questions.map((question) => [
            question.id,
            { answers: [answers[question.id] ?? ""] },
          ]),
        ),
      );
  };
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root
        density="spacious"
        data-chat-composer-top-drawer="true"
      >
        <ComposerBanner.Row>
          <ComposerBanner.Content>
            <span className="shrink-0 font-medium text-muted-foreground">
              {question.header}
            </span>
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <span className="text-3xs font-medium text-muted-foreground tabular-nums">
              {index + 1}/{request.questions.length}
            </span>
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        <div className="min-w-0 ps-8 sm:ps-7 pe-1 pb-1 wrap-anywhere max-h-[min(24rem,40dvh)] overflow-y-auto">
          <p className="text-sm text-foreground/85">{question.question}</p>
          <div className="mt-2 space-y-0.5">
            {question.options?.map((option) => (
              <button
                key={option.label}
                type="button"
                disabled={busy}
                onClick={() =>
                  setAnswers((current) => ({
                    ...current,
                    [question.id]: option.label,
                  }))
                }
                className={cn(
                  "group flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-primary/25",
                  selected === option.label
                    ? "bg-muted/55 text-foreground"
                    : "bg-transparent text-foreground/85 hover:bg-muted/30",
                  busy ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
                )}
              >
                <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{option.label}</span>
                  <span className="text-secondary-label text-2xs">
                    {option.description}
                  </span>
                </div>
                {selected === option.label ? (
                  <CheckIcon className="size-3.5 shrink-0 text-primary" />
                ) : null}
              </button>
            ))}
          </div>
          {question.isOther || !question.options?.length ? (
            <input
              key={question.id}
              type={question.isSecret ? "password" : "text"}
              aria-label={`Answer ${question.header}`}
              autoComplete="off"
              disabled={busy}
              placeholder="Type your answer..."
              value={
                question.options?.some((option) => option.label === selected)
                  ? ""
                  : selected
              }
              onChange={(event) =>
                setAnswers((current) => ({
                  ...current,
                  [question.id]: event.target.value,
                }))
              }
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  next();
                }
              }}
              className="mt-2 w-full rounded-md border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          ) : null}
          <div className="mt-3 flex justify-end gap-2">
            {index > 0 ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setIndex(index - 1)}
              >
                Previous
              </Button>
            ) : null}
            <Button
              size="sm"
              disabled={
                busy ||
                !selected.trim() ||
                (index === request.questions.length - 1 && !complete)
              }
              onClick={next}
            >
              {busy
                ? "Submitting..."
                : index === request.questions.length - 1
                  ? "Submit answers"
                  : "Next question"}
            </Button>
          </div>
        </div>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
