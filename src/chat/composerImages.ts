// Ported from T3 Code v0.0.45 apps/web/src/components/ChatView.tsx attachment recovery (MIT).
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ImageAttachment, Thread } from "../ipc";

import type { ComposerContextRecord, MessageContext } from "./composerContext";
import { importContext } from "./composerContext";

export const MAX_IMAGES = 100;

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
  context?: MessageContext,
): SendAttempt {
  const key = JSON.stringify([target, text.trim(), attachments, context]);
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

export type ComposerInput = {
  threadId: string | undefined;
  scopeKey?: string;
  activation: number;
  generation: number;
  text: string;
  images: ComposerImage[];
  records: ComposerContextRecord[];
  appliedRevertId: string | null;
};

export function activateComposer(
  threadId: string | undefined,
  activation = 0,
): ComposerInput {
  return {
    threadId,
    activation,
    generation: 0,
    text: "",
    images: [],
    records: [],
    appliedRevertId: null,
  };
}

export function acceptsCompletion(
  current: ComposerInput,
  started: Pick<ComposerInput, "activation" | "generation">,
  requireUnedited = false,
): boolean {
  return (
    current.activation === started.activation &&
    (!requireUnedited || current.generation === started.generation)
  );
}

export function finishComposerStaging(
  current: ComposerInput,
  started: Pick<ComposerInput, "activation" | "generation">,
  key: string,
  attachment: ImageAttachment,
): ComposerInput {
  if (
    !acceptsCompletion(current, started) ||
    !current.images.some(
      (image) => image.key === key && image.status === "staging",
    )
  )
    return current;
  return {
    ...current,
    images: finishStaging(current.images, key, attachment),
    generation: current.generation + 1,
  };
}

export function clearAcceptedInput(
  current: ComposerInput,
  started: Pick<ComposerInput, "activation" | "generation">,
): ComposerInput {
  return acceptsCompletion(current, started, true)
    ? {
        ...current,
        text: "",
        images: [],
        records: [],
        generation: current.generation + 1,
      }
    : current;
}

type RecoveredInput = Pick<
  NonNullable<Thread["lastRevert"]>,
  "prompt" | "attachments" | "context"
>;

export function recoveryFit(
  images: ComposerImage[],
  recovered: RecoveredInput,
  records: ComposerContextRecord[] = [],
): string | null {
  if (records.length + (recovered.context?.records.length ?? 0) > 200)
    return "Remove context chips until the restored message fits the 200-chip limit.";
  if (images.some((image) => image.status === "staging"))
    return "Wait for images to finish attaching to restore this message.";
  const ids = new Set(readyAttachments(images)?.map((image) => image.id));
  for (const image of recovered.attachments) ids.add(image.id);
  return ids.size > MAX_IMAGES
    ? "Remove images until the restored message fits the 100-image limit."
    : null;
}

export function mergeRecoveredInput(
  current: ComposerInput,
  result: NonNullable<Thread["lastRevert"]>,
): ComposerInput {
  if (
    current.appliedRevertId === result.requestId ||
    recoveryFit(current.images, result, current.records)
  )
    return current;
  const images = [...current.images];
  const ids = new Set(readyAttachments(images)?.map((image) => image.id));
  for (const attachment of result.attachments) {
    if (ids.has(attachment.id)) continue;
    ids.add(attachment.id);
    images.push({
      key: `revert:${result.requestId}:${attachment.id}`,
      name: attachment.name,
      status: "ready",
      attachment,
    });
  }
  const recovered = importContext({
    text: result.prompt,
    records: result.context?.records ?? [],
  });
  const text = !current.text
    ? recovered.text
    : !recovered.text || current.text === recovered.text
      ? current.text
      : `${current.text}\n\n${recovered.text}`;
  return {
    ...current,
    text,
    images,
    records: [...current.records, ...recovered.records],
    appliedRevertId: result.requestId,
    generation: current.generation + 1,
  };
}

export function restoreFollowUps(
  current: ComposerInput,
  inputs: {
    id: string;
    text: string;
    attachments: ImageAttachment[];
    context?: MessageContext;
  }[],
): { input: ComposerInput; error: string | null } {
  const fragments = inputs.map((input) =>
    importContext({ text: input.text, records: input.context?.records ?? [] }),
  );
  if (
    current.records.length +
      fragments.reduce((sum, fragment) => sum + fragment.records.length, 0) >
    200
  )
    return {
      input: current,
      error:
        "Remove context chips until the restored message fits the 200-chip limit.",
    };
  const recovered = {
    prompt: fragments
      .map((input) => input.text)
      .filter(Boolean)
      .join("\n\n"),
    attachments: inputs.flatMap((input) => input.attachments),
  };
  const error = recoveryFit(current.images, recovered);
  if (error) return { input: current, error };
  const images = [...current.images];
  const ids = new Set(readyAttachments(images)?.map((image) => image.id));
  for (const attachment of recovered.attachments) {
    if (ids.has(attachment.id)) continue;
    ids.add(attachment.id);
    images.push({
      key: `queue:${attachment.id}`,
      name: attachment.name,
      status: "ready",
      attachment,
    });
  }
  return {
    input: {
      ...current,
      text: [current.text, recovered.prompt].filter(Boolean).join("\n\n"),
      images,
      records: [
        ...current.records,
        ...fragments.flatMap((fragment) => fragment.records),
      ],
      generation: current.generation + 1,
    },
    error: null,
  };
}
