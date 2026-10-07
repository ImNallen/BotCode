import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { checkoutKey, type CheckoutRef } from "../ipc";
import { mockIpc } from "../test/mockIpc";
import { settle } from "../test/timers";
import {
  confirmFileDraft,
  fileQuery,
  readFileDraft,
  readPendingFiles,
  setFileDraft,
  setFilePending,
} from "./fileDrafts";

const checkout: CheckoutRef = { workspaceId: "workspace", threadId: "thread" };
const text = (contents: string) => ({ kind: "text", name: "file", contents });
let readFile: (path: string) => unknown;
let restoreIpc = () => {};

describe("file drafts", () => {
  beforeEach(() => {
    readFile = (path) => {
      throw new Error(`Unexpected read of ${path}`);
    };
    restoreIpc = mockIpc((command, args) => {
      if (command === "read_file")
        return readFile((args as { path: string }).path);
      throw new Error(`Unexpected command ${command}`);
    });
  });
  afterEach(() => restoreIpc());

  it("an overlay masks a refetch that returns different disk text", async () => {
    const client = new QueryClient();
    const path = "masked.txt";
    readFile = () => text("agent edit");
    setFileDraft(checkout, path, "my edit");

    await client.fetchQuery(fileQuery(checkout, path));

    assert.deepEqual(
      client.getQueryData(fileQuery(checkout, path).queryKey),
      text("agent edit"),
    );
    assert.deepEqual(readFileDraft(checkout, path), {
      contents: "my edit",
      confirmed: false,
    });
  });

  it("a confirmed overlay clears after a successful refetch", async () => {
    const client = new QueryClient();
    const path = "confirmed.txt";
    const diffKey = [...checkoutKey("diff", checkout), path, "unstaged"];
    client.setQueryData(checkoutKey("workspace", checkout), {});
    client.setQueryData(diffKey, {});
    readFile = () => text("saved");
    setFileDraft(checkout, path, "saved");

    assert.equal(confirmFileDraft(client, checkout, path, "saved"), true);
    assert.deepEqual(readFileDraft(checkout, path), {
      contents: "saved",
      confirmed: true,
    });
    await settle();

    assert.equal(readFileDraft(checkout, path), undefined);
    assert.deepEqual(
      client.getQueryData(fileQuery(checkout, path).queryKey),
      text("saved"),
    );
    assert.equal(
      client.getQueryState(checkoutKey("workspace", checkout))?.isInvalidated,
      true,
    );
    assert.equal(client.getQueryState(diffKey)?.isInvalidated, true);
  });

  it("a newer edit made during the confirm refetch is not cleared", async () => {
    const client = new QueryClient();
    const path = "newer.txt";
    let finishRead = () => {};
    readFile = () =>
      new Promise((resolve) => {
        finishRead = () => resolve(text("saved"));
      });
    setFileDraft(checkout, path, "saved");

    assert.equal(confirmFileDraft(client, checkout, path, "saved"), true);
    await settle();
    setFileDraft(checkout, path, "newer");
    finishRead();
    await settle();

    assert.deepEqual(readFileDraft(checkout, path), {
      contents: "newer",
      confirmed: false,
    });
  });

  it("a failed refetch keeps the overlay", async () => {
    const client = new QueryClient();
    const path = "failed.txt";
    readFile = () => {
      throw { code: "io", message: "disk unavailable" };
    };
    setFileDraft(checkout, path, "saved");

    assert.equal(confirmFileDraft(client, checkout, path, "saved"), true);
    await settle();

    assert.deepEqual(readFileDraft(checkout, path), {
      contents: "saved",
      confirmed: true,
    });
  });

  it("confirm with stale contents returns false", async () => {
    const client = new QueryClient();
    const path = "stale.txt";
    let reads = 0;
    readFile = () => {
      reads += 1;
      return text("older");
    };
    setFileDraft(checkout, path, "newer");

    assert.equal(confirmFileDraft(client, checkout, path, "older"), false);
    await settle();

    assert.equal(reads, 0);
    assert.deepEqual(readFileDraft(checkout, path), {
      contents: "newer",
      confirmed: false,
    });
  });

  it("a read started before the write cannot confirm it", async () => {
    const client = new QueryClient();
    const path = "raced.txt";
    let finishEarlyRead = () => {};
    let reads = 0;
    readFile = () => {
      reads += 1;
      if (reads > 1) return text("saved");
      return new Promise((resolve) => {
        finishEarlyRead = () => resolve(text("before save"));
      });
    };
    const earlyRead = client
      .fetchQuery(fileQuery(checkout, path))
      .catch(() => undefined);
    await settle();
    setFileDraft(checkout, path, "saved");

    assert.equal(confirmFileDraft(client, checkout, path, "saved"), true);
    await settle();
    finishEarlyRead();
    await earlyRead;
    await settle();

    assert.equal(readFileDraft(checkout, path), undefined);
    assert.deepEqual(
      client.getQueryData(fileQuery(checkout, path).queryKey),
      text("saved"),
    );
  });

  it("keeps pending paths per checkout", () => {
    const other: CheckoutRef = { workspaceId: "workspace" };
    setFilePending(checkout, "pending.txt", true);
    setFilePending(other, "pending.txt", true);
    setFilePending(checkout, "pending.txt", false);

    assert.deepEqual([...readPendingFiles(checkout)], []);
    assert.deepEqual([...readPendingFiles(other)], ["pending.txt"]);
  });
});
