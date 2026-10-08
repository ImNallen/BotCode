// Ported from T3 Code v0.0.45 apps/web/src/components/chat/ChatComposer.tsx attachment admission (MIT).
import type { Attachment, AttachmentSource } from "../ipc";
import {
  classifyComposerAttachmentFile,
  inferImageMimeTypeFromName,
} from "./composerAttachmentFiles";
import {
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_FILE_BYTES,
  ATTACHMENT_COUNT_ERROR,
  type ComposerInput,
} from "./composerAttachments";
import { prepareImageForAttachment } from "./imageCompression";

export {
  MAX_IMAGE_BYTES,
  MAX_FILE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  ATTACHMENT_COUNT_ERROR,
  IMAGE_TOTAL_ERROR,
} from "./composerAttachments";
export type AttachmentReservation = {
  key: string;
  file: File;
  kind: Attachment["kind"];
  source?: AttachmentSource;
};

export function reserveAttachments(
  input: ComposerInput,
  files: readonly File[],
  source?: AttachmentSource,
) {
  const reservations: AttachmentReservation[] = [];
  const errors: string[] = [];
  for (const file of files) {
    const kind = classifyComposerAttachmentFile(file);
    if (input.attachments.length + reservations.length >= MAX_ATTACHMENTS)
      errors.push(ATTACHMENT_COUNT_ERROR);
    else if (kind === "unsupported-image")
      errors.push(
        `'${file.name}' is not a supported image type. Attach GIF, HEIC, HEIF, JPEG, PNG, or WebP images.`,
      );
    else if (file.size === 0)
      errors.push(`'${file.name}' is empty or could not be read.`);
    else if (file.size > MAX_FILE_BYTES)
      errors.push(
        kind === "file"
          ? `'${file.name}' exceeds the 50 MB attachment limit.`
          : `'${file.name}' is too large to attach, even after compression.`,
      );
    else
      reservations.push({
        key: crypto.randomUUID(),
        file,
        kind,
        ...(source ? { source } : {}),
      });
  }
  return {
    input: reservations.length
      ? {
          ...input,
          attachments: [
            ...input.attachments,
            ...reservations.map(({ key, file }) => ({
              key,
              name: file.name,
              status: "staging" as const,
            })),
          ],
          generation: input.generation + 1,
        }
      : input,
    reservations,
    errors,
  };
}
export async function prepareComposerFile(
  reservation: AttachmentReservation,
): Promise<File> {
  const { file, kind } = reservation;
  if (kind === "file")
    return file.type
      ? file
      : new File([file], file.name, {
          type: "application/octet-stream",
          lastModified: file.lastModified,
        });
  const normalized =
    !file.type || file.type === "application/octet-stream"
      ? new File([file], file.name, {
          type: inferImageMimeTypeFromName(file.name) ?? file.type,
          lastModified: file.lastModified,
        })
      : file;
  const result = await prepareImageForAttachment(normalized, MAX_IMAGE_BYTES);
  if (!result.ok)
    throw new Error(
      result.reason === "unreadable"
        ? `'${file.name}' could not be read as an image.`
        : `'${file.name}' is too large to attach, even after compression.`,
    );
  return result.file;
}
export function totalImageBytes(input: ComposerInput): number {
  return input.attachments.reduce(
    (sum, slot) =>
      slot.status === "ready" &&
      (slot.attachment.kind === "image" ||
        ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
          slot.attachment.mimeType,
        ))
        ? sum + slot.attachment.sizeBytes
        : sum,
    0,
  );
}
