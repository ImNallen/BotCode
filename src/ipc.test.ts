import assert from "node:assert/strict";
import { it } from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import {
  checkoutKey,
  chunkTerminalInput,
  ipc,
  subscribe,
  type Branches,
  type TerminalEvent,
  type ThreadSummary,
  type UsageLimits,
  type WorkspaceView,
} from "./ipc.ts";
import { usageLimitsQuery } from "./usage/limits.ts";

it("refreshes the active branch picker after a worktree naming event without refreshing another workspace", async () => {
  const workspaceId = "67ce24cf-70e2-44b3-99f4-53bd8d155d19";
  const otherWorkspaceId = "ba2baf88-7534-4d53-947c-bc2e432a549d";
  const threadId = "058478ab-2c41-40e0-83b7-dd2c71b3c368";
  const temporaryBranch = "botcode/1234abcd";
  const generatedBranch = "botcode/fix-login-redirect";
  const checkout = { workspaceId, threadId };
  const otherCheckout = { workspaceId: otherWorkspaceId, threadId };
  const summary = {
    id: threadId,
    title: "Fix login redirect",
    session: { kind: "ready" },
    checkout: {
      kind: "worktree",
      path: "/fixture/botcode-1234abcd",
      branch: temporaryBranch,
    },
    pullRequests: {
      sequence: 0,
      links: [],
      discovering: false,
      discoveryError: null,
    },
    updatedAtMs: 1,
    awaitingApproval: false,
    pinnedAtMs: null,
    snoozedUntilMs: null,
    settledAtMs: null,
  } satisfies ThreadSummary;
  const view = {
    workspace: {
      id: workspaceId,
      root: "/fixture",
      label: "Fixture",
      kind: "repository",
    },
    branch: temporaryBranch,
    files: [],
    changes: [],
    threads: [summary],
    unavailable: null,
  } satisfies WorkspaceView;
  const branches = (name: string): Branches => ({
    origin: false,
    branches: [
      {
        name,
        current: true,
        remote: false,
        default: false,
        worktree: summary.checkout.path,
      },
    ],
  });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: Object.assign(new EventTarget(), { crypto: globalThis.crypto }),
  });
  let matchingCalls = 0;
  let unrelatedCalls = 0;
  mockIPC(
    (command, payload) => {
      assert.equal(command, "list_branches");
      assert.ok(payload && "workspaceId" in payload);
      assert.equal(payload.threadId, threadId);
      if (payload.workspaceId === workspaceId) {
        matchingCalls++;
        return branches(generatedBranch);
      }
      assert.equal(payload.workspaceId, otherWorkspaceId);
      unrelatedCalls++;
      return branches("other-branch");
    },
    { shouldMockEvents: true },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(checkoutKey("workspace", checkout), view);
  client.setQueryData(
    checkoutKey("branches", checkout),
    branches(temporaryBranch),
  );
  client.setQueryData(
    checkoutKey("branches", otherCheckout),
    branches("other-branch"),
  );
  const matching = new QueryObserver(client, {
    queryKey: checkoutKey("branches", checkout),
    queryFn: () => ipc.branches(checkout),
  });
  const unrelated = new QueryObserver(client, {
    queryKey: checkoutKey("branches", otherCheckout),
    queryFn: () => ipc.branches(otherCheckout),
  });
  let resolveRefreshed = () => {};
  const refreshed = new Promise<void>((resolve) => {
    resolveRefreshed = resolve;
  });
  const offMatching = matching.subscribe((result) => {
    if (result.data?.branches[0]?.name === generatedBranch) resolveRefreshed();
  });
  const offUnrelated = unrelated.subscribe(() => {});
  let offEvents: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    offEvents = await subscribe(client);
    assert.equal(
      matching.getCurrentResult().data?.branches[0]?.name,
      temporaryBranch,
    );
    await emit("bot:changed", {
      threadId,
      workspaceId,
      revision: 2,
      refreshWorkspace: true,
      summary: {
        ...summary,
        checkout: { ...summary.checkout, branch: generatedBranch },
      },
    });
    await Promise.race([
      refreshed,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error("Branch picker retained its cached temporary branch"),
            ),
          2000,
        );
      }),
    ]);
    assert.equal(
      matching.getCurrentResult().data?.branches[0]?.name,
      generatedBranch,
    );
    assert.equal(matchingCalls, 1);
    assert.equal(unrelatedCalls, 0);
    assert.equal(
      unrelated.getCurrentResult().data?.branches[0]?.name,
      "other-branch",
    );
    assert.deepEqual(
      client.getQueryData<WorkspaceView>(checkoutKey("workspace", checkout))
        ?.threads[0]?.checkout,
      { ...summary.checkout, branch: generatedBranch },
    );
  } finally {
    clearTimeout(timeout);
    offEvents?.();
    offMatching();
    offUnrelated();
    client.clear();
    clearMocks();
    if (previousWindow)
      Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

it("splits terminal input on code point boundaries within the byte limit", () => {
  const bytes = (text: string) => new TextEncoder().encode(text).length;
  assert.deepEqual(chunkTerminalInput("", 4), []);
  assert.deepEqual(chunkTerminalInput("abcdef", 4), ["abcd", "ef"]);
  assert.deepEqual(chunkTerminalInput("aé€😀", 4), ["aé", "€", "😀"]);
  const paste = "é".repeat(40_000);
  const chunks = chunkTerminalInput(paste);
  assert.deepEqual(chunks.map(bytes), [65536, 14464]);
  assert.equal(chunks.join(""), paste);
});

it("attaches a terminal, parses its events and chunks large writes", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: Object.assign(new EventTarget(), { crypto: globalThis.crypto }),
  });
  const calls: Array<[string, Record<string, unknown>]> = [];
  let channelId: number | undefined;
  mockIPC((command, payload) => {
    const args = payload as Record<string, unknown>;
    if (command === "terminal_attach") {
      channelId = (args.onEvent as { id: number }).id;
      const { onEvent: _channel, ...rest } = args;
      calls.push([command, rest]);
      return 7;
    }
    calls.push([command, { ...args, data: String(args.data).length }]);
    return null;
  });
  const target = { workspaceId: "ws", threadId: null, terminalId: "term-1" };
  const events: TerminalEvent[] = [];
  try {
    const subscription = await ipc.terminalAttach(
      target,
      { cols: 2000, rows: 40.4 },
      (event) => events.push(event),
    );
    assert.equal(subscription, 7);
    const run = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          runCallback: (id: number, data: unknown) => void;
        };
      }
    ).__TAURI_INTERNALS__.runCallback;
    assert.ok(channelId !== undefined);
    run(channelId, { index: 0, message: { type: "snapshot", history: "$ " } });
    run(channelId, { index: 1, message: { type: "bogus" } });
    run(channelId, { index: 2, message: { type: "output", data: "ls" } });
    run(channelId, { index: 3, message: { type: "exited", exitCode: null } });
    assert.deepEqual(events, [
      { type: "snapshot", history: "$ " },
      { type: "output", data: "ls" },
      { type: "exited", exitCode: null },
    ]);
    await ipc.terminalWrite(target, "x".repeat(65537));
    assert.deepEqual(calls, [
      [
        "terminal_attach",
        {
          workspaceId: "ws",
          threadId: null,
          terminalId: "term-1",
          cols: 1000,
          rows: 40,
        },
      ],
      [
        "terminal_write",
        {
          workspaceId: "ws",
          threadId: null,
          terminalId: "term-1",
          data: 65536,
        },
      ],
      [
        "terminal_write",
        { workspaceId: "ws", threadId: null, terminalId: "term-1", data: 1 },
      ],
    ]);
  } finally {
    clearMocks();
    if (previousWindow)
      Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

it("caches pushed usage limits without reading them again", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: Object.assign(new EventTarget(), { crypto: globalThis.crypto }),
  });
  const calls: string[] = [];
  mockIPC(
    (command) => {
      calls.push(command);
      return { kind: "unsupported" };
    },
    { shouldMockEvents: true },
  );
  const client = new QueryClient();
  const cached: UsageLimits = {
    kind: "failed",
    message: "Usage service unavailable",
  };
  client.setQueryData(usageLimitsQuery.queryKey, cached);
  const observer = new QueryObserver(client, usageLimitsQuery);
  const pushed: UsageLimits = {
    kind: "reported",
    plan: "ChatGPT Pro 20x Subscription",
    windows: [
      {
        slot: "primary",
        kind: "weekly",
        usedPercent: 44,
        durationMins: 10080,
        resetsAtMs: 1_791_580_401_000,
      },
    ],
  };
  let resolvePushed = () => {};
  const received = new Promise<void>((resolve) => {
    resolvePushed = resolve;
  });
  const offObserver = observer.subscribe((result) => {
    if (result.data?.kind === "reported") resolvePushed();
  });
  let offEvents: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    offEvents = await subscribe(client);
    await emit("bot:usage-limits", { kind: "reported", plan: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(client.getQueryData(usageLimitsQuery.queryKey), cached);
    await emit("bot:usage-limits", pushed);
    await Promise.race([
      received,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("The pushed limits never reached the cache")),
          2000,
        );
      }),
    ]);
    assert.deepEqual(client.getQueryData(usageLimitsQuery.queryKey), pushed);
    window.dispatchEvent(new Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(calls, []);
    assert.deepEqual(client.getQueryData(usageLimitsQuery.queryKey), pushed);
  } finally {
    clearTimeout(timeout);
    offEvents?.();
    offObserver();
    client.clear();
    clearMocks();
    if (previousWindow)
      Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

it("reads a thread saved before context usage as having none", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: Object.assign(new EventTarget(), { crypto: globalThis.crypto }),
  });
  const snapshot = {
    id: "058478ab-2c41-40e0-83b7-dd2c71b3c368",
    workspaceId: "67ce24cf-70e2-44b3-99f4-53bd8d155d19",
    title: "Fixture",
    nativeThreadId: null,
    revision: 1,
    session: { kind: "ready" },
    settings: {
      model: null,
      effort: null,
      permissionMode: "approval-required",
    },
    checkout: { kind: "local" },
    turns: [],
    approvals: [],
    diagnostic: null,
  };
  const context = {
    usedTokens: 20575,
    maxTokens: 258400,
    totalProcessedTokens: 41150,
  };
  let reply: unknown = snapshot;
  mockIPC(() => reply);
  try {
    assert.equal((await ipc.thread(snapshot.id)).context, null);
    reply = { ...snapshot, context };
    assert.deepEqual((await ipc.thread(snapshot.id)).context, context);
  } finally {
    clearMocks();
    if (previousWindow)
      Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
