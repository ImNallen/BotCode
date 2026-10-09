import assert from "node:assert/strict";
import { it } from "node:test";
import { act, createElement } from "react";
import { hydratePartialDiff } from "@pierre/diffs";
import {
  createNullReactRoot,
  installNullReactDOM,
} from "../test/nullReactRoot.mjs";
import { usePullRequestDiffFileContents } from "./usePullRequestDiffFileContents";
import { pullRequestCodeFile } from "./pullRequestDiff";
import type { PrFileContents, PrReviewDetail } from "./prReview";

const file: PrReviewDetail["files"][number] = {
  path: "file.ts",
  previousPath: null,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -2 +2 @@\n-old\n+new",
  unavailable: null,
  anchors: [],
  contentsSource: {
    id: "source-1",
    oldOid: "b".repeat(40),
    newOid: "a".repeat(40),
  },
};
function diff() {
  const entry = pullRequestCodeFile(file);
  assert.equal(entry.kind, "diff");
  if (entry.kind !== "diff") throw new Error(entry.reason);
  return entry.fileDiff;
}
function deferred() {
  let reject: (error: Error) => void = () =>
    assert.fail("Uninitialized promise");
  const promise = new Promise<PrFileContents>((_, fail) => {
    reject = fail;
  });
  return { promise, reject };
}

it("context failure retains the readable patch and a separator retry clears the file warning", async () => {
  const restore = installNullReactDOM();
  const root = createNullReactRoot();
  const files = [file];
  let attempts = 0;
  const load = async () => {
    if (++attempts === 1) throw new Error("GitHub content unavailable");
    return {
      oldContents: "first\nold\nlast\n",
      newContents: "first\nnew\nlast\n",
    };
  };
  let latest: ReturnType<typeof usePullRequestDiffFileContents> | undefined;
  function Reader() {
    latest = usePullRequestDiffFileContents(load, files, "all");
    return null;
  }
  const view = () => {
    assert.ok(latest);
    return latest;
  };
  try {
    await act(async () => root.render(createElement(Reader)));
    const patch = diff();
    const original = structuredClone(patch);
    await act(async () => {
      const loader = view().loadDiffFiles;
      assert.ok(loader);
      await assert.rejects(loader(patch), /GitHub content unavailable/);
    });
    assert.equal(view().errors.get(file.path), "GitHub content unavailable");
    assert.deepEqual(patch, original);
    assert.deepEqual(patch.additionLines, ["new\n"]);
    await act(async () => {
      const contents = await view().loadDiffFiles?.(patch);
      assert.ok(contents);
      const hydrated = hydratePartialDiff("merge", patch, contents);
      assert.equal(hydrated.isPartial, false);
      assert.deepEqual(hydrated.additionLines, ["first\n", "new\n", "last\n"]);
    });
    assert.equal(attempts, 2);
    assert.equal(view().errors.size, 0);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

it("late content failures from an earlier source or scope cannot warn on the new comparison", async () => {
  const restore = installNullReactDOM();
  const root = createNullReactRoot();
  const pending = deferred();
  const load = () => pending.promise;
  let files = [file];
  let scope = "all";
  let latest: ReturnType<typeof usePullRequestDiffFileContents> | undefined;
  function Reader() {
    latest = usePullRequestDiffFileContents(load, files, scope);
    return null;
  }
  const view = () => {
    assert.ok(latest);
    return latest;
  };
  try {
    await act(async () => root.render(createElement(Reader)));
    const first = view().loadDiffFiles?.(diff());
    assert.ok(first);
    const observed = assert.rejects(first, /Old failure/);
    assert.ok(file.contentsSource);
    files = [
      { ...file, contentsSource: { ...file.contentsSource, id: "source-2" } },
    ];
    scope = "commit";
    await act(async () => root.render(createElement(Reader)));
    await act(async () => {
      pending.reject(new Error("Old failure"));
      await observed;
    });
    assert.equal(view().errors.size, 0);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});
