// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/chat/composerAttachmentFiles.test.ts (MIT): the image cases.
import assert from "node:assert/strict";
import { it } from "node:test";
import {
  classifyComposerAttachmentFile,
  inferImageMimeTypeFromName,
  shouldHandleComposerAttachmentPaste,
} from "./composerAttachmentFiles";

it("keeps supported images on the image path", () => {
  assert.equal(
    classifyComposerAttachmentFile({ name: "photo.png", type: "image/png" }),
    "image",
  );
  assert.equal(
    classifyComposerAttachmentFile({ name: "photo.webp", type: "image/webp" }),
    "image",
  );
});

it("rejects unsupported image types instead of attaching them as generic files", () => {
  assert.equal(
    classifyComposerAttachmentFile({
      name: "diagram.svg",
      type: "image/svg+xml",
    }),
    "unsupported-image",
  );
  assert.equal(
    classifyComposerAttachmentFile({ name: "photo.tiff", type: "image/tiff" }),
    "unsupported-image",
  );
  assert.equal(
    classifyComposerAttachmentFile({ name: "photo.heic", type: "image/heic" }),
    "unsupported-image",
  );
  assert.equal(
    classifyComposerAttachmentFile({
      name: "report.pdf",
      type: "application/pdf",
    }),
    "file",
  );
});

it("preserves text paste when an application adds a synthetic generic file", () => {
  const file = new File(["clipboard"], "clipboard.rtf", {
    type: "application/rtf",
  });
  assert.equal(
    shouldHandleComposerAttachmentPaste({
      files: [file],
      plainText: "Copied text",
    }),
    false,
  );
});

it("claims unsupported image pastes so the composer can report them", () => {
  const images = [
    new File(["svg"], "diagram.svg", { type: "image/svg+xml" }),
    new File(["tiff"], "photo.tiff", { type: "image/tiff" }),
  ];
  for (const image of images) {
    assert.equal(
      shouldHandleComposerAttachmentPaste({
        files: [image],
        plainText: "Image caption",
      }),
      true,
    );
  }
});

it("claims generic file-only pastes so the composer can report them", () => {
  const file = new File(["report"], "report.pdf", { type: "application/pdf" });
  assert.equal(
    shouldHandleComposerAttachmentPaste({ files: [file], plainText: "" }),
    true,
  );
});

it("ignores an empty clipboard", () => {
  assert.equal(
    shouldHandleComposerAttachmentPaste({ files: [], plainText: "" }),
    false,
  );
});

it("falls back to the extension when an image arrives without a MIME type", () => {
  assert.equal(
    classifyComposerAttachmentFile({ name: "photo.jpg", type: "" }),
    "image",
  );
  assert.equal(
    classifyComposerAttachmentFile({ name: "shot.PNG", type: "" }),
    "image",
  );
  assert.equal(
    classifyComposerAttachmentFile({ name: "archive.zip", type: "" }),
    "file",
  );
  assert.equal(
    classifyComposerAttachmentFile({ name: "no-extension", type: "" }),
    "file",
  );
  assert.equal(inferImageMimeTypeFromName("photo.jpg"), "image/jpeg");
  assert.equal(inferImageMimeTypeFromName("archive.zip"), null);
});

it("infers supported image types from octet-stream files", () => {
  const jpeg = new File(["jpeg"], "photo.jpg", {
    type: "application/octet-stream",
  });
  const png = new File(["png"], "shot.PNG", {
    type: "application/octet-stream",
  });
  assert.equal(classifyComposerAttachmentFile(jpeg), "image");
  assert.equal(classifyComposerAttachmentFile(png), "image");
});

it("does not infer images for unknown extensions or specific conflicting MIME types", () => {
  const binary = new File(["binary"], "archive.bin", {
    type: "application/octet-stream",
  });
  const unknownDocument = new File(["pdf"], "report.pdf", {
    type: "application/octet-stream",
  });
  const document = new File(["pdf"], "photo.jpg", { type: "application/pdf" });
  const explicitImage = new File(["png"], "photo.jpg", { type: "image/png" });
  assert.equal(classifyComposerAttachmentFile(binary), "file");
  assert.equal(classifyComposerAttachmentFile(unknownDocument), "file");
  assert.equal(classifyComposerAttachmentFile(document), "file");
  assert.equal(classifyComposerAttachmentFile(explicitImage), "image");
});

it("claims image pastes even when clipboard text is present", () => {
  const image = new File(["image"], "photo.png", { type: "image/png" });
  assert.equal(
    shouldHandleComposerAttachmentPaste({
      files: [image],
      plainText: "Image caption",
    }),
    true,
  );
});
