import assert from "node:assert/strict";
import { it } from "node:test";
import {
  initialCommitDraft,
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
