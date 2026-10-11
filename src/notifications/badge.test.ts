import assert from "node:assert/strict";
import { it } from "node:test";
import { notificationBadgeLabel, PendingNotifications } from "./badge";

const first = { workspaceId: "workspace-a", threadId: "thread-1" };
const second = { workspaceId: "workspace-a", threadId: "thread-2" };
const other = { workspaceId: "workspace-b", threadId: "thread-3" };

it("counts a thread once however many notifications it fires", () => {
  const pending = new PendingNotifications("notifications");
  pending.delivered(first);
  pending.delivered(first);
  assert.equal(pending.count, 1);
  pending.delivered(second);
  assert.equal(pending.count, 2);
});

it("clears every pending notification when the window gains focus", () => {
  const pending = new PendingNotifications("notifications-and-sound");
  pending.delivered(first);
  pending.delivered(other);
  assert.deepEqual(pending.clear(), [
    "workspace-a:thread-1",
    "workspace-b:thread-3",
  ]);
  assert.equal(pending.count, 0);
  pending.delivered(second);
  assert.equal(pending.count, 1);
});

for (const mode of ["sound", "off"] as const)
  it(`clears and stops counting when the mode becomes ${mode}`, () => {
    const pending = new PendingNotifications("notifications");
    pending.delivered(first);
    assert.deepEqual(pending.setMode(mode), ["workspace-a:thread-1"]);
    assert.equal(pending.count, 0);
    pending.delivered(second);
    assert.equal(pending.count, 0);
  });

it("drops only threads whose project was removed", () => {
  const pending = new PendingNotifications("notifications");
  pending.delivered(first);
  pending.delivered(other);
  assert.deepEqual(pending.retainWorkspaces(["workspace-b"]), [
    "workspace-a:thread-1",
  ]);
  assert.equal(pending.count, 1);
  assert.deepEqual(pending.retainWorkspaces(["workspace-b"]), []);
  assert.deepEqual(pending.retainWorkspaces([]), ["workspace-b:thread-3"]);
  assert.equal(pending.count, 0);
});

it("labels the Windows overlay 9+ above nine", () => {
  assert.deepEqual(notificationBadgeLabel(1), { text: "1", fontSize: 40 });
  assert.deepEqual(notificationBadgeLabel(9), { text: "9", fontSize: 40 });
  assert.deepEqual(notificationBadgeLabel(10), { text: "9+", fontSize: 30 });
});
