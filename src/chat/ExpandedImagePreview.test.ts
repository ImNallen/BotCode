import assert from "node:assert/strict";
import { it } from "node:test";
import type { Attachment } from "../ipc";
import { attachmentIdentity, attachmentMediaKind } from "./composerAttachments";
import {
  buildExpandedImagePreview,
  expandedImageKey,
  wrapExpandedImageIndex,
} from "./ExpandedImagePreview";

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    __TAURI_INTERNALS__: {
      convertFileSrc: (path: string, protocol: string) =>
        `${protocol}://localhost/${path}`,
    },
  },
});

const hash = (digit: string) => digit.repeat(64);
const image = (digit: string, name: string): Attachment => ({
  kind: "image",
  id: hash(digit),
  mimeType: "image/png",
  name,
  sizeBytes: 12,
});
const file = (
  digit: string,
  name: string,
  mimeType: string,
  extension: string,
): Attachment => ({
  kind: "file",
  id: hash(digit),
  mimeType,
  name,
  sizeBytes: 12,
  extension,
});

const first = image("a", "first.png");
const second = image("b", "second.png");
const notes = file("c", "notes.txt", "text/plain", "txt");
const clip = file("d", "Clip.MOV", "", "mov");

it("opens the clicked image inside a gallery of every image", () => {
  assert.deepEqual(
    buildExpandedImagePreview(
      [first, notes, clip, second],
      attachmentIdentity(second),
    ),
    {
      images: [
        {
          src: `l1code-attachment://localhost/${hash("a")}.png`,
          name: "first.png",
        },
        {
          src: `l1code-attachment://localhost/${hash("b")}.png`,
          name: "second.png",
        },
      ],
      index: 1,
    },
  );
});

it("opens a video alone, without the images beside it", () => {
  const preview = buildExpandedImagePreview(
    [first, clip, second],
    attachmentIdentity(clip),
  );
  assert.deepEqual(preview, {
    images: [
      {
        src: `l1code-attachment://localhost/${hash("d")}.mov`,
        name: "Clip.MOV",
        type: "video",
      },
    ],
    index: 0,
  });
  assert.equal(
    expandedImageKey(preview!),
    `l1code-attachment://localhost/${hash("d")}.mov:0`,
  );
});

it("opens nothing for a file that is neither image nor video", () => {
  assert.equal(
    buildExpandedImagePreview([first, notes], attachmentIdentity(notes)),
    null,
  );
});

it("wraps gallery navigation in both directions", () => {
  assert.equal(wrapExpandedImageIndex(-1, 3), 2);
  assert.equal(wrapExpandedImageIndex(3, 3), 0);
  assert.equal(wrapExpandedImageIndex(-7, 3), 2);
  assert.equal(wrapExpandedImageIndex(8, 3), 2);
  assert.equal(wrapExpandedImageIndex(4, 0), 0);
});

it("classifies media with T3's video table", () => {
  const kinds = [
    first,
    file("1", "clip.mp4", "video/mp4", "mp4"),
    file("2", "clip.MOV", "application/octet-stream", "mov"),
    file("3", "clip.webm", "", "webm"),
    file("4", "clip.mkv", "binary/octet-stream", "mkv"),
    file("5", "screen", "video/quicktime", "bin"),
    file("6", "report.mp4", "application/pdf", "mp4"),
    file("7", "clip.flv", "", "flv"),
    file("8", "clip.3gp", "video/3gpp", "3gp"),
    notes,
  ].map(attachmentMediaKind);
  assert.deepEqual(kinds, [
    "image",
    "video",
    "video",
    "video",
    "video",
    null,
    null,
    null,
    null,
    null,
  ]);
});
