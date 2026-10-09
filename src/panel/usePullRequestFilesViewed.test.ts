import assert from "node:assert/strict";
import { it } from "node:test";
import { act, createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ipc } from "../ipc";
import {
  createNullReactRoot,
  installNullReactDOM,
} from "../test/nullReactRoot.mjs";
import {
  usePullRequestFilesViewed,
  type PullRequestFilesViewedView,
} from "./usePullRequestFilesViewed";
import {
  prObservation,
  type PrFileViewedState,
  type PrFilesViewed,
} from "./prReview";

const target = prObservation.parse({
  key: "github.com/test/repo/7",
  nodeId: "PR_fixture",
  headOid: "a".repeat(40),
  viewer: "reviewer",
});
function result(state: PrFileViewedState): PrFilesViewed {
  return { target, files: [{ path: "a.ts", state }], truncated: false };
}
function deferred<T>() {
  let resolve: (value: T) => void = () =>
    assert.fail("Promise was not initialized.");
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
const wait = (ms = 10) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

it("a remounted reader holds its tick over an initial old read and retires it on its own post-ack DISMISSED read", async () => {
  const restoreDOM = installNullReactDOM();
  const originalRead = ipc.readPullRequestFilesViewed;
  const originalWrite = ipc.setPullRequestFilesViewed;
  const reads: ReturnType<typeof deferred<PrFilesViewed>>[] = [];
  let writes = 0;
  ipc.readPullRequestFilesViewed = () => {
    const read = deferred<PrFilesViewed>();
    reads.push(read);
    return read.promise;
  };
  ipc.setPullRequestFilesViewed = async () => {
    writes++;
    return null;
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const first = createNullReactRoot();
  const second = createNullReactRoot();
  let latest: PullRequestFilesViewedView | undefined;
  function Reader() {
    latest = usePullRequestFilesViewed({
      threadId: "thread",
      target,
      paths: ["a.ts"],
    });
    return null;
  }
  const render = () =>
    createElement(QueryClientProvider, { client }, createElement(Reader));
  const view = () => {
    assert.ok(latest);
    return latest;
  };
  try {
    await act(async () => {
      first.render(render());
      await wait();
    });
    assert.equal(reads.length, 1);
    await act(async () => first.unmount());
    await act(async () => {
      second.render(render());
      await wait();
    });
    assert.equal(reads.length, 1);
    await act(async () => {
      view().setViewed("a.ts", true);
      await wait(420);
    });
    assert.equal(writes, 1);
    assert.equal(view().isViewed("a.ts"), true);
    assert.equal(reads.length, 1);
    await act(async () => {
      reads[0]?.resolve(result("dismissed"));
      await wait(30);
    });
    assert.equal(reads.length, 2);
    assert.equal(view().isViewed("a.ts"), true);
    assert.equal(view().isStale("a.ts"), false);
    await act(async () => {
      reads[1]?.resolve(result("dismissed"));
      await wait(30);
    });
    assert.equal(view().isViewed("a.ts"), false);
    assert.equal(view().isStale("a.ts"), true);
  } finally {
    await act(async () => second.unmount());
    client.clear();
    ipc.readPullRequestFilesViewed = originalRead;
    ipc.setPullRequestFilesViewed = originalWrite;
    restoreDOM();
  }
});

it("a failed owned write rolls back the checkbox and exposes the T3 failure message", async () => {
  const restoreDOM = installNullReactDOM();
  const originalRead = ipc.readPullRequestFilesViewed;
  const originalWrite = ipc.setPullRequestFilesViewed;
  ipc.readPullRequestFilesViewed = async () => result("unviewed");
  ipc.setPullRequestFilesViewed = async () => {
    throw new Error("Fixture refused mutation.");
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const root = createNullReactRoot();
  let latest: PullRequestFilesViewedView | undefined;
  function Reader() {
    latest = usePullRequestFilesViewed({
      threadId: "thread",
      target,
      paths: ["a.ts"],
    });
    return null;
  }
  const view = () => {
    assert.ok(latest);
    return latest;
  };
  try {
    await act(async () => {
      root.render(
        createElement(QueryClientProvider, { client }, createElement(Reader)),
      );
      await wait(30);
    });
    assert.equal(view().isViewed("a.ts"), false);
    await act(async () => view().setViewed("a.ts", true));
    assert.equal(view().isViewed("a.ts"), true);
    await act(async () => wait(420));
    assert.equal(view().isViewed("a.ts"), false);
    assert.equal(view().mutationError, "Could not update viewed files");
  } finally {
    await act(async () => root.unmount());
    client.clear();
    ipc.readPullRequestFilesViewed = originalRead;
    ipc.setPullRequestFilesViewed = originalWrite;
    restoreDOM();
  }
});
