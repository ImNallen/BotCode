// Ported from pingdotgg/t3code v0.0.45 apps/web/src/terminalUiStateStore.test.ts and
// packages/shared/src/terminalLabels.test.ts (MIT), against the pure transitions.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_THREAD_TERMINAL_UI_STATE,
  activatePanelTerminal,
  allocateTerminalId,
  closePanelSurface,
  closePanelTerminal,
  closeTerminal,
  ensureTerminal,
  getTerminalLabel,
  newTerminal,
  nextTerminalId,
  openPanelTerminal,
  panelTerminalIds,
  parseTerminalStates,
  selectTerminalState,
  setActiveTerminal,
  setTerminalHeight,
  setTerminalOpen,
  splitPanelTerminal,
  splitTerminal,
  terminalScopeKey,
  toggleTerminalOpen,
  updateTerminalStates,
  type ThreadTerminalUiState,
} from "./terminalState.ts";

const initial = DEFAULT_THREAD_TERMINAL_UI_STATE;

function apply(
  ...steps: Array<(state: ThreadTerminalUiState) => ThreadTerminalUiState>
): ThreadTerminalUiState {
  return steps.reduce((state, step) => step(state), initial);
}

describe("terminal transitions", () => {
  it("returns an empty default terminal UI state for unknown scopes", () => {
    assert.deepEqual(selectTerminalState({}, "thread-1"), {
      terminalOpen: false,
      terminalHeight: 280,
      terminalIds: [],
      activeTerminalId: "",
      terminalGroups: [],
      activeTerminalGroupId: "",
      panelSurfaces: [],
    });
  });

  it("materializes the default terminal when opening an empty drawer", () => {
    assert.deepEqual(setTerminalOpen(initial, true), {
      terminalOpen: true,
      terminalHeight: 280,
      terminalIds: ["term-1"],
      activeTerminalId: "term-1",
      terminalGroups: [{ id: "group-term-1", terminalIds: ["term-1"] }],
      activeTerminalGroupId: "group-term-1",
      panelSurfaces: [],
    });
  });

  it("closes the drawer without dropping its terminals", () => {
    const state = apply(
      (s) => setTerminalOpen(s, true),
      (s) => setTerminalOpen(s, false),
    );
    assert.equal(state.terminalOpen, false);
    assert.deepEqual(state.terminalIds, ["term-1"]);
  });

  it("toggles the drawer open with a terminal and closed again", () => {
    const opened = toggleTerminalOpen(initial);
    assert.equal(opened.terminalOpen, true);
    assert.deepEqual(opened.terminalIds, ["term-1"]);
    const closed = toggleTerminalOpen(opened);
    assert.equal(closed.terminalOpen, false);
    assert.deepEqual(closed.terminalIds, ["term-1"]);
  });

  it("opens and splits terminals into the active group", () => {
    const state = apply(
      (s) => setTerminalOpen(s, true),
      (s) => splitTerminal(s, "term-2"),
    );
    assert.equal(state.terminalOpen, true);
    assert.deepEqual(state.terminalIds, ["term-1", "term-2"]);
    assert.equal(state.activeTerminalId, "term-2");
    assert.deepEqual(state.terminalGroups, [
      { id: "group-term-1", terminalIds: ["term-1", "term-2"] },
    ]);
  });

  it("stacks vertically split terminals in the active group", () => {
    const state = apply(
      (s) => setTerminalOpen(s, true),
      (s) => splitTerminal(s, "term-2", "vertical"),
    );
    assert.deepEqual(state.terminalGroups, [
      {
        id: "group-term-1",
        terminalIds: ["term-1", "term-2"],
        splitDirection: "vertical",
      },
    ]);
  });

  it("caps splits at four terminals per group", () => {
    const state = apply(
      (s) => splitTerminal(s, "terminal-2"),
      (s) => splitTerminal(s, "terminal-3"),
      (s) => splitTerminal(s, "terminal-4"),
      (s) => splitTerminal(s, "terminal-5"),
      (s) => splitTerminal(s, "terminal-6"),
    );
    assert.deepEqual(state.terminalIds, [
      "terminal-2",
      "terminal-3",
      "terminal-4",
      "terminal-5",
    ]);
    assert.deepEqual(state.terminalGroups, [
      {
        id: "group-terminal-2",
        terminalIds: ["terminal-2", "terminal-3", "terminal-4", "terminal-5"],
      },
    ]);
  });

  it("creates new terminals in a separate group", () => {
    const state = apply(
      (s) => setTerminalOpen(s, true),
      (s) => newTerminal(s, "term-2"),
    );
    assert.deepEqual(state.terminalIds, ["term-1", "term-2"]);
    assert.equal(state.activeTerminalId, "term-2");
    assert.equal(state.activeTerminalGroupId, "group-term-2");
    assert.deepEqual(state.terminalGroups, [
      { id: "group-term-1", terminalIds: ["term-1"] },
      { id: "group-term-2", terminalIds: ["term-2"] },
    ]);
  });

  it("activates a terminal and its group", () => {
    const state = apply(
      (s) => setTerminalOpen(s, true),
      (s) => newTerminal(s, "term-2"),
      (s) => setActiveTerminal(s, "term-1"),
    );
    assert.equal(state.activeTerminalId, "term-1");
    assert.equal(state.activeTerminalGroupId, "group-term-1");
    assert.equal(setActiveTerminal(state, "term-9"), state);
  });

  it("ensures unknown terminals are registered, opened, and activated", () => {
    const state = ensureTerminal(initial, "setup-setup", {
      open: true,
      active: true,
    });
    assert.equal(state.terminalOpen, true);
    assert.deepEqual(state.terminalIds, ["setup-setup"]);
    assert.equal(state.activeTerminalId, "setup-setup");
    assert.deepEqual(state.terminalGroups, [
      { id: "group-setup-setup", terminalIds: ["setup-setup"] },
    ]);
  });

  it("keeps a valid active terminal after closing an active split terminal", () => {
    const state = apply(
      (s) => splitTerminal(s, "terminal-2"),
      (s) => splitTerminal(s, "terminal-3"),
      (s) => closeTerminal(s, "terminal-3"),
    );
    assert.equal(state.activeTerminalId, "terminal-2");
    assert.deepEqual(state.terminalIds, ["terminal-2"]);
    assert.deepEqual(state.terminalGroups, [
      { id: "group-terminal-2", terminalIds: ["terminal-2"] },
    ]);
  });

  it("activates the terminal that took the closed one's place", () => {
    const state = apply(
      (s) => setTerminalOpen(s, true),
      (s) => newTerminal(s, "term-2"),
      (s) => newTerminal(s, "term-3"),
      (s) => setActiveTerminal(s, "term-2"),
      (s) => closeTerminal(s, "term-2"),
    );
    assert.deepEqual(state.terminalIds, ["term-1", "term-3"]);
    assert.equal(state.activeTerminalId, "term-3");
    assert.equal(state.activeTerminalGroupId, "group-term-3");
  });

  it("resets to the closed default when the last terminal closes", () => {
    const state = apply(
      (s) => newTerminal(s, "terminal-only"),
      (s) => setTerminalHeight(s, 400),
      (s) => closeTerminal(s, "terminal-only"),
    );
    assert.deepEqual(state, DEFAULT_THREAD_TERMINAL_UI_STATE);
  });

  it("ignores heights that are not positive numbers", () => {
    const opened = setTerminalOpen(initial, true);
    assert.equal(setTerminalHeight(opened, 0), opened);
    assert.equal(setTerminalHeight(opened, Number.NaN), opened);
    assert.equal(setTerminalHeight(opened, 360).terminalHeight, 360);
  });
});

describe("terminal states by scope", () => {
  it("keys a thread by its id and a repository draft by its workspace", () => {
    assert.equal(terminalScopeKey("ws-1", "thread-1"), "thread-1");
    assert.equal(terminalScopeKey("ws-1", null), "draft:ws-1");
  });

  it("keeps scopes isolated", () => {
    let states = updateTerminalStates({}, "thread-1", (s) =>
      setTerminalOpen(s, true),
    );
    states = updateTerminalStates(states, "thread-2", (s) =>
      newTerminal(s, "term-4"),
    );
    assert.equal(selectTerminalState(states, "thread-1").terminalOpen, true);
    assert.deepEqual(selectTerminalState(states, "thread-2").terminalIds, [
      "term-4",
    ]);
  });

  it("drops an entry once it equals the default", () => {
    const opened = updateTerminalStates({}, "thread-1", (s) =>
      setTerminalOpen(s, true),
    );
    const closed = updateTerminalStates(opened, "thread-1", (s) =>
      closeTerminal(s, "term-1"),
    );
    assert.deepEqual(Object.keys(opened), ["thread-1"]);
    assert.deepEqual(closed, {});
  });

  it("returns the same record when nothing changes", () => {
    const states = updateTerminalStates({}, "thread-1", (s) =>
      setTerminalOpen(s, true),
    );
    assert.equal(
      updateTerminalStates(states, "thread-1", (s) => setTerminalOpen(s, true)),
      states,
    );
    const empty = {};
    assert.equal(
      updateTerminalStates(empty, "thread-2", (s) => setTerminalOpen(s, false)),
      empty,
    );
  });

  it("reads entries saved before panel terminals existed", () => {
    const stored = JSON.stringify({
      "thread-1": {
        terminalOpen: true,
        terminalHeight: 320,
        terminalIds: ["term-1"],
        activeTerminalId: "term-1",
        terminalGroups: [{ id: "group-term-1", terminalIds: ["term-1"] }],
        activeTerminalGroupId: "group-term-1",
      },
      "thread-2": { terminalOpen: "yes" },
      "draft:ws-1": DEFAULT_THREAD_TERMINAL_UI_STATE,
    });
    assert.deepEqual(parseTerminalStates(stored), {
      "thread-1": {
        terminalOpen: true,
        terminalHeight: 320,
        terminalIds: ["term-1"],
        activeTerminalId: "term-1",
        terminalGroups: [{ id: "group-term-1", terminalIds: ["term-1"] }],
        activeTerminalGroupId: "group-term-1",
        panelSurfaces: [],
      },
    });
    assert.deepEqual(parseTerminalStates("not json"), {});
    assert.deepEqual(parseTerminalStates(null), {});
  });
});

describe("panel terminals", () => {
  const withPanel = (
    ...steps: Array<(state: ThreadTerminalUiState) => ThreadTerminalUiState>
  ) => apply((s) => openPanelTerminal(s, "term-1"), ...steps);

  it("opens a panel surface named after its first terminal", () => {
    assert.deepEqual(withPanel().panelSurfaces, [
      {
        id: "terminal:term-1",
        terminalIds: ["term-1"],
        activeTerminalId: "term-1",
      },
    ]);
  });

  it("allocates the lowest free id across the drawer and the panel", () => {
    const state = withPanel(
      (s) => setTerminalOpen(s, true),
      (s) => openPanelTerminal(s, allocateTerminalId(s)),
      (s) => newTerminal(s, allocateTerminalId(s)),
    );
    assert.deepEqual(state.terminalIds, ["term-2", "term-4"]);
    assert.deepEqual(panelTerminalIds(state), ["term-1", "term-3"]);
    assert.equal(
      allocateTerminalId(closePanelTerminal(state, "term-3")),
      "term-3",
    );
  });

  it("never gives the drawer a panel terminal", () => {
    const state = withPanel();
    assert.deepEqual(newTerminal(state, "term-1").terminalIds, []);
    assert.deepEqual(splitTerminal(state, "term-1").terminalIds, []);
    const parsed = parseTerminalStates(
      JSON.stringify({
        "thread-1": {
          ...state,
          terminalOpen: true,
          terminalIds: ["term-1", "term-2"],
          activeTerminalId: "term-1",
          terminalGroups: [
            { id: "group-term-1", terminalIds: ["term-1", "term-2"] },
          ],
          activeTerminalGroupId: "group-term-1",
        },
      }),
    )["thread-1"];
    assert.deepEqual(parsed?.terminalIds, ["term-2"]);
    assert.deepEqual(parsed?.activeTerminalId, "term-2");
    assert.deepEqual(parsed?.terminalGroups, [
      { id: "group-term-1", terminalIds: ["term-2"] },
    ]);
  });

  it("splits a panel surface up to the group limit", () => {
    const state = withPanel(
      (s) => splitPanelTerminal(s, "terminal:term-1", "term-2"),
      (s) => splitPanelTerminal(s, "terminal:term-1", "term-3", "vertical"),
      (s) => splitPanelTerminal(s, "terminal:term-1", "term-4", "vertical"),
    );
    assert.deepEqual(state.panelSurfaces, [
      {
        id: "terminal:term-1",
        terminalIds: ["term-1", "term-2", "term-3", "term-4"],
        activeTerminalId: "term-4",
        splitDirection: "vertical",
      },
    ]);
    assert.equal(splitPanelTerminal(state, "terminal:term-1", "term-5"), state);
  });

  it("activates a terminal only within its own surface", () => {
    const state = withPanel(
      (s) => splitPanelTerminal(s, "terminal:term-1", "term-2"),
      (s) => openPanelTerminal(s, "term-3"),
      (s) => activatePanelTerminal(s, "terminal:term-1", "term-1"),
      (s) => activatePanelTerminal(s, "terminal:term-1", "term-3"),
    );
    assert.deepEqual(
      state.panelSurfaces.map((surface) => surface.activeTerminalId),
      ["term-1", "term-3"],
    );
  });

  it("activates the last remaining terminal after closing the active one", () => {
    const state = withPanel(
      (s) => splitPanelTerminal(s, "terminal:term-1", "term-2"),
      (s) => splitPanelTerminal(s, "terminal:term-1", "term-3"),
      (s) => activatePanelTerminal(s, "terminal:term-1", "term-1"),
      (s) => closePanelTerminal(s, "term-1"),
    );
    assert.deepEqual(state.panelSurfaces, [
      {
        id: "terminal:term-1",
        terminalIds: ["term-2", "term-3"],
        activeTerminalId: "term-3",
      },
    ]);
  });

  it("removes the surface with its last terminal", () => {
    const state = withPanel(
      (s) => openPanelTerminal(s, "term-2"),
      (s) => closePanelTerminal(s, "term-1"),
    );
    assert.deepEqual(
      state.panelSurfaces.map((surface) => surface.id),
      ["terminal:term-2"],
    );
    assert.deepEqual(
      closePanelSurface(state, "terminal:term-2").panelSurfaces,
      [],
    );
  });

  it("keeps panel terminals when the drawer's last terminal closes", () => {
    const state = withPanel(
      (s) => setTerminalOpen(s, true),
      (s) => closeTerminal(s, "term-2"),
    );
    assert.deepEqual(state.terminalIds, []);
    assert.deepEqual(panelTerminalIds(state), ["term-1"]);
  });

  it("stores a scope while it has panel terminals", () => {
    const opened = updateTerminalStates({}, "thread-1", (s) =>
      openPanelTerminal(s, "term-1"),
    );
    assert.deepEqual(Object.keys(opened), ["thread-1"]);
    assert.deepEqual(parseTerminalStates(JSON.stringify(opened)), opened);
    assert.deepEqual(
      updateTerminalStates(opened, "thread-1", (s) =>
        closePanelTerminal(s, "term-1"),
      ),
      {},
    );
  });
});

describe("terminal labels and ids", () => {
  it("uses the numeric suffix for term-* ids", () => {
    assert.equal(getTerminalLabel("term-1"), "Terminal 1");
    assert.equal(getTerminalLabel("term-12"), "Terminal 12");
    assert.equal(getTerminalLabel("terminal-3"), "Terminal 3");
    assert.equal(getTerminalLabel("custom-session"), "custom-session");
  });

  it("allocates the lowest free term-N id", () => {
    assert.equal(nextTerminalId([]), "term-1");
    assert.equal(nextTerminalId(["term-1"]), "term-2");
    assert.equal(nextTerminalId(["term-1", "term-2", "term-3"]), "term-4");
    assert.equal(nextTerminalId(["term-1", "term-3"]), "term-2");
    assert.equal(nextTerminalId(["term-2", "term-3"]), "term-1");
    assert.equal(nextTerminalId(["", "  ", "term-1"]), "term-2");
  });
});
