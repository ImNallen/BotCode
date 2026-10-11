import assert from "node:assert/strict";
import { it } from "node:test";
import { surfaceTitle } from "../panel/panelState.ts";
import { applyTerminalLabels, readTerminalLabel } from "./terminalLabels.ts";
import { terminalScopeKey } from "./terminalState.ts";

const thread = terminalScopeKey("w", "t");
const draft = terminalScopeKey("w", null);
const vim = { workspaceId: "w", threadId: "t", terminalId: "term-1" };

it("names a terminal after its command and falls back to Terminal N", () => {
  applyTerminalLabels({
    sequence: 2,
    labels: [
      { ...vim, label: "vim" },
      { workspaceId: "w", threadId: null, terminalId: "term-2", label: "node" },
    ],
  });
  assert.equal(readTerminalLabel(thread, "term-1"), "vim");
  assert.equal(readTerminalLabel(thread, "term-2"), "Terminal 2");
  assert.equal(readTerminalLabel(draft, "term-1"), "Terminal 1");
  assert.equal(readTerminalLabel(draft, "term-2"), "node");

  applyTerminalLabels({ sequence: 1, labels: [] });
  assert.equal(
    readTerminalLabel(thread, "term-1"),
    "vim",
    "An older snapshot, such as a slow seed, is ignored",
  );
  applyTerminalLabels({ sequence: "4", labels: [] });
  applyTerminalLabels(null);
  assert.equal(readTerminalLabel(thread, "term-1"), "vim");

  applyTerminalLabels({ sequence: 3, labels: [] });
  assert.equal(readTerminalLabel(thread, "term-1"), "Terminal 1");
  assert.equal(readTerminalLabel(draft, "term-2"), "Terminal 2");
});

it("titles a terminal tab with its active terminal's command", () => {
  applyTerminalLabels({ sequence: 10, labels: [{ ...vim, label: "vim" }] });
  const panel = {
    id: "terminal:term-1" as const,
    terminalIds: ["term-1", "term-2"],
    activeTerminalId: "term-1",
  };
  const labelFor = (terminalId: string) =>
    readTerminalLabel(thread, terminalId);
  assert.equal(
    surfaceTitle({ kind: "terminal", id: panel.id }, [panel], labelFor),
    "vim",
  );
  assert.equal(
    surfaceTitle(
      { kind: "terminal", id: panel.id },
      [{ ...panel, activeTerminalId: "term-2" }],
      labelFor,
    ),
    "Terminal 2",
  );
});
