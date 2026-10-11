import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Attachment, Thread } from "../ipc";
import { Timeline } from "./Timeline";

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    __TAURI_INTERNALS__: {
      convertFileSrc: (path: string, protocol: string) =>
        `${protocol}://localhost/${path}`,
    },
  },
});

const attachments: Attachment[] = [
  {
    kind: "image",
    id: "a".repeat(64),
    mimeType: "image/png",
    name: "shot.png",
    sizeBytes: 12,
  },
  {
    kind: "file",
    id: "b".repeat(64),
    mimeType: "video/quicktime",
    name: "clip.mov",
    sizeBytes: 12,
    extension: "mov",
  },
  {
    kind: "file",
    id: "c".repeat(64),
    mimeType: "text/plain",
    name: "notes.txt",
    sizeBytes: 12,
    extension: "txt",
  },
];

const thread: Thread = {
  worktreeSetup: null,
  id: "018ba719-19f4-4fdb-bd79-aa4a676ea054",
  workspaceId: "018ba719-19f4-4fdb-bd79-aa4a676ea055",
  title: "Media",
  nativeThreadId: "native",
  revision: 1,
  session: { kind: "ready" },
  checkout: { kind: "local" },
  settings: {
    model: null,
    effort: null,
    permissionMode: "approval-required",
    interactionMode: "default",
  },
  context: null,
  approvals: [],
  userQuestions: [],
  diagnostic: null,
  pendingRevert: null,
  lastRevert: null,
  turns: [
    {
      id: "018ba719-19f4-4fdb-bd79-aa4a676ea056",
      kind: "prompt" as const,
      prompt: "Look",
      attachments,
      tasks: null,
      nativeTurnId: "native-turn",
      delivery: { kind: "accepted" },
      execution: { kind: "completed" },
      items: [],
      settings: null,
      startedAtMs: 0,
      completedAtMs: 1,
      checkpoint: { kind: "pending" },
    },
  ],
};

it("shows a sent image and video as media that open the preview, and other files as rows", () => {
  const markup = renderToStaticMarkup(
    createElement(Timeline, {
      skills: [],
      thread,
      clearance: 0,
      reverting: false,
      busy: false,
      onEdit() {},
      onExpandImage() {},
      onRemoveQueued() {},
      onOpenTurnDiff() {},
    }),
  );
  assert.ok(markup.includes('aria-label="Preview shot.png"'));
  assert.ok(markup.includes('aria-label="Play clip.mov"'));
  assert.ok(
    markup.includes(
      `<video src="botcode-attachment://localhost/${"b".repeat(64)}.mov"`,
    ),
  );
  assert.ok(markup.includes(">notes.txt<"));
  assert.ok(!markup.includes(">clip.mov<"));
});
