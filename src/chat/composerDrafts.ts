// Ported from T3 Code v0.0.45 apps/web/src/composerDraftStore.ts (MIT).
import { z } from "zod";
import { attachmentSchema } from "../ipc";
import { storage } from "../lib/storage";
import { messageContext } from "./composerContext";
import type { ComposerInput } from "./composerAttachments";

const draft = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]).optional(),
    records: messageContext.shape.records.default([]),
    text: z.string(),
    attachments: z
      .array(
        z.object({
          key: z.string(),
          name: z.string(),
          status: z.literal("ready"),
          attachment: attachmentSchema,
        }),
      )
      .max(100)
      .default([]),
    images: z
      .array(
        z.object({
          key: z.string(),
          name: z.string(),
          status: z.literal("ready"),
          attachment: attachmentSchema,
        }),
      )
      .max(100)
      .optional(),
    appliedRevertId: z.string().nullable().default(null),
  })
  .refine(
    (value) =>
      messageContext.safeParse({ version: 1, records: value.records }).success,
  );
export const composerDraftKey = (workspaceId: string, threadId?: string) =>
  `composer-draft:${threadId ?? `project:${workspaceId}`}`;
export function readComposerDraft(
  key: string,
): Pick<
  ComposerInput,
  "text" | "records" | "attachments" | "appliedRevertId"
> | null {
  try {
    const saved = storage.getItem(key);
    const result = saved ? draft.safeParse(JSON.parse(saved)) : null;
    return result?.success
      ? {
          text: result.data.text,
          records: result.data.records,
          attachments: result.data.attachments.length
            ? result.data.attachments
            : (result.data.images ?? []),
          appliedRevertId: result.data.appliedRevertId,
        }
      : null;
  } catch {
    return null;
  }
}
export function writeComposerDraft(
  key: string,
  input: ComposerInput,
  durable = false,
): Promise<void> {
  const attachments = input.attachments.filter(
    (image) => image.status === "ready",
  );
  return input.text ||
    input.records.length ||
    attachments.length ||
    input.appliedRevertId
    ? (durable ? storage.setItemDurable : storage.setItem)(
        key,
        JSON.stringify({
          version: 2,
          text: input.text,
          records: input.records,
          attachments,
          appliedRevertId: input.appliedRevertId,
        }),
      )
    : (durable ? storage.removeItemDurable : storage.removeItem)(key);
}
