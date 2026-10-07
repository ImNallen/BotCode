// Ported from T3 Code v0.0.45 apps/web/src/composerDraftStore.ts (MIT).
import { z } from "zod";
import { imageAttachment } from "../ipc";
import { storage } from "../lib/storage";
import { messageContext } from "./composerContext";
import type { ComposerInput } from "./composerImages";

const draft = messageContext.and(
  z.object({
    text: z.string(),
    images: z
      .array(
        z.object({
          key: z.string(),
          name: z.string(),
          status: z.literal("ready"),
          attachment: imageAttachment,
        }),
      )
      .max(100)
      .default([]),
    appliedRevertId: z.string().nullable().default(null),
  }),
);
export const composerDraftKey = (workspaceId: string, threadId?: string) =>
  `composer-draft:${threadId ?? `project:${workspaceId}`}`;
export function readComposerDraft(
  key: string,
): Pick<
  ComposerInput,
  "text" | "records" | "images" | "appliedRevertId"
> | null {
  try {
    const saved = storage.getItem(key);
    const result = saved ? draft.safeParse(JSON.parse(saved)) : null;
    return result?.success ? result.data : null;
  } catch {
    return null;
  }
}
export function writeComposerDraft(
  key: string,
  input: ComposerInput,
): Promise<void> {
  const images = input.images.filter((image) => image.status === "ready");
  return input.text ||
    input.records.length ||
    images.length ||
    input.appliedRevertId
    ? storage.setItem(
        key,
        JSON.stringify({
          version: 1,
          text: input.text,
          records: input.records,
          images,
          appliedRevertId: input.appliedRevertId,
        }),
      )
    : storage.removeItem(key);
}
