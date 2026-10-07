import assert from "node:assert/strict";
import { it } from "node:test";
import {
  currentSearchResponse,
  searchRequestKey,
  type SearchState,
} from "./projectSearch";

it("accepts rows only from the current checkout, query, options and refresh generation", () => {
  const checkout = { workspaceId: "project", threadId: "worktree" };
  const request = { kind: "paths", query: "first", limit: 50 } as const;
  const key = searchRequestKey(checkout, request);
  const state: SearchState = {
    kind: "ready",
    key,
    response: {
      kind: "paths",
      value: {
        paths: ["first.txt"],
        indexedFiles: 1,
        generation: 2,
        truncated: false,
        indexCoverage: { kind: "complete" },
      },
    },
  };
  assert.equal(currentSearchResponse(state, key)?.kind, "paths");
  assert.equal(
    currentSearchResponse(
      state,
      searchRequestKey(checkout, { ...request, query: "second" }),
    ),
    null,
  );
  assert.equal(
    currentSearchResponse(
      state,
      searchRequestKey({ ...checkout, threadId: "other" }, request),
    ),
    null,
  );
  assert.equal(
    currentSearchResponse(state, searchRequestKey(checkout, request, 1)),
    null,
  );
  assert.equal(
    currentSearchResponse(
      state,
      searchRequestKey(checkout, {
        kind: "content",
        query: "first",
        caseSensitive: true,
        wholeWord: false,
        useRegex: false,
      }),
    ),
    null,
  );
  assert.equal(
    currentSearchResponse({ kind: "error", key, message: "No files" }, key),
    null,
  );
});
