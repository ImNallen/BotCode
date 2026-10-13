// Ported from T3 Code v0.0.45 apps/web/src/components/ChatView.tsx (compactThreadUnavailable, isCompactCommandMessage) and components/chat/ChatComposer.tsx (compactSlashCommandAvailable) (MIT).
import type { Thread } from "../ipc";
import type { ComposerTrigger } from "./composer-logic";
import { sendingBlocked } from "./followUps";

export const COMPACT_COMMAND = "/compact";

export function isCompactCommand(text: string): boolean {
  return text.trim().toLowerCase() === COMPACT_COMMAND;
}

function hasCompactableConversation(thread: Thread): boolean {
  return (
    thread.nativeThreadId !== null &&
    thread.turns.some(
      (turn) =>
        turn.kind === "prompt" &&
        turn.delivery.kind === "accepted" &&
        turn.execution.kind !== "not_started" &&
        turn.execution.kind !== "running",
    )
  );
}

/**
 * The reason the thread cannot compact now, or `null` when it can. Every L1 Code
 * thread has a project and Codex always compacts, so T3's project and provider
 * reasons never apply.
 */
export function compactDisabledReason(input: {
  thread: Thread | undefined;
  working: boolean;
  planFollowUp: boolean;
}): string | null {
  const { thread } = input;
  const available =
    thread !== undefined &&
    hasCompactableConversation(thread) &&
    !input.working &&
    !sendingBlocked(thread) &&
    !input.planFollowUp;
  return available ? null : "Compacting is unavailable right now";
}

/** `/compact` is offered only when the prompt holds nothing but the command. */
export function compactSlashCommandAvailable(input: {
  prompt: string;
  trigger: ComposerTrigger | null;
  attachmentCount: number;
  contextCount: number;
  disabledReason: string | null;
}): boolean {
  const { prompt, trigger } = input;
  return (
    trigger?.kind === "slash-command" &&
    prompt.slice(0, trigger.rangeStart).trim() === "" &&
    input.disabledReason === null &&
    prompt.slice(trigger.rangeEnd).trim() === "" &&
    input.attachmentCount === 0 &&
    input.contextCount === 0
  );
}
