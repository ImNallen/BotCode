// Ported from T3 Code v0.0.45 apps/web/src/promptStashStore.test.ts (MIT).
import assert from "node:assert/strict";
import { it } from "node:test";
import { persistentStorage } from "../lib/storage";
import {
  activateComposer,
  clearAcceptedInput,
  readyAttachments,
  type ComposerInput,
} from "./composerAttachments";
import {
  contextReference,
  contextReferences,
  type ComposerContextRecord,
} from "./composerContext";
import { buildComposerDocument } from "./composerDocument";
import { createPromptStash, PROMPT_STASH_KEY } from "./promptStash";

const id = "a".repeat(64);
const file = {
  kind: "file",
  id,
  name: "pasted-text.txt",
  extension: "txt",
  mimeType: "text/plain;charset=utf-8",
  sizeBytes: 32768,
  source: { _tag: "pasted-text" },
} as const;
const image = {
  kind: "image",
  id: "b".repeat(64),
  name: "photo.jpg",
  mimeType: "image/jpeg",
  sizeBytes: 20,
} as const;
const records: ComposerContextRecord[] = [
  {
    kind: "file",
    version: 1,
    contextId: "ctx_file",
    label: file.name,
    attachmentId: file.id,
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
  },
  {
    kind: "image",
    version: 1,
    contextId: "ctx_image",
    label: image.name,
    attachmentId: image.id,
    name: image.name,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
  },
  {
    kind: "terminal",
    version: 1,
    contextId: "ctx_terminal",
    label: "Terminal 1",
    terminalId: "terminal",
    terminalLabel: "Terminal 1",
    lineStart: 2,
    lineEnd: 3,
    text: "error\ntrace",
  },
  {
    kind: "review-comment",
    version: 1,
    contextId: "ctx_review",
    label: "Review lib.rs",
    sectionId: "s",
    sectionTitle: "Working tree",
    filePath: "lib.rs",
    startIndex: 1,
    endIndex: 2,
    rangeLabel: "L1-2",
    text: "Fix this",
    diff: "+line",
  },
  {
    kind: "mention",
    version: 1,
    contextId: "ctx_path",
    label: "lib.rs",
    path: "lib.rs",
  },
  {
    kind: "skill",
    version: 1,
    contextId: "ctx_skill",
    label: "poteto-mode",
    name: "poteto-mode",
  },
  {
    kind: "citation",
    version: 1,
    contextId: "ctx_citation",
    label: "Quote",
    environmentId: "e",
    threadId: "t",
    messageId: "m",
    text: "Earlier response",
    start: 0,
    end: 16,
    prefix: "",
    suffix: "",
    comment: "Explain",
  },
];
function input(): ComposerInput {
  return {
    ...activateComposer("thread"),
    scopeKey: "composer-draft:thread",
    text: `Please inspect ${records.map(contextReference).join(" ")}`,
    records,
    attachments: [file, image].map((attachment, index) => ({
      key: String(index),
      name: attachment.name,
      status: "ready",
      attachment,
    })),
  };
}
function fixture() {
  const disk = new Map<string, string>();
  const writes: string[] = [];
  let failure: string | null = null;
  const persistence = persistentStorage(async (key, value) => {
    writes.push(key);
    if (key === failure) throw new Error("disk full");
    if (value === null) disk.delete(key);
    else disk.set(key, value);
  });
  const stash = createPromptStash(persistence, (key, draft) =>
    persistence.setItemDurable(
      key,
      JSON.stringify({
        version: 2,
        text: draft.text,
        records: draft.records,
        attachments: draft.attachments,
        appliedRevertId: draft.appliedRevertId,
      }),
    ),
  );
  return {
    disk,
    writes,
    persistence,
    stash,
    fail: (key: string | null) => {
      failure = key;
    },
  };
}
it("durably stashes and restores every chip kind and native attachment without copying bytes", async () => {
  const f = fixture();
  const source = input();
  const result = await f.stash.stash(source);
  assert.ok(result);
  assert.equal(f.disk.has(PROMPT_STASH_KEY), true);
  let destination: ComposerInput = {
    ...activateComposer("other"),
    scopeKey: "composer-draft:other",
    text: "Existing draft",
  };
  await f.stash.restore(
    result.entry.id,
    destination,
    () => destination,
    (merged) => {
      destination = merged;
    },
  );
  assert.equal(
    destination.text.startsWith("Existing draft\n\nPlease inspect"),
    true,
  );
  assert.deepEqual(readyAttachments(destination.attachments), [file, image]);
  assert.deepEqual(
    destination.records.map(({ contextId, ...record }) => record),
    records.map(({ contextId, ...record }) => record),
  );
  assert.equal(
    destination.records.every(
      (record) =>
        !records.some((source) => source.contextId === record.contextId),
    ),
    true,
  );
  assert.deepEqual(
    contextReferences(destination.text).map((ref) => ref.contextId),
    destination.records.map((record) => record.contextId),
  );
  const document = JSON.stringify(
    buildComposerDocument(destination.text, destination.records),
  );
  for (const record of records)
    assert.equal(document.includes(record.kind), true);
  assert.equal(
    f.disk.get("composer-draft:other")?.includes('"_tag":"pasted-text"'),
    true,
  );
  assert.deepEqual(f.stash.snapshot(), []);
  assert.deepEqual(f.writes, [
    PROMPT_STASH_KEY,
    "composer-draft:other",
    PROMPT_STASH_KEY,
  ]);
});
it("keeps source input and prior stash when saving fails, and refuses pending attachment work", async () => {
  const f = fixture();
  f.fail(PROMPT_STASH_KEY);
  const source = input();
  await assert.rejects(f.stash.stash(source), /disk full/);
  assert.deepEqual(f.stash.snapshot(), []);
  assert.equal(source.records.length, 7);
  await assert.rejects(
    f.stash.stash({
      ...source,
      attachments: [{ key: "pending", name: "pending.txt", status: "staging" }],
    }),
    /Wait for file uploads/,
  );
});
it("retains the stash when destination persistence fails, changes scope, or exceeds whole-payload capacity", async () => {
  const f = fixture();
  const result = await f.stash.stash(input());
  assert.ok(result);
  let current: ComposerInput = {
    ...activateComposer("dest"),
    scopeKey: "composer-draft:dest",
  };
  f.fail("composer-draft:dest");
  await assert.rejects(
    f.stash.restore(
      result.entry.id,
      current,
      () => current,
      (next) => {
        current = next;
      },
    ),
    /disk full/,
  );
  assert.equal(current.text, "");
  assert.equal(f.stash.snapshot().length, 1);
  f.fail(null);
  const before = current;
  current = {
    ...activateComposer("switched", 1),
    scopeKey: "composer-draft:switched",
  };
  assert.equal(
    await f.stash.restore(
      result.entry.id,
      before,
      () => current,
      () => assert.fail("wrong destination"),
    ),
    false,
  );
  assert.equal(f.stash.snapshot().length, 1);
  current = {
    ...before,
    attachments: Array.from({ length: 100 }, (_, n) => ({
      key: String(n),
      name: `file-${n}.txt`,
      status: "ready" as const,
      attachment: {
        ...file,
        id: n.toString(16).padStart(64, "0"),
        name: `file-${n}.txt`,
      },
    })),
  };
  await assert.rejects(
    f.stash.restore(
      result.entry.id,
      current,
      () => current,
      () => assert.fail("partial restore"),
    ),
    /100-file/,
  );
  assert.equal(f.stash.snapshot().length, 1);
});
it("keeps a duplicate durable stash when deletion after restore fails", async () => {
  const f = fixture();
  const result = await f.stash.stash(input());
  assert.ok(result);
  f.fail(PROMPT_STASH_KEY);
  let current: ComposerInput = {
    ...activateComposer("dest"),
    scopeKey: "composer-draft:dest",
  };
  await assert.rejects(
    f.stash.restore(
      result.entry.id,
      current,
      () => current,
      (next) => {
        current = next;
      },
    ),
    /stash copy remains/,
  );
  assert.equal(current.records.length, 7);
  assert.equal(f.disk.has(current.scopeKey ?? ""), true);
  assert.equal(f.stash.snapshot().length, 1);
});
it("bounds the app-global stash at twenty entries and never clears a newer composer generation", async () => {
  const f = fixture();
  let oldest = "";
  for (let n = 0; n < 21; n++) {
    const source = { ...input(), text: String(n), generation: n };
    const result = await f.stash.stash(source);
    assert.ok(result);
    if (n === 0) oldest = result.entry.id;
    assert.equal(result.evicted, n === 20);
  }
  assert.equal(f.stash.snapshot().length, 20);
  assert.equal(
    f.stash.snapshot().some((entry) => entry.id === oldest),
    false,
  );
  const source = input();
  const edited = {
    ...source,
    text: "new input",
    generation: source.generation + 1,
  };
  assert.equal(clearAcceptedInput(edited, source), edited);
});
