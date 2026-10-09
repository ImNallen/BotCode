import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  closeSurface,
  eligibleSurfaces,
  openSurface,
  pullRequestSurface,
  reconcileTerminalSurfaces,
  surfaceTitle,
} from "./panelState.ts";
import { pullRequestKey, type ThreadPrSummary } from "./pullRequests.ts";
import type { PanelState, Surface } from "./RightPanel.tsx";

const emptyPanel: PanelState = { surfaces: [], active: null };

function links(...numbers: number[]): ThreadPrSummary["links"] {
  return numbers.map((number) => ({
    pr: {
      key: pullRequestKey.parse(`github.com/fixture/project/${number}`),
      revision: 0,
      snapshot: null,
      freshness: { kind: "never_loaded" },
    },
    source: "manual",
    linkedAt: number,
  }));
}

it("names the pull request action after the only linked PR", () => {
  assert.equal(surfaceTitle(pullRequestSurface(links(24))), "#24");
  assert.equal(surfaceTitle(pullRequestSurface(links())), "Pull requests");
  assert.equal(
    surfaceTitle(pullRequestSurface(links(24, 25))),
    "Pull requests",
  );
});

it("opens one tab per pull request and reuses an open one", () => {
  const [first, second] = links(24, 25).map(({ pr }) => ({
    kind: "pull_request" as const,
    key: pr.key,
  }));
  assert.ok(first && second);
  const both = openSurface(openSurface(emptyPanel, first), second);
  assert.deepEqual(
    both.surfaces.map((surface) => surfaceTitle(surface)),
    ["#24", "#25"],
  );
  assert.deepEqual(openSurface(both, first), { ...both, active: 0 });
});

it("keeps opened repository PR tabs until the conversation loses its last repository link", () => {
  const state = openSurface(emptyPanel, pullRequestSurface(links(24)));
  assert.deepEqual(eligibleSurfaces(state, true, links(24, 25)), state);
  assert.deepEqual(eligibleSurfaces(state, true, links(25)), state);
  assert.deepEqual(eligibleSurfaces(state, true, links()), emptyPanel);
  assert.deepEqual(eligibleSurfaces(state, true, undefined), emptyPanel);
});

it("keeps one Preview tab available without a checkout or PR links", () => {
  const preview: Surface = { kind: "preview" };
  const opened = openSurface(emptyPanel, preview);
  assert.equal(surfaceTitle(preview), "Preview");
  assert.deepEqual(eligibleSurfaces(opened, false), opened);
  assert.deepEqual(openSurface(opened, preview), opened);
  const withDiff = openSurface(opened, { kind: "diff" });
  assert.deepEqual(eligibleSurfaces(withDiff, false), {
    surfaces: [preview],
    active: null,
  });
});

describe("terminal tabs", () => {
  const files: Surface = { kind: "files" };
  const diff: Surface = { kind: "diff" };
  const terminal1: Surface = { kind: "terminal", id: "terminal:term-1" };
  const terminal2: Surface = { kind: "terminal", id: "terminal:term-2" };

  it("titles a terminal tab with its active terminal", () => {
    assert.equal(
      surfaceTitle(terminal1, [
        {
          id: "terminal:term-1",
          terminalIds: ["term-1", "term-2"],
          activeTerminalId: "term-2",
        },
      ]),
      "Terminal 2",
    );
    assert.equal(surfaceTitle(terminal1), "Terminal 1");
  });

  it("returns the same state when the tabs match the scope", () => {
    const state: PanelState = { surfaces: [files, terminal1], active: 1 };
    assert.equal(reconcileTerminalSurfaces(state, ["terminal:term-1"]), state);
  });

  it("closes terminal tabs the scope no longer holds", () => {
    assert.deepEqual(
      reconcileTerminalSurfaces(
        { surfaces: [files, terminal1, diff, terminal2], active: 2 },
        [],
      ),
      { surfaces: [files, diff], active: 1 },
    );
    assert.deepEqual(
      reconcileTerminalSurfaces(
        { surfaces: [files, terminal1, terminal2], active: 2 },
        ["terminal:term-1"],
      ),
      { surfaces: [files, terminal1], active: 1 },
    );
    assert.deepEqual(
      reconcileTerminalSurfaces({ surfaces: [terminal1], active: 0 }, []),
      emptyPanel,
    );
  });

  it("closes the active terminal tab like its close button", () => {
    const state: PanelState = { surfaces: [files, terminal1, diff], active: 1 };
    assert.deepEqual(
      reconcileTerminalSurfaces(state, []),
      closeSurface(state, 1),
    );
  });

  it("brings back the scope's terminal tabs without taking the active tab", () => {
    assert.deepEqual(
      reconcileTerminalSurfaces({ surfaces: [files, diff], active: 0 }, [
        "terminal:term-1",
        "terminal:term-2",
      ]),
      { surfaces: [files, diff, terminal1, terminal2], active: 0 },
    );
  });

  it("shows a returning terminal tab when no tab is active", () => {
    assert.deepEqual(
      reconcileTerminalSurfaces(emptyPanel, ["terminal:term-1"]),
      { surfaces: [terminal1], active: 0 },
    );
  });

  it("keeps a just-opened terminal tab active", () => {
    const opened = openSurface({ surfaces: [files], active: 0 }, terminal1);
    assert.equal(
      reconcileTerminalSurfaces(opened, ["terminal:term-1"]),
      opened,
    );
    assert.equal(opened.active, 1);
  });

  it("keeps terminal tabs in scratch threads without a repository", () => {
    const state: PanelState = { surfaces: [files, terminal1], active: 1 };
    assert.deepEqual(eligibleSurfaces(state, false), state);
  });
});

it("reopening a file replaces its target line and repeats an identical reveal", async () => {
  const { openFile } = await import("./panelState.ts");
  const first = openFile(emptyPanel, "target.txt", 321);
  const second = openFile(first, "target.txt", 12);
  assert.equal(second.surfaces.length, 1);
  const surface = second.surfaces[0];
  assert.ok(surface?.kind === "file");
  assert.equal(surface.line, 12);
  const third = openFile(second, "target.txt", 12);
  const again = third.surfaces[0];
  assert.ok(again?.kind === "file");
  assert.ok(again.revealSequence > surface.revealSequence);
  const fromExplorer = openFile(third, "target.txt");
  assert.ok(fromExplorer.surfaces[0]?.kind === "file");
  assert.equal(fromExplorer.surfaces[0].line, null);
});
