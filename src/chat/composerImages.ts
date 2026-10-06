import { convertFileSrc } from "@tauri-apps/api/core";
import type { ImageAttachment } from "../ipc";

export type ComposerImage =
  | { key: string; name: string; status: "staging" }
  | {
      key: string;
      name: string;
      status: "ready";
      attachment: ImageAttachment;
    };

/** A staged copy of the same bytes has the same id, so the second entry folds into the first. */
export function finishStaging(
  images: ComposerImage[],
  key: string,
  attachment: ImageAttachment,
): ComposerImage[] {
  const duplicate = images.some(
    (image) =>
      image.status === "ready" && image.attachment.id === attachment.id,
  );
  return duplicate
    ? images.filter((image) => image.key !== key)
    : images.map((image) =>
        image.key === key
          ? { key, name: image.name, status: "ready", attachment }
          : image,
      );
}

/** The attachments to send, or null while any image is still staging. */
export function readyAttachments(
  images: ComposerImage[],
): ImageAttachment[] | null {
  const attachments: ImageAttachment[] = [];
  for (const image of images) {
    if (image.status === "staging") return null;
    attachments.push(image.attachment);
  }
  return attachments;
}

export type SendAttempt = { key: string; requestId: string };

/** A retry of the same message keeps its operation id, so a lost response cannot send it twice. */
export function sendAttempt(
  previous: SendAttempt | null,
  target: string,
  text: string,
  attachments: ImageAttachment[],
  mint: () => string,
): SendAttempt {
  const key = JSON.stringify([target, text.trim(), attachments]);
  return previous?.key === key ? previous : { key, requestId: mint() };
}

const extensions: Record<ImageAttachment["mimeType"], string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export const attachmentUrl = (attachment: ImageAttachment) =>
  convertFileSrc(
    `${attachment.id}.${extensions[attachment.mimeType]}`,
    "botcode-attachment",
  );
