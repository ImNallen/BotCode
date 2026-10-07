import assert from "node:assert/strict";
import { it } from "node:test";
import type { ImageAttachment } from "../ipc";
import {
  type ComposerImage,
  finishStaging,
  finishComposerStaging,
  readyAttachments,
  sendAttempt,
  activateComposer,
  acceptsCompletion,
  clearAcceptedInput,
  mergeRecoveredInput,
  recoveryFit,
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

it("merges recovered text and images atomically in existing order, deduplicating hashes", () => {
  const current = {
    ...activateComposer("a"),
    text: "Unsent",
    images: [ready(shot)],
  };
  const restored = mergeRecoveredInput(current, recovery);
  assert.equal(restored.text, "Unsent\n\nRecovered");
  assert.deepEqual(readyAttachments(restored.images), [shot, clip]);
  assert.equal(restored.appliedRevertId, recovery.requestId);
  assert.equal(
    mergeRecoveredInput({ ...current, text: "Recovered" }, recovery).text,
    "Recovered",
  );
  assert.equal(
    mergeRecoveredInput(current, { ...recovery, prompt: "" }).text,
    "Unsent",
  );
});

it("defers the entire recovery while staging and retries when staging completes", () => {
  const current = {
    ...activateComposer("a"),
    text: "Unsent",
    images: [
      {
        key: "upload",
        name: "shot",
        status: "staging",
      } satisfies ComposerImage,
    ],
  };
  assert.ok((recoveryFit(current.images, recovery) ?? "").includes("Wait"));
  assert.equal(mergeRecoveredInput(current, recovery), current);
  const staged = {
    ...current,
    images: finishStaging(current.images, "upload", shot),
  };
  assert.equal(
    mergeRecoveredInput(staged, recovery).text,
    "Unsent\n\nRecovered",
  );
});

it("uses deduplicated capacity and retries the whole merge after removal", () => {
  const images = Array.from({ length: 100 }, (_, index) =>
    ready({ ...shot, id: String(index) }),
  );
  const current = { ...activateComposer("a"), text: "Keep", images };
  assert.ok((recoveryFit(images, recovery) ?? "").includes("Remove images"));
  assert.equal(mergeRecoveredInput(current, recovery), current);
  const fits = mergeRecoveredInput(
    { ...current, images: images.slice(2) },
    recovery,
  );
  assert.equal(fits.images.length, 100);
  assert.equal(fits.text, "Keep\n\nRecovered");
  const duplicate = { ...recovery, attachments: [{ ...shot, id: "0" }] };
  assert.equal(recoveryFit(images, duplicate), null);
});

it("does not replay removed input during an activation, but restores on return", () => {
  const restored = mergeRecoveredInput(activateComposer("a"), recovery);
  const removed = { ...restored, text: "", images: [] };
  assert.equal(mergeRecoveredInput(removed, recovery), removed);
  const away = activateComposer("b", restored.activation + 1);
  const returned = activateComposer("a", away.activation + 1);
  assert.deepEqual(
    readyAttachments(mergeRecoveredInput(returned, recovery).images),
    [shot, clip],
  );
  assert.equal(acceptsCompletion(returned, restored), false);
  assert.equal(clearAcceptedInput(returned, restored), returned);
});

it("accepted sends preserve in-flight edits and keep recovery applied until its snapshot disappears", () => {
  const started = mergeRecoveredInput(activateComposer("a"), recovery);
  const edited = {
    ...started,
    text: "New edit",
    generation: started.generation + 1,
  };
  assert.equal(clearAcceptedInput(edited, started), edited);
  const cleared = clearAcceptedInput(started, started);
  assert.equal(cleared.text, "");
  assert.deepEqual(cleared.images, []);
  assert.equal(mergeRecoveredInput(cleared, recovery), cleared);
  assert.equal(acceptsCompletion(edited, started), true);
  assert.equal(acceptsCompletion(edited, started, true), false);
  assert.equal(clearAcceptedInput(edited, edited).text, "");
});

const ready = (attachment: ImageAttachment): ComposerImage => ({
  key: attachment.id,
  name: attachment.name,
  status: "ready",
  attachment,
});
const recovery = {
  requestId: "revert-1",
  turnId: "turn",
  turnCount: 0,
  prompt: "Recovered",
  attachments: [shot, clip],
};

it("rejects stale stage replies after A to B to A and after removing an upload", () => {
  const started = {
    ...activateComposer("a"),
    images: [
      { key: "stage", name: "shot", status: "staging" } satisfies ComposerImage,
    ],
  };
  const returned = activateComposer(
    "a",
    activateComposer("b", 1).activation + 1,
  );
  assert.equal(
    finishComposerStaging(returned, started, "stage", shot),
    returned,
  );
  const removed = { ...started, images: [], generation: 1 };
  assert.equal(finishComposerStaging(removed, started, "stage", shot), removed);
  const edited = { ...started, text: "Typed while uploading", generation: 1 };
  const finished = finishComposerStaging(edited, started, "stage", shot);
  assert.equal(finished.text, edited.text);
  assert.deepEqual(readyAttachments(finished.images), [shot]);
});
