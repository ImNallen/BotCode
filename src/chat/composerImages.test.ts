import assert from "node:assert/strict";
import { it } from "node:test";
import type { ImageAttachment } from "../ipc";
import {
  type ComposerImage,
  finishStaging,
  readyAttachments,
  sendAttempt,
} from "./composerImages";

const shot: ImageAttachment = {
  id: "0c25346db1c2a63fcc299515e33ca8fb44d8d4cdb6ad376e04aa20a8928293cb",
  mimeType: "image/png",
  name: "shot.png",
  sizeBytes: 12,
};
const clip: ImageAttachment = {
  id: "f791cfdafdc956edbeb3f12bfa69771c4a594ba3fe46f3873c39fe1aa85d407f",
  mimeType: "image/gif",
  name: "clip.gif",
  sizeBytes: 10,
};
const ids = (values: string[]) => {
  let next = 0;
  return () => values[next++] ?? "exhausted";
};

it("reuses the operation id when the same message is sent again", () => {
  const mint = ids(["first", "second"]);
  const attempt = sendAttempt(null, "thread-1", "Look", [shot], mint);
  assert.equal(attempt.requestId, "first");
  const retry = sendAttempt(attempt, "thread-1", " Look ", [shot], mint);
  assert.equal(retry.requestId, "first");
});

it("mints a new operation id when the target, text or images change", () => {
  const mint = ids(["first", "second", "third", "fourth"]);
  const attempt = sendAttempt(null, "thread-1", "Look", [shot], mint);
  assert.equal(
    sendAttempt(attempt, "thread-2", "Look", [shot], mint).requestId,
    "second",
  );
  assert.equal(
    sendAttempt(attempt, "thread-1", "Look again", [shot], mint).requestId,
    "third",
  );
  assert.equal(
    sendAttempt(attempt, "thread-1", "Look", [shot, clip], mint).requestId,
    "fourth",
  );
});

it("folds a second copy of the same image into the first", () => {
  const images: ComposerImage[] = [
    { key: "a", name: "shot.png", status: "ready", attachment: shot },
    { key: "b", name: "copy.png", status: "staging" },
    { key: "c", name: "clip.gif", status: "staging" },
  ];
  const deduped = finishStaging(images, "b", { ...shot, name: "copy.png" });
  assert.deepEqual(deduped, [images[0], images[2]]);
  assert.deepEqual(finishStaging(deduped, "c", clip), [
    images[0],
    { key: "c", name: "clip.gif", status: "ready", attachment: clip },
  ]);
});

it("holds the send until every image is staged", () => {
  assert.equal(
    readyAttachments([
      { key: "a", name: "shot.png", status: "ready", attachment: shot },
      { key: "b", name: "clip.gif", status: "staging" },
    ]),
    null,
  );
  assert.deepEqual(
    readyAttachments([
      { key: "a", name: "shot.png", status: "ready", attachment: shot },
    ]),
    [shot],
  );
  assert.deepEqual(readyAttachments([]), []);
});
