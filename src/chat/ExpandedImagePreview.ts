// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/chat/ExpandedImagePreview.tsx (MIT), for local attachments.
import type { Attachment } from "../ipc";
import {
  attachmentIdentity,
  attachmentMediaKind,
  attachmentUrl,
} from "./composerAttachments";

export interface ExpandedImageItem {
  src: string;
  name: string;
  type?: "video";
}

export interface ExpandedImagePreview {
  images: ExpandedImageItem[];
  index: number;
}

/** Wraps navigation in either direction, including offsets beyond a complete cycle. */
export function wrapExpandedImageIndex(
  index: number,
  imageCount: number,
): number {
  return imageCount > 0 ? ((index % imageCount) + imageCount) % imageCount : 0;
}

export function expandedImageKey(preview: ExpandedImagePreview): string {
  return `${preview.images[preview.index]?.src ?? "image"}:${preview.index}`;
}

/** A video opens alone; an image opens in a gallery of the images beside it. */
export function buildExpandedImagePreview(
  attachments: readonly Attachment[],
  selectedIdentity: string,
): ExpandedImagePreview | null {
  const selected = attachments.find(
    (attachment) => attachmentIdentity(attachment) === selectedIdentity,
  );
  if (selected && attachmentMediaKind(selected) === "video") {
    return {
      images: [
        { src: attachmentUrl(selected), name: selected.name, type: "video" },
      ],
      index: 0,
    };
  }
  const images = attachments.filter(
    (attachment) => attachmentMediaKind(attachment) === "image",
  );
  const index = images.findIndex(
    (image) => attachmentIdentity(image) === selectedIdentity,
  );
  if (index < 0) return null;
  return {
    images: images.map((image) => ({
      src: attachmentUrl(image),
      name: image.name,
    })),
    index,
  };
}
