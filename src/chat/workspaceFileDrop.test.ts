// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/chat/workspaceFileDrop.test.ts (MIT), with folders skipped.
import assert from "node:assert/strict";
import { it } from "node:test";
import {
  makeWorkspaceFileDropHandlers,
  type WorkspaceFileDragEvent,
} from "./workspaceFileDrop";

function makeDragEvent(options?: {
  types?: string[];
  files?: File[];
  items?: NonNullable<WorkspaceFileDragEvent["dataTransfer"]["items"]>;
  movedWithinTarget?: boolean;
}) {
  let prevented = 0;
  const event = {
    dataTransfer: {
      types: options?.types ?? ["Files"],
      files: options?.files ?? [],
      dropEffect: "none",
      ...(options?.items === undefined ? {} : { items: options.items }),
    },
    relatedTarget: options?.movedWithinTarget ? ({} as EventTarget) : null,
    currentTarget: {
      contains: () => options?.movedWithinTarget ?? false,
    },
    preventDefault: () => {
      prevented += 1;
    },
  } satisfies WorkspaceFileDragEvent;
  return { event, prevented: () => prevented };
}

function makeHost() {
  const active: boolean[] = [];
  const added: File[][] = [];
  return {
    host: {
      setDragActive: (value: boolean) => active.push(value),
      addFiles: (files: File[]) => added.push(files),
    },
    active,
    added,
  };
}

const entry = (file: File, isDirectory: boolean) => ({
  kind: "file",
  getAsFile: () => file,
  webkitGetAsEntry: () => ({ isDirectory }),
});

it("activates the target for an external file drag", () => {
  const { host, active } = makeHost();
  const { event, prevented } = makeDragEvent();
  makeWorkspaceFileDropHandlers(host).onDragEnter(event);
  assert.equal(prevented(), 1);
  assert.deepEqual(active, [true]);
});

it("ignores non-file drags", () => {
  const { host, active } = makeHost();
  const { event, prevented } = makeDragEvent({ types: ["text/plain"] });
  makeWorkspaceFileDropHandlers(host).onDragOver(event);
  assert.equal(prevented(), 0);
  assert.deepEqual(active, []);
  assert.equal(event.dataTransfer.dropEffect, "none");
});

it("does not flicker when the drag moves between children", () => {
  const { host, active } = makeHost();
  const { event } = makeDragEvent({ movedWithinTarget: true });
  const handlers = makeWorkspaceFileDropHandlers(host);
  handlers.onDragEnter(event);
  handlers.onDragLeave(event);
  assert.deepEqual(active, []);
});

it("forwards dropped files and clears the active state", () => {
  const file = new File(["contents"], "shot.png", { type: "image/png" });
  const { host, active, added } = makeHost();
  const { event } = makeDragEvent({ files: [file] });
  makeWorkspaceFileDropHandlers(host).onDrop(event);
  assert.deepEqual(active, [false]);
  assert.deepEqual(added, [[file]]);
});

it("skips dropped folders and keeps the files beside them", () => {
  const file = new File(["contents"], "shot.png", { type: "image/png" });
  const folder = new File([], "project", { type: "" });
  const { host, added } = makeHost();
  const { event } = makeDragEvent({
    items: [entry(folder, true), entry(file, false)],
  });
  makeWorkspaceFileDropHandlers(host).onDrop(event);
  assert.deepEqual(added, [[file]]);
});

it("adds nothing for a folder-only drop", () => {
  const folder = new File([], "project", { type: "" });
  const { host, active, added } = makeHost();
  const { event } = makeDragEvent({ items: [entry(folder, true)] });
  makeWorkspaceFileDropHandlers(host).onDrop(event);
  assert.deepEqual(active, [false]);
  assert.deepEqual(added, []);
});
