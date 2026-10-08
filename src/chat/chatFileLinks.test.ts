import assert from "node:assert/strict";
import { it } from "node:test";
import { parseChatFileLink } from "./chatFileLinks";

const files = new Set(["src/main.ts", "docs/read me.md"]);
const root = "/Users/me/project";
const href = (raw: string, threadId: string | null = "thread") =>
  parseChatFileLink(raw, {
    files,
    root,
    source: "href",
    threadId: threadId ?? undefined,
  });
const code = (raw: string) =>
  parseChatFileLink(raw, { files, root, source: "code", threadId: "thread" });

it("reads line and column suffixes from workspace paths", () => {
  assert.deepEqual(code("src/main.ts:12"), {
    kind: "workspace",
    path: "src/main.ts",
    line: 12,
  });
  assert.deepEqual(code("./src/main.ts:12:3"), {
    kind: "workspace",
    path: "src/main.ts",
    line: 12,
    column: 3,
  });
  assert.deepEqual(href("src/main.ts#L12"), {
    kind: "workspace",
    path: "src/main.ts",
    line: 12,
  });
  assert.deepEqual(href("src/main.ts#L12C4-L20"), {
    kind: "workspace",
    path: "src/main.ts",
    line: 12,
    column: 4,
  });
  assert.deepEqual(code("src/main.ts"), {
    kind: "workspace",
    path: "src/main.ts",
  });
});

it("maps absolute and file URL paths inside the checkout to workspace links", () => {
  assert.deepEqual(href("file:///Users/me/project/src/main.ts:7"), {
    kind: "workspace",
    path: "src/main.ts",
    line: 7,
  });
  assert.deepEqual(code("/Users/me/project/src/main.ts"), {
    kind: "workspace",
    path: "src/main.ts",
  });
  assert.deepEqual(href("/Users/me/project/docs/read%20me.md"), {
    kind: "workspace",
    path: "docs/read me.md",
  });
});

it("makes absolute hrefs outside the checkout external links of a sent thread", () => {
  assert.deepEqual(href("/Users/me/other/lib%20x.rs:40:2"), {
    kind: "external",
    threadId: "thread",
    path: "/Users/me/other/lib x.rs",
    line: 40,
    column: 2,
  });
  assert.deepEqual(href("file:///etc/hosts"), {
    kind: "external",
    threadId: "thread",
    path: "/etc/hosts",
  });
  assert.equal(href("/Users/me/other/lib.rs", null), null);
  assert.equal(code("/Users/me/other/lib.rs"), null);
  assert.equal(href("src/missing.ts"), null);
  assert.equal(code("origin/main"), null);
});

it("drops a zero line, which no editor accepts", () => {
  assert.deepEqual(code("src/main.ts:0"), {
    kind: "workspace",
    path: "src/main.ts",
  });
  assert.deepEqual(code("src/main.ts:4:0"), {
    kind: "workspace",
    path: "src/main.ts",
    line: 4,
  });
});

it("resolves Windows paths inside the checkout regardless of case and separator", () => {
  const windows = (raw: string, source: "code" | "href" = "code") =>
    parseChatFileLink(raw, {
      files,
      root: "C:\\Users\\me\\project",
      source,
      threadId: "thread",
    });
  assert.deepEqual(windows("C:\\Users\\me\\project\\src\\main.ts:12"), {
    kind: "workspace",
    path: "src/main.ts",
    line: 12,
  });
  assert.deepEqual(windows("c:/users/me/project/src/main.ts"), {
    kind: "workspace",
    path: "src/main.ts",
  });
  assert.deepEqual(windows("file:///C:/Users/me/project/src/main.ts", "href"), {
    kind: "workspace",
    path: "src/main.ts",
  });
  assert.deepEqual(windows("src\\main.ts"), {
    kind: "workspace",
    path: "src/main.ts",
  });
  assert.deepEqual(windows("C:\\Users\\me\\other\\lib.rs", "href"), {
    kind: "external",
    threadId: "thread",
    path: "C:\\Users\\me\\other\\lib.rs",
  });
  assert.equal(windows("C:\\Users\\me\\project-two\\src\\main.ts"), null);
});
