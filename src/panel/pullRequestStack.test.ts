import assert from "node:assert/strict";
import { it } from "node:test";
import { Children, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { ipc } from "../ipc";
import {
  PullRequestStackMenuActions,
  PullRequestStackConfirmation,
} from "./PullRequestStackMenu";
import { PullRequestStackRecovery } from "./PullRequestStackRecovery";
import { PullRequestStackHeader } from "./PullRequestStackHeader";
import { PullRequestStackLayers } from "./PullRequestStackLayers";
import { PullRequestStackLayerContent } from "./PullRequestStackLayerContent";
import { pullRequestKey, cachedPr } from "./pullRequests";
import {
  pullRequestStack,
  prStackOperation,
  stackActionState,
  stackActionInput,
  savedPullRequestStack,
  stackLayerAccess,
  stackLayerReference,
  type PullRequestStackReference,
} from "./pullRequestStack";
import { eligibleSurfaces, openSurface } from "./panelState";
import type { PanelState } from "./RightPanel";
const key = pullRequestKey.parse("github.com/fixture/project/42");
const stack = pullRequestStack.parse({
  id: "50",
  number: 50,
  url: "https://github.com/fixture/project/stacks/50",
  base: "main",
  layers: [
    {
      number: 41,
      title: "Bottom",
      headBranch: "bottom",
      state: "merged",
      headSha: "a".repeat(40),
    },
    {
      number: 42,
      title: "Middle",
      headBranch: "middle",
      state: "open",
      isDraft: true,
      headSha: "b".repeat(40),
    },
    {
      number: 43,
      title: "",
      headBranch: "top",
      state: "closed",
      headSha: "c".repeat(40),
    },
  ],
});
const reference = { key, number: 42 };
it("renders top-first layers, fallback branch titles, native state labels, current mark and base", () => {
  const html = renderToStaticMarkup(
    createElement(PullRequestStackLayers, { stack, reference, onSelect() {} }),
  );
  assert.ok(html.indexOf("#43") < html.indexOf("#42"));
  assert.ok(html.indexOf("#42") < html.indexOf("#41"));
  for (const label of [
    "top",
    "Middle",
    "Bottom",
    "Closed",
    "Draft",
    "Merged",
    "↳ main",
    'aria-current="true"',
    "max-h-80 overflow-y-auto",
    "size-3.5",
  ])
    assert.ok(html.includes(label), label);
  assert.equal((html.match(/aria-current=/g) ?? []).length, 1);
  const middle = stack.layers[1];
  assert.ok(middle);
  const compact = renderToStaticMarkup(
    createElement(PullRequestStackLayerContent, {
      layer: middle,
      compact: true,
    }),
  );
  assert.ok(compact.includes("#42"));
  assert.ok(compact.includes("Draft"));
  assert.ok(!compact.includes("middle ·"));
});
it("stack header distinguishes saved refresh and failed refresh notices", () => {
  for (const stale of [false, true]) {
    const html = renderToStaticMarkup(
      createElement(PullRequestStackHeader, {
        number: 50,
        notice: "Refresh notice",
        stale,
      }),
    );
    assert.ok(html.includes("Stack #50"));
    assert.ok(html.includes(stale ? "May be stale" : "Refreshing…"));
    assert.ok(html.includes("flex items-center justify-between gap-2"));
  }
});
it("layer selection opens an unlinked sibling in the same repository without changing source access", () => {
  const selections: PullRequestStackReference[] = [];
  const tree = PullRequestStackLayers({
    stack,
    reference,
    onSelect: (target) => selections.push(target),
  });
  const clicks: (() => void)[] = [];
  const visit = (node: ReactNode): void =>
    Children.forEach(node, (child) => {
      if (
        !isValidElement<{ onClick?: () => void; children?: ReactNode }>(child)
      )
        return;
      if (child.props.onClick) clicks.push(child.props.onClick);
      visit(child.props.children);
    });
  visit(tree);
  assert.equal(clicks.length, 3);
  clicks[0]?.();
  const selected = selections[0];
  assert.ok(selected);
  assert.equal(selected.key, "github.com/fixture/project/43");
  assert.equal(selected.number, 43);
  const linkedKey = pullRequestKey.parse("github.com/fixture/project/41");
  assert.equal(
    stackLayerAccess({
      key: linkedKey,
      linkedKeys: [linkedKey],
      threadId: "source-thread",
      workspaceId: "project",
    }),
    "source-thread",
  );
  assert.deepEqual(
    stackLayerAccess({
      key: selected.key,
      linkedKeys: [linkedKey],
      threadId: "source-thread",
      workspaceId: "project",
    }),
    { workspaceId: "project" },
  );
  const pr = cachedPr.parse({
    key: linkedKey,
    revision: 1,
    snapshot: null,
    freshness: { kind: "never_loaded" },
    stack: { ...stack, observedAt: 123 },
  });
  const links = [{ pr, linkedAt: 1, source: "manual" as const }];
  const panel: PanelState = { surfaces: [], active: null };
  const opened = openSurface(panel, {
    kind: "pull_request",
    key: selected.key,
  });
  assert.deepEqual(eligibleSurfaces(opened, true, links), opened);
  assert.equal(links.length, 1);
  const unrelated = openSurface(panel, {
    kind: "pull_request",
    key: pullRequestKey.parse("github.com/other/project/43"),
  });
  assert.equal(eligibleSurfaces(unrelated, true, links).surfaces.length, 0);
});
it("layer navigation respects missing callback and pending state", () => {
  for (const props of [{ pending: true, onSelect() {} }, {}]) {
    const html = renderToStaticMarkup(
      createElement(PullRequestStackLayers, { stack, reference, ...props }),
    );
    assert.equal((html.match(/disabled=""/g) ?? []).length, 3);
  }
});
it("saved stack schemas discard action heads and old cached records remain compatible", () => {
  const saved = savedPullRequestStack.parse({ ...stack, observedAt: 123 });
  assert.ok(!JSON.stringify(saved).includes("headSha"));
  assert.ok(!JSON.stringify(saved).includes("a".repeat(40)));
  assert.equal(
    cachedPr.parse({
      key,
      revision: 0,
      snapshot: null,
      freshness: { kind: "never_loaded" },
    }).stack,
    undefined,
  );
  assert.equal(
    stackLayerReference(reference, 43).key,
    "github.com/fixture/project/43",
  );
});
it("native stack IPC carries exact access and parses detailed stack responses", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { crypto: globalThis.crypto },
  });
  try {
    mockIPC((command, args) => {
      assert.equal(command, "read_pull_request_stack");
      assert.deepEqual(args, { threadId: { workspaceId: "project" }, key });
      return stack;
    });
    assert.deepEqual(
      await ipc.readPullRequestStack({ workspaceId: "project" }, key),
      stack,
    );
    mockIPC(() => null);
    assert.equal(await ipc.readPullRequestStack("source-thread", key), null);
    mockIPC(() => ({ number: 50, layers: [] }));
    await assert.rejects(
      ipc.readPullRequestStack("source-thread", key),
      /invalid|expected/i,
    );
  } finally {
    clearMocks();
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

it("captures the original selected observation, prefix merge heads and all remote rebase heads", () => {
  const live = pullRequestStack.parse({
    ...stack,
    layers: stack.layers.map((layer) => ({
      ...layer,
      state: "open",
      isDraft: false,
    })),
  });
  const observation = {
    key,
    nodeId: "PR_fixture_42",
    headOid: "b".repeat(40),
    viewer: "fixture-viewer",
  };
  const merged = stackActionInput({
    stack: live,
    reference,
    target: observation,
    requestId: "merge-request",
    action: { kind: "merge", method: "squash" },
  });
  assert.deepEqual(merged.expectedStackHeads, [
    { number: 41, headSha: "a".repeat(40) },
    { number: 42, headSha: "b".repeat(40) },
  ]);
  assert.equal(merged.target.key, key);
  assert.equal(merged.target.headOid, "b".repeat(40));
  assert.equal(merged.target.viewer, "fixture-viewer");
  const rebase = stackActionInput({
    stack: live,
    reference,
    target: observation,
    requestId: "rebase-request",
    action: { kind: "rebase" },
  });
  assert.deepEqual(
    rebase.expectedStackHeads.map((head) => head.number),
    [41, 42, 43],
  );
  assert.equal(rebase.target.key, key);
  assert.equal(rebase.action.kind, "rebase");
  const saved = savedPullRequestStack.parse({ ...live, observedAt: 123 });
  assert.throws(
    () =>
      stackActionInput({
        stack: pullRequestStack.parse(saved),
        reference,
        target: observation,
        requestId: "saved",
        action: { kind: "merge", method: "squash" },
      }),
    /invalid|expected/i,
  );
});
it("keeps T3's draft, closed, missing SHA and pending disabled behavior", () => {
  const live = pullRequestStack.parse({
    ...stack,
    layers: stack.layers.map((layer) => ({
      ...layer,
      state: "open",
      isDraft: false,
    })),
  });
  assert.equal(stackActionState(live, reference, false).mergeDisabled, false);
  assert.equal(stackActionState(live, reference, false).rebaseDisabled, false);
  assert.equal(stackActionState(live, reference, true).mergeDisabled, true);
  assert.equal(stackActionState(live, reference, true).rebaseDisabled, true);
  for (const replacement of [
    { state: "closed" },
    { isDraft: true },
    { headSha: null },
  ]) {
    const changed = pullRequestStack.parse({
      ...live,
      layers: live.layers.map((layer) =>
        layer.number === 41 ? { ...layer, ...replacement } : layer,
      ),
    });
    assert.equal(
      stackActionState(changed, reference, false).mergeDisabled,
      true,
    );
    assert.equal(
      stackActionState(changed, reference, false).rebaseDisabled,
      "isDraft" in replacement ? false : true,
    );
  }
  const unknownUpper = pullRequestStack.parse({
    ...live,
    layers: live.layers.map((layer) =>
      layer.number === 43 ? { ...layer, headSha: null } : layer,
    ),
  });
  assert.equal(
    stackActionState(unknownUpper, reference, false).mergeDisabled,
    false,
  );
  assert.equal(
    stackActionState(unknownUpper, reference, false).rebaseDisabled,
    true,
  );
});
it("renders exact stack menu labels and hides actions without permissions", () => {
  const live = pullRequestStack.parse({
    ...stack,
    layers: stack.layers.map((layer) => ({
      ...layer,
      state: "open",
      isDraft: false,
    })),
  });
  const props = {
    stack: live,
    reference,
    pending: false,
    canMerge: true,
    canRebase: true,
    setConfirmation() {},
  };
  const html = renderToStaticMarkup(
    createElement(PullRequestStackMenuActions, props),
  );
  assert.ok(html.includes("Merge stack (2)"));
  assert.ok(html.includes("Rebase stack"));
  assert.ok(!html.includes("disabled="));
  const stale = renderToStaticMarkup(
    createElement(PullRequestStackMenuActions, { ...props, pending: true }),
  );
  assert.equal((stale.match(/disabled=""/g) ?? []).length, 2);
  assert.equal(
    renderToStaticMarkup(
      createElement(PullRequestStackMenuActions, {
        ...props,
        canMerge: false,
        canRebase: false,
      }),
    ),
    "",
  );
  const draft = renderToStaticMarkup(
    createElement(PullRequestStackMenuActions, { ...props, stack }),
  );
  assert.ok(
    draft.includes(
      "Every layer being merged must be open and ready for review.",
    ),
  );
});
it("renders T3 confirmation counts, descriptions, layer classes and pending controls", () => {
  const live = pullRequestStack.parse({
    ...stack,
    layers: stack.layers.map((layer) => ({
      ...layer,
      state: "open",
      isDraft: false,
    })),
  });
  const props = {
    stack: live,
    reference,
    confirmation: "merge",
    mergeMethod: "squash",
    pending: false,
    setConfirmation() {},
    run() {},
  } satisfies Parameters<typeof PullRequestStackConfirmation>[0];
  const merge = renderToStaticMarkup(
    createElement(PullRequestStackConfirmation, props),
  );
  for (const expected of [
    "Merge 2 pull requests?",
    "Merge #42 and its unmerged layers below into main using squash. GitHub checks their rules before merging or queueing them and rebases the remaining stack after merging.",
    "max-h-48 space-y-1 overflow-y-auto text-sm",
    "flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2",
    'aria-label="Close"',
    "absolute end-2 top-2",
  ])
    assert.ok(merge.includes(expected), expected);
  assert.ok(!merge.includes("#43"));
  const rebase = renderToStaticMarkup(
    createElement(PullRequestStackConfirmation, {
      ...props,
      confirmation: "update-branch",
      pending: true,
    }),
  );
  for (const expected of [
    "Rebase 3 pull requests?",
    "Rebase the remote branches from bottom to top onto main. This rewrites branch history and may restart checks. If a layer fails, earlier updates remain.",
    "Working…",
  ])
    assert.ok(rebase.includes(expected), expected);
  assert.ok(!rebase.includes('aria-label="Close"'));
  assert.equal((rebase.match(/disabled=""/g) ?? []).length, 2);
});
it("keeps receipt recovery available independently of live stack data", () => {
  const operation = prStackOperation.parse({
    input: {
      requestId: "pending",
      target: {
        key,
        nodeId: "PR_fixture_42",
        headOid: "b".repeat(40),
        viewer: "fixture-viewer",
      },
      stackNumber: 50,
      expectedStackHeads: [{ number: 42, headSha: "b".repeat(40) }],
      action: { kind: "merge", method: "squash" },
    },
    affectedKeys: [key],
    progress: [],
    dispatchedLayer: 42,
    mergeUuid: null,
    result: { kind: "accepted", outcome: "enqueued" },
  });
  const html = renderToStaticMarkup(
    createElement(PullRequestStackRecovery, {
      access: { workspaceId: "project" },
      prKey: key,
      operations: [operation],
      onActed() {},
    }),
  );
  assert.ok(html.includes("Check stack operation"));
});

it("cancelling stack confirmation does not dispatch its native action", () => {
  let nativeActions = 0;
  let confirmation: "merge" | "update-branch" | null = "merge";
  const tree = PullRequestStackConfirmation({
    stack,
    reference,
    confirmation: "merge",
    mergeMethod: "squash",
    pending: false,
    setConfirmation: (value) => {
      confirmation = value;
    },
    run: () => {
      nativeActions++;
    },
  });
  const clicks: (() => void)[] = [];
  const visit = (node: ReactNode): void =>
    Children.forEach(node, (child) => {
      if (
        !isValidElement<{ onClick?: () => void; children?: ReactNode }>(child)
      )
        return;
      if (child.props.onClick) clicks.push(child.props.onClick);
      visit(child.props.children);
    });
  visit(tree);
  assert.equal(clicks.length, 2);
  clicks[0]?.();
  assert.equal(confirmation, null);
  assert.equal(nativeActions, 0);
});
