import assert from "node:assert/strict";
import { it } from "node:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { ipc, type Thread } from "../ipc";
import { prObservation } from "../panel/prReview";
import { findingPrompt, type ReviewDraftRequest } from "../panel/reviews";
import { activateComposer, type ComposerInput } from "./composerAttachments";
import {
  contextReference,
  referencedContext,
  type ComposerContextRecord,
} from "./composerContext";
import { composerDraftKey } from "./composerDrafts";
import {
  carryCheckoutDraft,
  persistPreparedRepair,
  preparedRepairInput,
  PullRequestPreparation,
  sameHandoffSource,
} from "./pullRequestHandoff";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const workspaceId = "018ba719-19f4-4fdb-bd79-aa4a676ea055";
const sourceId = "018ba719-19f4-4fdb-bd79-aa4a676ea054";
const destination: Thread = {
  id: "018ba719-19f4-4fdb-bd79-aa4a676ea056",
  workspaceId,
  title: "PR repair",
  worktreeSetup: null,
  nativeThreadId: null,
  revision: 1,
  session: { kind: "draft" },
  checkout: { kind: "worktree", path: "/registered/checkout", branch: "pr-7" },
  settings: {
    model: null,
    effort: null,
    permissionMode: "approval-required",
    interactionMode: "default",
  },
  context: null,
  approvals: [],
  userQuestions: [],
  diagnostic: null,
  pendingRevert: null,
  lastRevert: null,
  turns: [],
};
const target = prObservation.parse({
  key: "github.com/test/repo/7",
  nodeId: "PR_fixture",
  headOid: "a".repeat(40),
  viewer: "reviewer",
});
const request: ReviewDraftRequest = {
  workspaceId,
  threadId: sourceId,
  key: target.key,
  target,
  intent: "fix_findings",
  observation: target,
  base: "main",
  head: "feature",
  findings: [],
  checks: [{ name: "Unit tests", state: "FAILURE", url: null }],
  problems: [],
};
const record: ComposerContextRecord = {
  version: 1,
  kind: "mention",
  contextId: "source_context",
  label: "source.ts",
  path: "src/source.ts",
};
const source: ComposerInput = {
  ...activateComposer(sourceId, 3),
  scopeKey: composerDraftKey(workspaceId, sourceId),
  text: `Keep my source text ${contextReference(record)}`,
  records: [record],
  attachments: [
    {
      key: "source-file",
      name: "source.txt",
      status: "ready",
      attachment: {
        kind: "file",
        id: "file_source",
        name: "source.txt",
        extension: "txt",
        mimeType: "text/plain",
        sizeBytes: 10,
        source: { _tag: "pasted-text" },
      },
    },
  ],
};
function destinationInput(): ComposerInput {
  return {
    ...activateComposer(destination.id, 4),
    scopeKey: composerDraftKey(workspaceId, destination.id),
    text: "Keep destination text",
    records: [record],
    attachments: [...source.attachments],
  };
}

it("preserves source before preparing, captures exact identity, and retains one prepared conversation after late navigation", async () => {
  const captured = { ...target };
  const preparation = new PullRequestPreparation(captured, request, source);
  captured.headOid = "b".repeat(40);
  let current = source;
  let creations = 0;
  let saves = 0;
  const completion = deferred<Thread>();
  const dispatched = deferred<void>();
  const options = {
    destination: { kind: "dedicated" } as const,
    current: () => current,
    persist: async (input: ComposerInput) => {
      assert.deepEqual(input, source);
      saves++;
    },
    prepare: async (
      input: Parameters<typeof ipc.preparePullRequestThread>[0],
    ) => {
      assert.equal(saves, 1);
      assert.deepEqual(input.target, target);
      creations++;
      dispatched.resolve();
      return completion.promise;
    },
  };
  const pending = preparation.prepare(options);
  const concurrent = preparation.prepare(options);
  await dispatched.promise;
  current = {
    ...activateComposer("unrelated", 4),
    scopeKey: "unrelated",
    text: "Do not change this",
  };
  completion.resolve(destination);
  assert.equal(await pending, destination);
  assert.equal(await concurrent, destination);
  assert.equal(sameHandoffSource(current, source), false);
  assert.equal(preparation.thread, destination);
  assert.equal(await preparation.prepare(options), destination);
  assert.equal(creations, 1);
  assert.equal(current.text, "Do not change this");
});

it("refuses preparation when the source is edited during its durable save", async () => {
  let current = source;
  let creations = 0;
  const preparation = new PullRequestPreparation(target, request, source);
  await assert.rejects(
    preparation.prepare({
      destination: { kind: "existing", path: "/registered/checkout" },
      current: () => current,
      persist: async () => {
        current = {
          ...source,
          generation: source.generation + 1,
          text: "New edit",
        };
      },
      prepare: async () => {
        creations++;
        return destination;
      },
    }),
    /conversation changed/,
  );
  assert.equal(creations, 0);
  assert.equal(current.text, "New edit");
});

it("adds repair only to the activated destination and retains both conversations' input", () => {
  const current = destinationInput();
  const preserved = structuredClone(source);
  const input = preparedRepairInput({
    current,
    activation: 4,
    destination,
    request,
  });
  assert.ok(input);
  assert.equal(input.text, `${current.text}\n\n${findingPrompt(request)}`);
  assert.deepEqual(input.records, current.records);
  assert.deepEqual(input.attachments, current.attachments);
  assert.deepEqual(source, preserved);
  for (const wrong of [
    { ...current, threadId: "unrelated" },
    { ...current, scopeKey: "unrelated" },
    { ...current, activation: 6 },
  ])
    assert.equal(
      preparedRepairInput({
        current: wrong,
        activation: 4,
        destination,
        request,
      }),
      null,
    );
});

it("remerges a destination edit during delayed persistence before completing the handoff", async () => {
  let current = destinationInput();
  const completion = deferred<void>();
  const started = deferred<void>();
  const saved: ComposerInput[] = [];
  const pending = persistPreparedRepair({
    current: () => current,
    activation: 4,
    destination,
    request,
    persist: async (input) => {
      saved.push(input);
      if (saved.length === 1) {
        started.resolve();
        await completion.promise;
      }
    },
  });
  await started.promise;
  current = {
    ...current,
    text: "New destination edit",
    generation: current.generation + 1,
    records: [
      ...current.records,
      { ...record, contextId: "new_context", path: "new.ts" },
    ],
  };
  completion.resolve();
  const result = await pending;
  assert.equal(saved.length, 2);
  assert.equal(result?.kind, "active");
  if (result?.kind !== "active")
    throw new Error("Expected activated destination");
  assert.equal(
    result.input.text,
    `New destination edit\n\n${findingPrompt(request)}`,
  );
  assert.deepEqual(result.input.records, current.records);
  assert.deepEqual(result.input.attachments, current.attachments);
});

it("finishes a destination save without mutating or focusing an unrelated conversation after navigation", async () => {
  let current = destinationInput();
  const completion = deferred<void>();
  const started = deferred<void>();
  const saved: ComposerInput[] = [];
  const pending = persistPreparedRepair({
    current: () => current,
    activation: 4,
    destination,
    request,
    persist: async (input) => {
      saved.push(input);
      started.resolve();
      await completion.promise;
    },
  });
  await started.promise;
  current = {
    ...activateComposer("another", 5),
    scopeKey: "another",
    text: "Unrelated unsent text",
  };
  completion.resolve();
  assert.deepEqual(await pending, { kind: "saved" });
  assert.equal(current.text, "Unrelated unsent text");
  assert.equal(saved[0]?.threadId, destination.id);
  assert.equal(
    saved[0]?.text,
    `Keep destination text\n\n${findingPrompt(request)}`,
  );
});

it("carries a project draft into a fresh checkout conversation without losing either draft or colliding context ids", () => {
  const project = {
    ...source,
    threadId: undefined,
    scopeKey: composerDraftKey(workspaceId),
  };
  const prior = destinationInput();
  prior.text = `Destination input ${contextReference(record)}`;
  const beforeSource = structuredClone(project);
  const beforeDestination = structuredClone(prior);
  const combined = carryCheckoutDraft(prior, project);
  assert.ok(combined.text.startsWith(`${prior.text}\n\nKeep my source text `));
  assert.equal(combined.records.length, 2);
  assert.ok(combined.records[0]?.contextId !== combined.records[1]?.contextId);
  assert.equal(referencedContext(combined)?.records.length, 2);
  assert.deepEqual(combined.attachments, prior.attachments);
  assert.deepEqual(project, beforeSource);
  assert.deepEqual(prior, beforeDestination);
});

it("passes registered paths and captured PR observations through native IPC", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { crypto: globalThis.crypto },
  });
  const calls: { command: string; args: unknown }[] = [];
  const rows = [
    {
      path: "/registered/detached",
      branch: null,
      head: target.headOid,
      unavailable: null,
    },
    {
      path: "/registered/missing",
      branch: "gone",
      head: target.headOid,
      unavailable: "Worktree is missing.",
    },
  ];
  mockIPC((command, args) => {
    calls.push({ command, args });
    return command === "list_worktrees" ? rows : destination;
  });
  try {
    assert.deepEqual(await ipc.listWorktrees(workspaceId), rows);
    await ipc.create(workspaceId, {
      kind: "registered",
      path: "/registered/detached",
    });
    await ipc.preparePullRequestThread({
      sourceThreadId: sourceId,
      target,
      destination: { kind: "existing", path: "/registered/detached" },
    });
    assert.deepEqual(
      calls.map((call) => call.command),
      ["list_worktrees", "create_thread", "prepare_pull_request_thread"],
    );
    assert.deepEqual(calls[1]?.args, {
      workspaceId,
      checkout: { kind: "registered", path: "/registered/detached" },
    });
    assert.deepEqual(calls[2]?.args, {
      input: {
        sourceThreadId: sourceId,
        target,
        destination: { kind: "existing", path: "/registered/detached" },
      },
    });
  } finally {
    clearMocks();
    if (previousWindow)
      Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
