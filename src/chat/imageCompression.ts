// Ported from T3 Code v0.0.45 apps/web/src/lib/imageCompression.ts (MIT).
const MAX_DIMENSION = 2048;
export const MAX_COMPRESSIBLE_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_HEIC_DECODE_PIXELS = 64_000_000;
const MAX_HEIC_METADATA_BYTES = 1024 * 1024;
const QUALITY_STEPS = [0.92, 0.85, 0.78, 0.68] as const;
const FALLBACK_SCALE_STEPS = [0.75, 0.55] as const;
const HEIC_IMAGE_MIME_TYPE = /^image\/hei(?:c|f)$/i;
const HEIC_IMAGE_EXTENSION = /\.(?:heic|heif)$/i;

type ImageSize = { width: number; height: number };

export type ImageCompressionFailureReason = "too-large" | "unreadable";

export type CompressImageFileResult =
  | { ok: true; file: File; recompressed: boolean; imageSize?: ImageSize }
  | { ok: false; reason: ImageCompressionFailureReason };

export function isHeicImageFile(file: Pick<File, "name" | "type">): boolean {
  if (HEIC_IMAGE_MIME_TYPE.test(file.type)) {
    return true;
  }
  return (
    (file.type === "" ||
      file.type.toLowerCase() === "application/octet-stream") &&
    HEIC_IMAGE_EXTENSION.test(file.name)
  );
}

interface HeicMetadataBox {
  payloadOffset: number;
  endOffset: number;
}

function findHeicMetadataBox(
  view: DataView,
  startOffset: number,
  endOffset: number,
  type: number,
): HeicMetadataBox | null {
  let offset = startOffset;
  while (offset + 8 <= endOffset) {
    let size = view.getUint32(offset);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > endOffset) return null;
      const extendedSize = view.getBigUint64(offset + 8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(extendedSize);
      headerSize = 16;
    } else if (size === 0) {
      size = endOffset - offset;
    }
    if (size < headerSize || size > endOffset - offset) return null;

    const nextOffset = offset + size;
    if (view.getUint32(offset + 4) === type) {
      return { payloadOffset: offset + headerSize, endOffset: nextOffset };
    }
    offset = nextOffset;
  }
  return null;
}

async function validateHeicImageDimensions(
  file: File,
): Promise<ImageCompressionFailureReason | null> {
  const metadata = await file.slice(0, MAX_HEIC_METADATA_BYTES).arrayBuffer();
  const view = new DataView(metadata);
  const meta = findHeicMetadataBox(view, 0, view.byteLength, 0x6d657461);
  if (!meta || meta.payloadOffset + 4 > meta.endOffset) return "unreadable";
  const properties = findHeicMetadataBox(
    view,
    meta.payloadOffset + 4,
    meta.endOffset,
    0x69707270,
  );
  if (!properties) return "unreadable";
  const containers = findHeicMetadataBox(
    view,
    properties.payloadOffset,
    properties.endOffset,
    0x6970636f,
  );
  if (!containers) return "unreadable";

  let offset = containers.payloadOffset;
  let foundImageDimensions = false;
  while (offset < containers.endOffset) {
    const image = findHeicMetadataBox(
      view,
      offset,
      containers.endOffset,
      0x69737065,
    );
    if (!image) break;
    if (image.payloadOffset + 12 > image.endOffset) return "unreadable";
    const width = view.getUint32(image.payloadOffset + 4);
    const height = view.getUint32(image.payloadOffset + 8);
    if (width === 0 || height === 0) return "unreadable";
    if (width > MAX_HEIC_DECODE_PIXELS / height) return "too-large";
    foundImageDimensions = true;
    offset = image.endOffset;
  }
  return foundImageDimensions ? null : "unreadable";
}

const BASE64_CHUNK_SIZE = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE),
    );
  }
  return btoa(binary);
}

async function blobToDataUrl(
  blob: File | Blob,
  mimeTypeOverride?: string,
): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const mimeType = mimeTypeOverride || blob.type || "application/octet-stream";
  return `data:${mimeType};base64,${bytesToBase64(new Uint8Array(buffer))}`;
}

export function dataUrlToFile(
  dataUrl: string,
  name: string,
  mimeType: string,
): File {
  const payload = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], name, { type: mimeType });
}

function fileNameForMimeType(name: string, mimeType: string): string {
  const extension = mimeType === "image/webp" ? ".webp" : ".jpg";
  const dotIndex = name.lastIndexOf(".");
  const base = dotIndex > 0 ? name.slice(0, dotIndex) : name;
  return `${base}${extension}`;
}

function canRecompress(): boolean {
  return (
    typeof createImageBitmap === "function" &&
    (typeof OffscreenCanvas === "function" || typeof document !== "undefined")
  );
}

interface Canvas2D {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
}

function createCanvas(width: number, height: number): Canvas2D | null {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) return null;
    return { canvas, context };
  }
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  return { canvas, context };
}

async function encodeCanvas(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  quality: number,
  mimeType: string,
  budgetChars: number,
): Promise<{ dataUrl: string | null; mimeType: string } | null> {
  if (
    typeof HTMLCanvasElement !== "undefined" &&
    canvas instanceof HTMLCanvasElement
  ) {
    const dataUrl = canvas.toDataURL(mimeType, quality);
    if (!dataUrl.startsWith(`data:${mimeType}`)) return null;
    return {
      dataUrl: dataUrl.length <= budgetChars ? dataUrl : null,
      mimeType,
    };
  }
  if (!(canvas instanceof OffscreenCanvas)) return null;
  const blob = await canvas.convertToBlob({ type: mimeType, quality });
  if (blob.type && blob.type !== mimeType) return null;
  const dataUrlLength =
    `data:${mimeType};base64,`.length + 4 * Math.ceil(blob.size / 3);
  if (dataUrlLength > budgetChars) return { dataUrl: null, mimeType };
  return { dataUrl: await blobToDataUrl(blob, mimeType), mimeType };
}

async function encodeWithinBudget(
  bitmap: ImageBitmap,
  maxDimension: number,
  budgetChars: number,
  preferredMimeType?: "image/jpeg",
): Promise<{ dataUrl: string; mimeType: string; imageSize: ImageSize } | null> {
  const scale = Math.min(
    1,
    maxDimension / Math.max(bitmap.width, bitmap.height),
  );
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const target = createCanvas(width, height);
  if (!target) return null;
  const mimeType =
    preferredMimeType ??
    ((await encodeCanvas(target.canvas, QUALITY_STEPS[0], "image/webp", 0))
      ? "image/webp"
      : "image/jpeg");

  if (mimeType === "image/jpeg") {
    target.context.fillStyle = "#ffffff";
    target.context.fillRect(0, 0, width, height);
  }
  target.context.drawImage(bitmap, 0, 0, width, height);

  for (const quality of QUALITY_STEPS) {
    const encoded = await encodeCanvas(
      target.canvas,
      quality,
      mimeType,
      budgetChars,
    );
    if (!encoded) break;
    if (encoded.dataUrl !== null) {
      return {
        dataUrl: encoded.dataUrl,
        mimeType: encoded.mimeType,
        imageSize: { width, height },
      };
    }
  }
  return null;
}

type ReencodeResult =
  | { ok: true; dataUrl: string; mimeType: string; imageSize: ImageSize }
  | { ok: false; reason: ImageCompressionFailureReason };

async function reencodeWithinBudget(
  file: File,
  budgetChars: number,
  preferredMimeType?: "image/jpeg",
): Promise<ReencodeResult> {
  if (!canRecompress()) {
    return { ok: false, reason: "too-large" };
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  try {
    const baseDimension = Math.min(
      MAX_DIMENSION,
      Math.max(bitmap.width, bitmap.height),
    );
    let encodeFailed = false;
    for (const dimensionScale of [1, ...FALLBACK_SCALE_STEPS]) {
      const targetDimension = Math.max(
        1,
        Math.round(baseDimension * dimensionScale),
      );
      let encoded: Awaited<ReturnType<typeof encodeWithinBudget>>;
      try {
        encoded = await encodeWithinBudget(
          bitmap,
          targetDimension,
          budgetChars,
          preferredMimeType,
        );
      } catch {
        encodeFailed = true;
        continue;
      }
      encodeFailed = false;
      if (encoded && encoded.dataUrl.length <= budgetChars) {
        return {
          ok: true,
          dataUrl: encoded.dataUrl,
          mimeType: encoded.mimeType,
          imageSize: encoded.imageSize,
        };
      }
    }
    return { ok: false, reason: encodeFailed ? "unreadable" : "too-large" };
  } finally {
    bitmap.close();
  }
}

export async function compressImageToByteLimit(
  file: File,
  maxBytes: number,
  options?: { preferredMimeType?: "image/jpeg"; sourceSizeBytes?: number },
): Promise<CompressImageFileResult> {
  if (file.size <= maxBytes) {
    return { ok: true, file, recompressed: false };
  }
  if ((options?.sourceSizeBytes ?? file.size) > MAX_COMPRESSIBLE_SOURCE_BYTES) {
    return { ok: false, reason: "too-large" };
  }
  const budgetChars = Math.floor(maxBytes / 3) * 4;
  const reencoded = await reencodeWithinBudget(
    file,
    budgetChars,
    options?.preferredMimeType,
  );
  if (!reencoded.ok) {
    return reencoded;
  }
  return {
    ok: true,
    file: dataUrlToFile(
      reencoded.dataUrl,
      fileNameForMimeType(file.name || "image", reencoded.mimeType),
      reencoded.mimeType,
    ),
    recompressed: true,
    imageSize: reencoded.imageSize,
  };
}

export async function prepareImageForAttachment(
  file: File,
  maxBytes: number,
): Promise<CompressImageFileResult> {
  if (!isHeicImageFile(file)) {
    return compressImageToByteLimit(file, maxBytes);
  }

  if (file.size > MAX_COMPRESSIBLE_SOURCE_BYTES) {
    return { ok: false, reason: "too-large" };
  }

  let converted: Blob;
  try {
    const dimensionError = await validateHeicImageDimensions(file);
    if (dimensionError) {
      return { ok: false, reason: dimensionError };
    }
    const { heicTo } = await import("heic-to/csp");
    converted = await heicTo({
      blob: file,
      type: "image/jpeg",
      quality: QUALITY_STEPS[0],
    });
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  const jpeg = new File(
    [converted],
    fileNameForMimeType(file.name || "image", "image/jpeg"),
    {
      type: "image/jpeg",
      lastModified: file.lastModified,
    },
  );
  const result = await compressImageToByteLimit(jpeg, maxBytes, {
    preferredMimeType: "image/jpeg",
    sourceSizeBytes: file.size,
  });

  return result.ok ? { ...result, recompressed: true } : result;
}
