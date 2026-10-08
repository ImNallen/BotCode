import assert from "node:assert/strict";
import { it } from "node:test";
import {
  initialCommitDraft,
  selectedCommitFiles,
  startCommitPreview,
  updateCommitDraft,
} from "./commitMessage.ts";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const flush = () => new Promise<void>((done) => setTimeout(done, 0));

it("a generated message fills the editable field and preserves later edits", () => {
  const generated = updateCommitDraft(initialCommitDraft, {
    kind: "generated",
    message: "Add the feature",
  });
  assert.equal(generated.message, "Add the feature");
  const edited = updateCommitDraft(generated, {
    kind: "edit",
    message: "Describe it my way",
  });
  assert.equal(edited.message, "Describe it my way");
});

it("generation never replaces a message or intentional blank edited while it runs", () => {
  for (const message of ["My message", ""]) {
    const edited = updateCommitDraft(initialCommitDraft, {
      kind: "edit",
      message,
    });
    assert.equal(
      updateCommitDraft(edited, { kind: "generated", message: "Model message" })
        .message,
      message,
    );
    assert.equal(
      updateCommitDraft(edited, { kind: "failed" }).message,
      message,
    );
  }
});

it("closing during registration cancels the acknowledged job without awaiting its result", async () => {
  const begin = deferred<string>();
  const cancelled: string[] = [];
  let awaited = false;
  const cancel = startCommitPreview({
    threadId: "thread",
    selection: { kind: "all" },
    api: {
      beginCommitMessage: () => begin.promise,
      awaitCommitMessage: async () => {
        awaited = true;
        return "wrong";
      },
      cancelCommitMessage: async (job) => {
        cancelled.push(job);
      },
    },
    onGenerated: () => {
      throw new Error("a closed dialog received a message");
    },
    onFailed: () => {
      throw new Error("a closed dialog received a failure");
    },
  });
  cancel();
  begin.resolve("acknowledged-job");
  await flush();
  assert.deepEqual(cancelled, ["acknowledged-job"]);
  assert.equal(awaited, false);
});

it("closing or submitting a running preview ignores late results and cancels the job", async () => {
  const generated = deferred<string>();
  const cancelled: string[] = [];
  let delivered = false;
  const cancel = startCommitPreview({
    threadId: "thread",
    selection: { kind: "all" },
    api: {
      beginCommitMessage: async () => "job",
      awaitCommitMessage: () => generated.promise,
      cancelCommitMessage: async (job) => {
        cancelled.push(job);
      },
    },
    onGenerated: () => {
      delivered = true;
    },
    onFailed: () => {
      delivered = true;
    },
  });
  await flush();
  cancel();
  generated.resolve("late message");
  await flush();
  assert.deepEqual(cancelled, ["job"]);
  assert.equal(delivered, false);
});

it("an unsuccessful preview leaves the field editable and reports failure", async () => {
  let draft = initialCommitDraft;
  const cancel = startCommitPreview({
    threadId: "thread",
    selection: { kind: "all" },
    api: {
      beginCommitMessage: async () => "job",
      awaitCommitMessage: async () => {
        throw new Error("generation unavailable");
      },
      cancelCommitMessage: async () => {},
    },
    onGenerated: (message) => {
      draft = updateCommitDraft(draft, { kind: "generated", message });
    },
    onFailed: () => {
      draft = updateCommitDraft(draft, { kind: "failed" });
    },
  });
  await flush();
  assert.equal(draft.generation, "failed");
  assert.equal(
    updateCommitDraft(draft, { kind: "edit", message: "Manual fallback" })
      .message,
    "Manual fallback",
  );
  cancel();
});

it("selection changes replace generated text while preserving user edits", () => {
  const generated = updateCommitDraft(initialCommitDraft, {
    kind: "generated",
    message: "All files",
  });
  const changed = updateCommitDraft(generated, { kind: "selection_changed" });
  assert.equal(changed.message, "");
  assert.equal(changed.generation, "running");
  assert.equal(
    updateCommitDraft(changed, { kind: "generated", message: "Selected files" })
      .message,
    "Selected files",
  );
  for (const message of ["My words", ""]) {
    const edited = updateCommitDraft(generated, { kind: "edit", message });
    const changed = updateCommitDraft(edited, { kind: "selection_changed" });
    assert.equal(
      updateCommitDraft(changed, {
        kind: "generated",
        message: "Selected files",
      }).message,
      message,
    );
  }
});

it("selection changes cancel the old job and forward the exact new selection", async () => {
  const old = deferred<string>();
  const selections: unknown[] = [];
  const cancelled: string[] = [];
  const delivered: string[] = [];
  const api = {
    beginCommitMessage: async (_thread: string, selection: unknown) => {
      selections.push(selection);
      return selections.length === 1 ? "old" : "new";
    },
    awaitCommitMessage: async (job: string) =>
      job === "old" ? old.promise : "Selected only",
    cancelCommitMessage: async (job: string) => {
      cancelled.push(job);
    },
  };
  const callbacks = {
    threadId: "thread",
    api,
    onGenerated: (message: string) => delivered.push(message),
    onFailed: () => assert.fail("unexpected failure"),
  };
  const cancel = startCommitPreview({
    ...callbacks,
    selection: { kind: "all" },
  });
  await flush();
  cancel();
  startCommitPreview({
    ...callbacks,
    selection: { kind: "paths", paths: ["selected.txt"] },
  });
  old.resolve("Stale all files");
  await flush();
  assert.deepEqual(selections, [
    { kind: "all" },
    { kind: "paths", paths: ["selected.txt"] },
  ]);
  assert.deepEqual(cancelled, ["old"]);
  assert.deepEqual(delivered, ["Selected only"]);
});

it("file selection defaults to all and refuses an empty subset", () => {
  const files = ["a", "b"].map((path) => ({
    path,
    insertions: 1,
    deletions: 0,
  }));
  assert.deepEqual(selectedCommitFiles(files, new Set()), { kind: "all" });
  assert.deepEqual(selectedCommitFiles(files, new Set(["b"])), {
    kind: "paths",
    paths: ["a"],
  });
  assert.equal(selectedCommitFiles(files, new Set(["a", "b"])), null);
  assert.equal(selectedCommitFiles([], new Set()), null);
});
