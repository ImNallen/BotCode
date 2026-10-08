// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/chat/composerAttachmentFiles.ts (MIT).
type ComposerAttachmentFileKind = "image" | "file" | "unsupported-image";

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/heic",
  "image/heif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const IMAGE_MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  heic: "image/heic",
  heif: "image/heif",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/**
 * Some sources (drags from other apps, files piped through a shell) hand over
 * a `File` with an empty or generic MIME type. Maps the extension to a
 * supported image type so a plain `photo.jpg` still lands on the image path;
 * anything unrecognized stays a generic file.
 */
export function inferImageMimeTypeFromName(name: string): string | null {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) {
    return null;
  }
  return (
    IMAGE_MIME_TYPE_BY_EXTENSION[name.slice(dotIndex + 1).toLowerCase()] ?? null
  );
}

function inferImageMimeTypeForUnknownFile(
  file: Pick<File, "name" | "type">,
): string | null {
  const mimeType = file.type.toLowerCase();
  if (mimeType !== "" && mimeType !== "application/octet-stream") {
    return null;
  }
  return inferImageMimeTypeFromName(file.name);
}

export function classifyComposerAttachmentFile(
  file: Pick<File, "name" | "type">,
): ComposerAttachmentFileKind {
  if (inferImageMimeTypeForUnknownFile(file)) {
    return "image";
  }
  if (!file.type.toLowerCase().startsWith("image/")) {
    return "file";
  }
  return SUPPORTED_IMAGE_MIME_TYPES.has(file.type.toLowerCase())
    ? "image"
    : "unsupported-image";
}

/**
 * Whether a paste's files should be claimed as composer attachments instead of
 * falling through to the default text paste.
 */
export function shouldHandleComposerAttachmentPaste(input: {
  readonly files: ReadonlyArray<File>;
  readonly plainText: string;
}): boolean {
  if (
    input.files.some((file) => {
      const classification = classifyComposerAttachmentFile(file);
      return (
        classification === "image" || classification === "unsupported-image"
      );
    })
  ) {
    return true;
  }

  if (input.plainText.length > 0) {
    return false;
  }

  return input.files.some(
    (file) => classifyComposerAttachmentFile(file) === "file",
  );
}
