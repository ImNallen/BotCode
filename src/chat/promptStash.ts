// Ported from T3 Code v0.0.45 apps/web/src/promptStashStore.ts and components/chat/ChatComposer.tsx (MIT).
import { z } from "zod";
import { attachmentSchema } from "../ipc";
import { serial } from "../lib/serial";
import { storage, type Storage } from "../lib/storage";
import { messageContext } from "./composerContext";
import {
  acceptsCompletion,
  readyAttachments,
  restoreFollowUps,
  type ComposerInput,
} from "./composerAttachments";
import { writeComposerDraft } from "./composerDrafts";

export const PROMPT_STASH_KEY = "prompt-stash:v1";
export const MAX_STASH_ENTRIES = 20;
const payload = messageContext.and(
  z.object({
    text: z.string(),
    attachments: z.array(attachmentSchema).max(100),
  }),
);
const entry = z.object({ id: z.string(), createdAt: z.string(), payload });
const stash = z.object({
  version: z.literal(1),
  entries: z.array(entry).max(MAX_STASH_ENTRIES),
});
export type PromptStashEntry = z.infer<typeof entry>;
export function composerHasContent(input: ComposerInput): boolean {
  return Boolean(
    input.text.trim() || input.records.length || input.attachments.length,
  );
}
export function createPromptStash(
  persistence: Storage,
  persistDraft: typeof writeComposerDraft,
) {
  const enqueue = serial();
  const captured = new Set<string>();
  const listeners = new Set<() => void>();
  let saved: string | null | undefined;
  let entries: PromptStashEntry[] = [];
  let unreadable = false;
  const snapshot = () => {
    const value = persistence.getItem(PROMPT_STASH_KEY);
    if (saved !== value) {
      saved = value;
      unreadable = false;
      try {
        entries = value ? stash.parse(JSON.parse(value)).entries : [];
      } catch {
        entries = [];
        unreadable = true;
      }
    }
    return entries;
  };
  const readEntries = () => {
    const entries = snapshot();
    if (unreadable)
      throw new Error(
        "The saved prompt stash could not be read. It has been kept unchanged.",
      );
    return entries;
  };
  const persist = async (next: PromptStashEntry[]) => {
    await persistence.setItemDurable(
      PROMPT_STASH_KEY,
      JSON.stringify({ version: 1, entries: next }),
    );
    saved = undefined;
    snapshot();
    for (const listener of listeners) listener();
  };
  return {
    snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stash: (input: ComposerInput) => {
      const attachments = readyAttachments(input.attachments);
      if (!attachments)
        return Promise.reject(
          new Error("Wait for file uploads before stashing this prompt"),
        );
      if (!composerHasContent(input)) return Promise.resolve(null);
      const capture = JSON.stringify([
        input.scopeKey,
        input.activation,
        input.generation,
      ]);
      if (captured.has(capture)) return Promise.resolve(null);
      captured.add(capture);
      return enqueue(async () => {
        try {
          const previous = readEntries();
          const created: PromptStashEntry = {
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            payload: {
              version: 1,
              text: input.text,
              records: structuredClone(input.records),
              attachments: structuredClone(attachments),
            },
          };
          await persist([created, ...previous].slice(0, MAX_STASH_ENTRIES));
          return {
            entry: created,
            evicted: previous.length === MAX_STASH_ENTRIES,
          };
        } finally {
          captured.delete(capture);
        }
      });
    },
    delete: (id: string) =>
      enqueue(() => persist(readEntries().filter((entry) => entry.id !== id))),
    restore: (
      id: string,
      input: ComposerInput,
      current: () => ComposerInput,
      publish: (input: ComposerInput) => void,
    ) =>
      enqueue(async () => {
        const source = readEntries().find((entry) => entry.id === id);
        if (
          !source ||
          !input.scopeKey ||
          !acceptsCompletion(current(), input, true)
        )
          return false;
        const merged = restoreFollowUps(input, [
          {
            id: source.id,
            text: source.payload.text,
            context: { version: 1, records: source.payload.records },
            attachments: source.payload.attachments,
          },
        ]);
        if (merged.error) throw new Error(merged.error);
        await persistDraft(input.scopeKey, merged.input, true);
        if (!acceptsCompletion(current(), input, true)) return false;
        publish(merged.input);
        try {
          await persist(readEntries().filter((entry) => entry.id !== id));
        } catch (cause) {
          throw new Error(
            `The prompt was restored. Its stash copy remains because it could not be removed. ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
        return true;
      }),
  };
}
export const promptStash = createPromptStash(storage, writeComposerDraft);
