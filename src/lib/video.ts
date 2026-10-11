// Ported from pingdotgg/t3code v0.0.45 packages/shared/src/video.ts and image.ts GENERIC_MIME_TYPES (MIT).
const GENERIC_MIME_TYPES = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  "application/unknown",
]);

const VIDEO_MIME_TYPE_BY_EXTENSION = new Map([
  ["avi", "video/x-msvideo"],
  ["m4v", "video/mp4"],
  ["mkv", "video/x-matroska"],
  ["mov", "video/quicktime"],
  ["mp4", "video/mp4"],
  ["ogv", "video/ogg"],
  ["webm", "video/webm"],
]);

export function isVideoExtension(extension: string): boolean {
  return VIDEO_MIME_TYPE_BY_EXTENSION.has(extension);
}

/** Recognizes videos even when the file picker omitted their MIME type. */
export function videoMimeType(attachment: {
  readonly name: string;
  readonly mimeType: string;
}): string | null {
  const mimeType =
    attachment.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mimeType.startsWith("video/")) return mimeType;
  // A definite type already answers the question, and a `.mp4` on a PDF must not override it.
  if (mimeType !== "" && !GENERIC_MIME_TYPES.has(mimeType)) return null;
  const dotIndex = attachment.name.lastIndexOf(".");
  return dotIndex < 0
    ? null
    : (VIDEO_MIME_TYPE_BY_EXTENSION.get(
        attachment.name.slice(dotIndex + 1).toLowerCase(),
      ) ?? null);
}
