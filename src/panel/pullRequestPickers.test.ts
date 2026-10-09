import assert from "node:assert/strict";
import { it } from "node:test";
import { Children, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PullRequestCandidatePicker } from "./PullRequestCandidatePicker";
import {
  candidateKeyboardIndex,
  matchesLabelCandidate,
  matchesReviewerCandidate,
  toggleLabel,
  toggleReviewer,
  pickerFailureTitle,
  pickerSuccessTitle,
} from "./pullRequestPickers.logic";
import {
  prLabelCandidate,
  prReviewerCandidate,
  prCandidates,
} from "./prReview";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { ipc } from "../ipc";
import { prObservation } from "./prReview";

const label = prLabelCandidate.parse({
  name: "needs/design",
  color: "abcdef",
  description: "Discuss the interface",
  isApplied: true,
});
const reviewer = prReviewerCandidate.parse({
  id: "design-team",
  kind: "team",
  login: "design-team",
  name: "Design People",
  avatarUrl: null,
  isRequested: true,
});
it("searches candidate names and descriptions locally and keeps requested state until host confirmation", () => {
  assert.equal(matchesLabelCandidate(label, "INTERFACE"), true);
  assert.equal(matchesLabelCandidate(label, "other"), false);
  assert.equal(matchesReviewerCandidate(reviewer, "people"), true);
  assert.equal(matchesReviewerCandidate(reviewer, "nobody"), false);
  const action = toggleLabel(label);
  assert.equal(action.applied, false);
  assert.equal(label.isApplied, true);
  assert.equal(pickerFailureTitle(action), "Could not take needs/design off");
  assert.equal(pickerSuccessTitle(action), undefined);
  const request = toggleReviewer(reviewer);
  assert.deepEqual(request, {
    kind: "request_reviewer",
    id: "design-team",
    reviewerKind: "team",
    requested: false,
  });
  assert.equal(reviewer.isRequested, true);
  assert.equal(
    pickerFailureTitle(request),
    "Could not take back the review request to design-team",
  );
  assert.equal(
    pickerSuccessTitle(request),
    "Review request to design-team taken back",
  );
});
it("picker selection leaves its search open and focused; disabled rows ignore clicks and Enter", () => {
  for (const disabled of [false, true]) {
    let changed = 0,
      selected = 0,
      focused = 0,
      prevented = 0;
    function Capture() {
      const tree = PullRequestCandidatePicker({
        icon: null,
        label: "Change labels",
        allowed: true,
        disabledReason:
          "Changing labels needs triage access on this repository",
        open: true,
        onOpenChange: () => changed++,
        query: "design",
        onQueryChange: () => {},
        searchLabel: "Search labels",
        isPending: false,
        error: null,
        candidates: [label],
        emptyLabel: "Empty",
        noMatchLabel: "No match",
        errorLabel: "Unavailable",
        truncated: false,
        truncatedLabel: "More",
        candidateKey: (row) => row.name,
        disabled,
        onSelect: () => selected++,
        children: (row) => row.name,
      });
      const visit = (node: ReactNode): void =>
        Children.forEach(node, (child) => {
          if (
            !isValidElement<{
              children?: ReactNode;
              role?: string;
              ref?: object;
              onClick?: () => void;
              onKeyDown?: (event: {
                key: string;
                nativeEvent: { isComposing: boolean };
                preventDefault: () => void;
              }) => void;
            }>(child)
          )
            return;
          if (child.type === "input") {
            if (child.props.ref)
              Object.defineProperty(child.props.ref, "current", {
                value: { focus: () => focused++ },
                writable: true,
              });
            child.props.onKeyDown?.({
              key: "Enter",
              nativeEvent: { isComposing: false },
              preventDefault: () => prevented++,
            });
            child.props.onKeyDown?.({
              key: "Enter",
              nativeEvent: { isComposing: true },
              preventDefault: () => prevented++,
            });
          }
          if (child.props.role === "option") child.props.onClick?.();
          visit(child.props.children);
        });
      visit(tree);
      return null;
    }
    renderToStaticMarkup(createElement(Capture));
    assert.equal(changed, 0);
    assert.equal(selected, disabled ? 0 : 2);
    assert.equal(focused, 1);
    assert.equal(prevented, 1);
  }
  assert.equal(candidateKeyboardIndex("ArrowUp", 0, 3), 2);
  assert.equal(candidateKeyboardIndex("ArrowDown", 2, 3), 0);
  assert.equal(candidateKeyboardIndex("Home", 2, 3), 0);
  assert.equal(candidateKeyboardIndex("End", 0, 3), 2);
  assert.equal(candidateKeyboardIndex("ArrowDown", 0, 0), undefined);
});
it("keeps denied controls visible with the source permission reason", () => {
  const markup = renderToStaticMarkup(
    createElement(PullRequestCandidatePicker, {
      icon: null,
      label: "Change labels",
      allowed: false,
      disabledReason: "Changing labels needs triage access on this repository",
      open: false,
      onOpenChange: () => {},
      query: "",
      onQueryChange: () => {},
      searchLabel: "Search labels",
      isPending: false,
      error: null,
      candidates: [],
      emptyLabel: "Empty",
      noMatchLabel: "No match",
      errorLabel: "Unavailable",
      truncated: false,
      truncatedLabel: "More",
      candidateKey: () => "",
      disabled: false,
      onSelect: () => {},
      children: () => null,
    }),
  );
  assert.match(markup, /disabled=""/);
  assert.match(markup, /Change labels/);
  assert.match(
    markup,
    /Changing labels needs triage access on this repository/,
  );
});
it("candidate IPC keeps global access typed, requests only the chosen list and surfaces read refusal", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { crypto: globalThis.crypto },
  });
  const target = prObservation.parse({
    key: "github.com/fixture/project/42",
    nodeId: "PR_42",
    headOid: "a".repeat(40),
    viewer: "viewer",
  });
  const calls: unknown[] = [];
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === "read_pull_request_candidates")
      return prCandidates.parse({
        labels: [label],
        reviewers: [],
        truncated: true,
      });
    throw new Error("Unexpected command");
  });
  try {
    const result = await ipc.readPullRequestCandidates(
      { workspaceId: "11111111-1111-4111-8111-111111111111" },
      target,
      "labels",
    );
    assert.equal(result.truncated, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      command: "read_pull_request_candidates",
      args: {
        threadId: { workspaceId: "11111111-1111-4111-8111-111111111111" },
        target,
        kind: "labels",
      },
    });
    mockIPC(() => {
      throw new Error("Fixture labels unavailable");
    });
    await assert.rejects(
      ipc.readPullRequestCandidates("thread", target, "labels"),
      /Fixture labels unavailable/,
    );
  } finally {
    clearMocks();
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

it("retains stale evidence after an uncertain change and failed candidate refresh, locks selection, and recovers through Retry", async () => {
  const { QueryClient, QueryObserver } = await import("@tanstack/react-query");
  const { candidateReadState } = await import("./pullRequestPickers.logic");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const queryKey = ["pr-candidates", "uncertainty"];
  const before = { ...label, isApplied: false };
  let readFails = true,
    writes = 1;
  const actions: ReturnType<typeof toggleLabel>[] = [];
  client.setQueryData(queryKey, {
    labels: [before],
    reviewers: [],
    truncated: false,
  });
  const observer = new QueryObserver(client, {
    queryKey,
    staleTime: Infinity,
    retry: false,
    queryFn: async () => {
      if (readFails) throw new Error("Fixture labels unavailable");
      return {
        labels: [{ ...label, isApplied: true }],
        reviewers: [],
        truncated: false,
      };
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    await client.invalidateQueries({ queryKey });
    let state = observer.getCurrentResult();
    const failure = candidateReadState(state);
    assert.equal(state.data?.labels[0]?.isApplied, false);
    assert.equal(failure.error, "Fixture labels unavailable");
    assert.equal(failure.locked, true);
    function interact(result: ReturnType<typeof observer.getCurrentResult>) {
      const read = candidateReadState(result);
      let visibleError = "",
        carriedRow = false;
      function Capture() {
        const tree = PullRequestCandidatePicker({
          icon: null,
          label: "Change labels",
          allowed: true,
          disabledReason: "Reason",
          open: true,
          onOpenChange: () => {
            throw new Error("selection closed search");
          },
          query: "",
          onQueryChange: () => {},
          searchLabel: "Search labels",
          isPending: false,
          error: read.error,
          onRetry: () => void observer.refetch(),
          candidates: result.data?.labels ?? [],
          emptyLabel: "Empty",
          noMatchLabel: "No match",
          errorLabel: "The labels could not be read.",
          truncated: false,
          truncatedLabel: "More",
          candidateKey: (row) => row.name,
          disabled: read.locked,
          onSelect: (row) => {
            writes++;
            actions.push(toggleLabel(row));
          },
          children: (row) => (row.isApplied ? "Applied" : "Not applied"),
        });
        const visit = (node: ReactNode): void =>
          Children.forEach(node, (child) => {
            if (typeof child === "string") visibleError += child;
            if (
              !isValidElement<{
                children?: ReactNode;
                role?: string;
                onClick?: () => void;
                onKeyDown?: (event: {
                  key: string;
                  nativeEvent: { isComposing: boolean };
                  preventDefault: () => void;
                }) => void;
              }>(child)
            )
              return;
            if (child.props.role === "option") {
              carriedRow = true;
              child.props.onClick?.();
            }
            if (child.type === "input")
              child.props.onKeyDown?.({
                key: "Enter",
                nativeEvent: { isComposing: false },
                preventDefault: () => {},
              });
            visit(child.props.children);
          });
        visit(tree);
        return null;
      }
      renderToStaticMarkup(createElement(Capture));
      return { visibleError, carriedRow };
    }
    const carried = interact(state);
    assert.equal(carried.carriedRow, true);
    assert.match(
      carried.visibleError,
      /The labels could not be read.*Fixture labels unavailable/,
    );
    assert.equal(writes, 1);
    readFails = false;
    await observer.refetch();
    state = observer.getCurrentResult();
    assert.equal(state.data?.labels[0]?.isApplied, true);
    assert.equal(candidateReadState(state).locked, false);
    interact(state);
    assert.equal(writes, 3);
    assert.deepEqual(
      actions.map((action) => action.applied),
      [false, false],
    );
  } finally {
    unsubscribe();
    client.clear();
  }
});
