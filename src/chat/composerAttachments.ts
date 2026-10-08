// Ported from T3 Code v0.0.45 apps/web/src/components/ChatView.tsx attachment recovery (MIT).
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Attachment, ImageAttachment, Thread } from "../ipc";

import type { ComposerContextRecord, MessageContext } from "./composerContext";
import { importContext } from "./composerContext";

export const MAX_ATTACHMENTS = 100;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 80 * 1024 * 1024;
export const ATTACHMENT_COUNT_ERROR =
  "You can attach up to 100 files per message.";
export const IMAGE_TOTAL_ERROR =
  "Images can total up to 80 MiB per message or question response. Use smaller images or send fewer at once.";

export type ComposerAttachment =
  | { key: string; name: string; status: "staging" }
  | {
      key: string;
      name: string;
      status: "ready";
      attachment: Attachment;
    };

export function attachmentIdentity(attachment: Attachment): string {
  return attachment.kind === "image"
    ? `image:${attachment.id}`
    : JSON.stringify([
        attachment.kind,
        attachment.id,
        attachment.extension,
        attachment.source,
        attachment.name,
      ]);
}
export function finishStaging(
  attachments: ComposerAttachment[],
  key: string,
  attachment: Attachment,
): ComposerAttachment[] {
  return attachments.some(
    (slot) =>
      slot.status === "ready" &&
      attachmentIdentity(slot.attachment) === attachmentIdentity(attachment),
  )
    ? attachments.filter((slot) => slot.key !== key)
    : attachments.map((slot) =>
        slot.key === key
          ? { key, name: attachment.name, status: "ready", attachment }
          : slot,
      );
}
/** The attachments to send, or null while any image is still staging. */
export function readyAttachments(
  slots: ComposerAttachment[],
): Attachment[] | null {
  const attachments: Attachment[] = [];
  for (const image of slots) {
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
  attachments: Attachment[],
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

export const attachmentUrl = (attachment: Attachment) =>
  convertFileSrc(
    `${attachment.id}.${attachment.kind === "image" ? extensions[attachment.mimeType] : attachment.extension}`,
    "botcode-attachment",
  );

export type ComposerInput = {
  threadId: string | undefined;
  scopeKey?: string;
  activation: number;
  generation: number;
  text: string;
  attachments: ComposerAttachment[];
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
    attachments: [],
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
  attachment: Attachment,
): ComposerInput {
  if (
    !acceptsCompletion(current, started) ||
    !current.attachments.some(
      (image) => image.key === key && image.status === "staging",
    )
  )
    return current;
  return {
    ...current,
    attachments: finishStaging(current.attachments, key, attachment),
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
        attachments: [],
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
  attachments: ComposerAttachment[],
  recovered: RecoveredInput,
  records: ComposerContextRecord[] = [],
): string | null {
  if (records.length + (recovered.context?.records.length ?? 0) > 200)
    return "Remove context chips until the restored message fits the 200-chip limit.";
  if (attachments.some((image) => image.status === "staging"))
    return "Wait for files to finish attaching to restore this message.";
  const all = new Map(
    [...(readyAttachments(attachments) ?? []), ...recovered.attachments].map(
      (attachment) => [attachmentIdentity(attachment), attachment],
    ),
  );
  if (all.size > MAX_ATTACHMENTS)
    return "Remove files until the restored message fits the 100-file limit.";
  const imageBytes = [...all.values()].reduce(
    (sum, attachment) =>
      attachment.kind === "image" ||
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
        attachment.mimeType,
      )
        ? sum + attachment.sizeBytes
        : sum,
    0,
  );
  return imageBytes > MAX_TOTAL_IMAGE_BYTES ? IMAGE_TOTAL_ERROR : null;
}

export function mergeRecoveredInput(
  current: ComposerInput,
  result: NonNullable<Thread["lastRevert"]>,
): ComposerInput {
  if (
    current.appliedRevertId === result.requestId ||
    recoveryFit(current.attachments, result, current.records)
  )
    return current;
  const attachments = [...current.attachments];
  const ids = new Set(readyAttachments(attachments)?.map(attachmentIdentity));
  for (const attachment of result.attachments) {
    if (ids.has(attachmentIdentity(attachment))) continue;
    ids.add(attachmentIdentity(attachment));
    attachments.push({
      key: `revert:${result.requestId}:${attachmentIdentity(attachment)}`,
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
    attachments,
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
    attachments: Attachment[];
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
  const error = recoveryFit(current.attachments, recovered);
  if (error) return { input: current, error };
  const attachments = [...current.attachments];
  const ids = new Set(readyAttachments(attachments)?.map(attachmentIdentity));
  for (const attachment of recovered.attachments) {
    if (ids.has(attachmentIdentity(attachment))) continue;
    ids.add(attachmentIdentity(attachment));
    attachments.push({
      key: `queue:${attachmentIdentity(attachment)}`,
      name: attachment.name,
      status: "ready",
      attachment,
    });
  }
  return {
    input: {
      ...current,
      text: [current.text, recovered.prompt].filter(Boolean).join("\n\n"),
      attachments,
      records: [
        ...current.records,
        ...fragments.flatMap((fragment) => fragment.records),
      ],
      generation: current.generation + 1,
    },
    error: null,
  };
}
