import assert from "node:assert/strict";
import { it } from "node:test";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ipc } from "../ipc";
import { PullRequestMergeMethods } from "./PullRequestMergeMethods";
import { PullRequestStackConfirmation } from "./PullRequestStackMenu";
import {
  readPullRequestMergeMethod,
  savePullRequestMergeMethod,
  resolvePullRequestMergeMethod,
  showsPullRequestMergeMethods,
} from "./pullRequestMergeMethod";
import { prObservation, prReviewDetail, type MergeMethod } from "./prReview";
import { pullRequestStack, stackActionInput } from "./pullRequestStack";

it("defaults to merge and remembers a validated strategy across remounts", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let stored: string | null = null;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => stored,
      setItem: (_key: string, value: string) => {
        stored = value;
      },
    },
  });
  try {
    assert.equal(readPullRequestMergeMethod(), "merge");
    savePullRequestMergeMethod("rebase");
    assert.equal(readPullRequestMergeMethod(), "rebase");
    for (const invalid of ['"unknown"', "{}", "null", "invalid JSON"]) {
      stored = invalid;
      assert.equal(readPullRequestMergeMethod(), "merge");
    }
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("Storage unavailable");
      },
    });
    assert.equal(readPullRequestMergeMethod(), "merge");
    savePullRequestMergeMethod("squash");
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

it("resolves current, remembered and removed strategies against repository permissions", () => {
  assert.equal(
    resolvePullRequestMergeMethod(["squash", "merge", "rebase"], null, "merge"),
    "merge",
  );
  assert.equal(
    resolvePullRequestMergeMethod(
      ["squash", "merge", "rebase"],
      "rebase",
      "merge",
    ),
    "rebase",
  );
  assert.equal(
    resolvePullRequestMergeMethod(["squash", "merge"], "rebase", "merge"),
    "merge",
  );
  assert.equal(
    resolvePullRequestMergeMethod(["squash"], "rebase", "merge"),
    "squash",
  );
  assert.equal(resolvePullRequestMergeMethod([], "squash", "rebase"), "merge");
});

it("offers method preferences only for open ready non-conflicting stacks with a choice", () => {
  const detail = {
    snapshot: prReviewDetail.shape.snapshot.parse({
      nodeId: "PR42",
      title: "Middle",
      lifecycle: { kind: "open", draft: false },
      base: "main",
      head: "middle",
      headRepository: "fixture/project",
      headOid: "a".repeat(40),
      hostUpdatedAt: "2026-10-09T00:00:00Z",
    }),
    capabilities: prReviewDetail.shape.capabilities.parse({
      primary: "unavailable",
      actions: [],
      explanation: null,
      edit: false,
    }),
  };
  assert.equal(showsPullRequestMergeMethods(detail, ["merge", "squash"]), true);
  assert.equal(showsPullRequestMergeMethods(detail, ["merge"]), false);
  assert.equal(
    showsPullRequestMergeMethods(undefined, ["merge", "squash"]),
    false,
  );
  for (const lifecycle of [
    { kind: "open", draft: true },
    { kind: "closed", closedAt: null },
    { kind: "merged", mergedAt: null },
  ]) {
    assert.equal(
      showsPullRequestMergeMethods(
        {
          ...detail,
          snapshot: {
            ...detail.snapshot,
            lifecycle:
              prReviewDetail.shape.snapshot.shape.lifecycle.parse(lifecycle),
          },
        },
        ["merge", "squash"],
      ),
      false,
    );
  }
  assert.equal(
    showsPullRequestMergeMethods(
      {
        ...detail,
        capabilities: { ...detail.capabilities, primary: "resolve_conflicts" },
      },
      ["merge", "squash"],
    ),
    false,
  );
});

it("renders T3 labels, radio states and row classes while a preference click only selects", () => {
  let selected: MergeMethod = "merge";
  const props = {
    allowed: ["merge", "squash", "rebase"],
    selected,
    pending: false,
    onSelect(method: MergeMethod) {
      selected = method;
    },
  } satisfies Parameters<typeof PullRequestMergeMethods>[0];
  const html = renderToStaticMarkup(
    createElement(PullRequestMergeMethods, props),
  );
  for (const value of [
    "Merge",
    "Squash and merge",
    "Rebase and merge",
    "flex min-w-0 items-center gap-2",
    "size-3.5",
    "data-checked:bg-foreground/[0.08]",
    'data-slot="menu-radio-group"',
  ])
    assert.ok(html.includes(value), value);
  assert.equal((html.match(/aria-checked="true"/g) ?? []).length, 1);
  assert.equal((html.match(/aria-checked="false"/g) ?? []).length, 2);
  const tree = PullRequestMergeMethods(props);
  const radio = Children.toArray(tree.props.children)[2];
  assert.ok(isValidElement<{ onClick: () => void }>(radio));
  let nativeActions = 0;
  const originalStackChange = ipc.changePullRequestStack;
  const originalChange = ipc.changePullRequest;
  const unexpectedNativeChange = async () => {
    nativeActions++;
    throw new Error("Method selection must not submit a mutation");
  };
  ipc.changePullRequestStack = unexpectedNativeChange;
  ipc.changePullRequest = unexpectedNativeChange;
  try {
    radio.props.onClick();
    assert.equal(nativeActions, 0);
  } finally {
    ipc.changePullRequestStack = originalStackChange;
    ipc.changePullRequest = originalChange;
  }
  assert.equal(selected, "rebase");
  const updated = renderToStaticMarkup(
    createElement(PullRequestMergeMethods, {
      ...props,
      selected,
      pending: true,
    }),
  );
  assert.equal((updated.match(/disabled=""/g) ?? []).length, 3);
  const checked = updated.match(
    /<button[^>]*aria-checked="true"[^>]*>[\s\S]*?<\/button>/,
  )?.[0];
  assert.ok(checked?.includes("Rebase and merge"));
  assert.ok(!checked?.includes("Squash and merge"));
});

it("uses the selected strategy in stack confirmation and captured native input", () => {
  const target = prObservation.parse({
    key: "github.com/fixture/project/42",
    nodeId: "PR42",
    headOid: "b".repeat(40),
    viewer: "fixture",
  });
  const stack = pullRequestStack.parse({
    id: "50",
    number: 50,
    url: "https://github.com/fixture/project/stacks/50",
    base: "main",
    capabilities: {
      mergeMethods: ["merge", "squash", "rebase"],
      canRebase: true,
    },
    layers: [
      {
        number: 41,
        headBranch: "bottom",
        state: "open",
        isDraft: false,
        headSha: "a".repeat(40),
      },
      {
        number: 42,
        headBranch: "middle",
        state: "open",
        isDraft: false,
        headSha: target.headOid,
      },
    ],
  });
  const reference = { key: target.key, number: 42 };
  for (const method of stack.capabilities.mergeMethods) {
    const html = renderToStaticMarkup(
      createElement(PullRequestStackConfirmation, {
        stack,
        reference,
        confirmation: "merge",
        mergeMethod: method,
        pending: false,
        setConfirmation() {},
        run() {},
      }),
    );
    assert.ok(html.includes(`into main using ${method}.`));
    const input = stackActionInput({
      stack,
      reference,
      target,
      requestId: "confirmation",
      action: { kind: "merge", method },
    });
    assert.deepEqual(input.action, { kind: "merge", method });
  }
});
