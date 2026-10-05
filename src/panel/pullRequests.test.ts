import assert from "node:assert/strict";
import { it } from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { configurePullRequestQueries, type WorkspaceView } from "../ipc.ts";
import { pullRequestKey, type ThreadPrSummary } from "./pullRequests.ts";

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Promise not initialized");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const threadId = "00000000-0000-4000-8000-000000000001";
const workspaceId = "00000000-0000-4000-8000-000000000002";
function summary(sequence: number, linked: boolean): ThreadPrSummary {
  return {
    sequence,
    discovering: false,
    discoveryError: null,
    links: linked
      ? [
          {
            pr: {
              key: pullRequestKey.parse("github.com/fixture/project/41"),
              revision: 0,
              snapshot: null,
              freshness: { kind: "never_loaded" },
            },
            source: "git_created",
            linkedAt: 1,
          },
        ]
      : [],
  };
}
function workspace(
  pullRequests: ThreadPrSummary,
  branch: string,
): WorkspaceView {
  return {
    workspace: {
      id: workspaceId,
      root: "/repo",
      label: "Fixture",
      kind: "repository",
    },
    branch,
    files: [branch],
    changes: [],
    unavailable: null,
    threads: [
      {
        id: threadId,
        title: branch,
        session: { kind: "draft" },
        checkout: { kind: "local" },
        updatedAtMs: null,
        awaitingApproval: false,
        pinnedAtMs: null,
        snoozedUntilMs: null,
        settledAtMs: null,
        pullRequests,
      },
    ],
  };
}
for (const linked of [true, false]) {
  it(`late list response preserves a newer ${linked ? "link" : "unlink"}`, async () => {
    const client = new QueryClient();
    configurePullRequestQueries(client);
    const key = ["thread-prs", threadId];
    const old = summary(1, !linked);
    const current = summary(2, linked);
    const response = deferred<ThreadPrSummary>();
    const fetching = client.fetchQuery({
      queryKey: key,
      queryFn: () => response.promise,
    });
    client.setQueryData(key, current);
    response.resolve(old);
    await fetching;
    assert.deepEqual(client.getQueryData(key), current);
    client.clear();
  });
  for (const cachedWorkspace of [true, false]) {
    it(`late workspace response preserves ${linked ? "link" : "unlink"} and incoming files, cached=${cachedWorkspace}`, async () => {
      const client = new QueryClient();
      configurePullRequestQueries(client);
      const key = ["workspace", workspaceId, threadId];
      const old = summary(1, !linked);
      const current = summary(2, linked);
      if (cachedWorkspace) client.setQueryData(key, workspace(old, "before"));
      const response = deferred<WorkspaceView>();
      const fetching = client.fetchQuery({
        queryKey: key,
        queryFn: () => response.promise,
      });
      client.setQueryData(["thread-prs", threadId], current);
      if (cachedWorkspace) client.setQueryData(key, workspace(current, "hint"));
      response.resolve(workspace(old, "new-branch"));
      await fetching;
      assert.deepEqual(
        client.getQueryData(key),
        workspace(current, "new-branch"),
      );
      client.clear();
    });
  }
}
