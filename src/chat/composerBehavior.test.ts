// Ported from T3 Code v0.0.45 composerPromptHistory.test.ts, textPaste.test.ts and sidebarPendingFileDropStore.test.ts (MIT).
import assert from "node:assert/strict";
import { it } from "node:test";
import {
  buildComposerPromptHistoryEntries,
  stepComposerPromptHistory,
  recallableComposerPrompt,
} from "./composerPromptHistory";
import {
  isPasteAsTextShortcut,
  nextPastedTextFileName,
  pastedTextDisposition,
  replaceTextSelection,
} from "./textPaste";
import { createSidebarPendingFileDrops } from "./sidebarPendingFileDrops";
import {
  activateComposer,
  finishComposerStaging,
  readyAttachments,
} from "./composerAttachments";
import {
  reserveAttachments,
  prepareComposerFile,
  MAX_FILE_BYTES,
} from "./composerAttachmentIngestion";

it("recalls text-only sent prompts, collapses consecutive duplicates, and clears past the newest", () => {
  const entries = buildComposerPromptHistoryEntries([
    { id: "assistant", role: "assistant", text: "Do not recall" },
    { id: "empty", role: "user", text: "" },
    {
      id: "a",
      role: "user",
      text: "First [Terminal](t3-context://v1/terminal/ctx_terminal)",
    },
    { id: "b", role: "user", text: "Last\nwrapped paragraph" },
    { id: "c", role: "user", text: "Last\nwrapped paragraph" },
  ]);
  assert.deepEqual(entries, [
    { id: "a", prompt: "First" },
    { id: "c", prompt: "Last\nwrapped paragraph" },
  ]);
  const newest = stepComposerPromptHistory({
    direction: "backward",
    entries,
    position: null,
    currentPrompt: "",
  });
  assert.ok(newest);
  assert.equal(newest.prompt, "Last\nwrapped paragraph");
  const oldest = stepComposerPromptHistory({
    direction: "backward",
    entries,
    position: newest.position,
    currentPrompt: newest.prompt,
  });
  assert.equal(oldest?.prompt, "First");
  assert.deepEqual(
    stepComposerPromptHistory({
      direction: "forward",
      entries,
      position: newest.position,
      currentPrompt: newest.prompt,
    }),
    { position: null, prompt: "" },
  );
  assert.equal(
    stepComposerPromptHistory({
      direction: "backward",
      entries,
      position: newest.position,
      currentPrompt: "edited recall",
    }),
    null,
  );
  assert.equal(
    recallableComposerPrompt(
      "Review\n\n<review_comment>appended</review_comment>",
    ),
    "Review",
  );
});
it("folds at exactly 32 KiB UTF-8 and preserves an explicit editable paste", () => {
  assert.equal(
    pastedTextDisposition({ text: "a".repeat(32767), canAttach: true }),
    "inline",
  );
  assert.equal(
    pastedTextDisposition({ text: "a".repeat(32768), canAttach: true }),
    "attachment",
  );
  assert.equal(
    pastedTextDisposition({ text: "å".repeat(16384), canAttach: true }),
    "attachment",
  );
  assert.equal(
    pastedTextDisposition({
      text: "small",
      canAttach: true,
      wouldExceedInputLimit: true,
    }),
    "attachment",
  );
  assert.equal(
    pastedTextDisposition({
      text: "a".repeat(32768),
      canAttach: true,
      bypassAutoAttachment: true,
    }),
    "inline",
  );
  assert.equal(
    pastedTextDisposition({ text: "a".repeat(32768), canAttach: false }),
    "inline",
  );
  assert.deepEqual(
    replaceTextSelection({
      value: "keep selected tail",
      selection: { start: 5, end: 13 },
      text: "[file](t3-context://v1/file/ctx_file)",
    }),
    { value: "keep [file](t3-context://v1/file/ctx_file) tail", cursor: 42 },
  );
  assert.equal(
    nextPastedTextFileName(["PASTED-TEXT.TXT", "pasted-text-2.txt"]),
    "pasted-text-3.txt",
  );
  const key = {
    key: "V",
    shiftKey: true,
    metaKey: true,
    ctrlKey: false,
    altKey: false,
  };
  assert.equal(isPasteAsTextShortcut(key, true), true);
  assert.equal(isPasteAsTextShortcut({ ...key, ctrlKey: true }, true), false);
  assert.equal(
    isPasteAsTextShortcut({ ...key, metaKey: false, ctrlKey: true }, false),
    true,
  );
  assert.equal(isPasteAsTextShortcut({ ...key, altKey: true }, true), false);
});
it("reserves mixed attachment capacity across racing batches and retains separately named files", async () => {
  const firstFiles = Array.from(
    { length: 99 },
    (_, n) => new File(["same bytes"], `file-${n}.txt`, { type: "text/plain" }),
  );
  const first = reserveAttachments(activateComposer("a", 1), firstFiles);
  const second = reserveAttachments(first.input, [
    new File(["pdf"], "report.pdf"),
    new File(["another"], "other.txt"),
  ]);
  assert.equal(second.reservations.length, 1);
  assert.deepEqual(second.errors, [
    "You can attach up to 100 files per message.",
  ]);
  assert.equal(readyAttachments(second.input.attachments), null);
  const staged = {
    kind: "file",
    id: "a".repeat(64),
    name: "file-0.txt",
    mimeType: "text/plain",
    sizeBytes: 10,
    extension: "txt",
  } as const;
  const a = finishComposerStaging(
    second.input,
    first.input,
    first.reservations[0]?.key ?? "missing",
    staged,
  );
  const b = finishComposerStaging(
    a,
    first.input,
    first.reservations[1]?.key ?? "missing",
    { ...staged, name: "file-1.txt" },
  );
  assert.equal(
    b.attachments.filter((slot) => slot.status === "ready").length,
    2,
  );
  const switched = activateComposer("b", 2);
  assert.equal(
    finishComposerStaging(
      switched,
      first.input,
      first.reservations[2]?.key ?? "missing",
      staged,
    ),
    switched,
  );
  assert.equal(
    (
      await prepareComposerFile({
        key: "file",
        file: new File(["pdf bytes"], "file.pdf"),
        kind: "file",
      })
    ).type,
    "application/octet-stream",
  );
});
it("enforces T3 empty, generic size, and unsupported-image errors without discarding a valid mixed file", () => {
  const admission = reserveAttachments(activateComposer("a"), [
    new File([], "empty.txt"),
    new File([new Uint8Array(MAX_FILE_BYTES + 1)], "large.pdf"),
    new File(["svg"], "diagram.svg", { type: "image/svg+xml" }),
    new File(["ok"], "good.pdf"),
  ]);
  assert.deepEqual(admission.errors, [
    "'empty.txt' is empty or could not be read.",
    "'large.pdf' exceeds the 50 MB attachment limit.",
    "'diagram.svg' is not a supported image type. Attach GIF, HEIC, HEIF, JPEG, PNG, or WebP images.",
  ]);
  assert.deepEqual(
    admission.reservations.map((reservation) => reservation.file.name),
    ["good.pdf"],
  );
});
it("targets queued sidebar drops exactly and removes only the failed navigation's drop", () => {
  const queue = createSidebarPendingFileDrops();
  const a = new File(["a"], "a.txt");
  const b = new File(["b"], "b.txt");
  const failed = queue.queue("thread-a", [a]);
  queue.queue("thread-b", [b]);
  queue.queue("thread-a", [b]);
  queue.remove(failed);
  assert.deepEqual(queue.consume("thread-b"), [b]);
  assert.deepEqual(queue.consume("thread-a"), [b]);
  assert.deepEqual(queue.consume("thread-a"), []);
  queue.queue("thread-a", [a]);
  queue.queue("thread-a", [b]);
  assert.deepEqual(queue.consume("thread-a"), [a, b]);
});
