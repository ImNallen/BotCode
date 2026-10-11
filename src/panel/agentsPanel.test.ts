import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Subagent } from "../ipc";
import { deriveAgentPanelModel } from "../chat/subagents";
import { AgentsPanel } from "./AgentsPanel";
import { actionForKey, agentsAction, Launcher } from "./Launcher";
import type { Surface } from "./RightPanel";

function subagent(title: string, overrides: Partial<Subagent> = {}): Subagent {
  return {
    id: `child-${title}`,
    spawnTurnId: "turn-1",
    title,
    role: title,
    model: "gpt-6.1-sol",
    effort: "low",
    status: "idle",
    activationCount: 1,
    totalTokens: 41_720,
    progress: null,
    startedAtMs: 1_000,
    completedAtMs: 7_200,
    updatedAtMs: 7_200,
    ...overrides,
  };
}

const roster = [
  subagent("readme_lines", { status: "running", totalTokens: null }),
  subagent("git_branch", { status: "waiting", totalTokens: 900 }),
  subagent("lint", { status: "idle", activationCount: 3 }),
  subagent("tests", { status: "failed", role: "reviewer", progress: "boom" }),
  subagent("docs", { status: "interrupted", totalTokens: 20_000 }),
];

const key = (key: string) => ({
  key,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  defaultPrevented: false,
  isComposing: false,
});

it("derives the Agents panel counts and token total from the roster in roster order", () => {
  const model = deriveAgentPanelModel(roster);
  assert.deepEqual(
    model.agents.map((agent) => agent.title),
    ["readme_lines", "git_branch", "lint", "tests", "docs"],
  );
  assert.equal(model.liveCount, 2);
  assert.equal(model.idleCount, 1);
  assert.equal(model.settledCount, 2);
  assert.equal(model.totalTokens, 104_340);
  assert.deepEqual(deriveAgentPanelModel([]), {
    agents: [],
    liveCount: 0,
    idleCount: 0,
    settledCount: 0,
    totalTokens: 0,
  });
});

it("renders T3's agent rows and footer counts", () => {
  const markup = renderToStaticMarkup(
    createElement(AgentsPanel, { model: deriveAgentPanelModel(roster) }),
  );
  assert.ok(markup.includes(">Direct spawns<"));
  assert.ok(markup.includes(">● 2 working<"));
  assert.ok(markup.includes(">1 idle<"));
  assert.ok(markup.includes(">2 settled<"));
  assert.ok(markup.includes(">Σ 104k tok<"));
  assert.ok(markup.includes(">gpt-6.1-sol · low · — tok<"));
  assert.ok(markup.includes(">gpt-6.1-sol · low · 41.7k tok · run 3<"));
  assert.ok(markup.includes(">Idle · resumable<"));
  assert.ok(markup.includes(">reviewer<"));
  assert.ok(markup.includes('text-destructive-foreground">boom<'));
  assert.ok(markup.includes(">6s<"));
  assert.ok(!markup.includes("No agents yet"));
  assert.ok(!markup.includes(" tools"));
});

it("leaves idle and settled counts out of the footer when there are none", () => {
  const markup = renderToStaticMarkup(
    createElement(AgentsPanel, {
      model: deriveAgentPanelModel([
        subagent("solo", { status: "running", totalTokens: 512 }),
      ]),
    }),
  );
  assert.ok(markup.includes(">● 1 working<"));
  assert.ok(!markup.includes(" idle<"));
  assert.ok(!markup.includes(" settled<"));
  assert.ok(markup.includes(">Σ 512 tok<"));
});

it("shows T3's empty state before the thread spawns agents", () => {
  const markup = renderToStaticMarkup(
    createElement(AgentsPanel, { model: deriveAgentPanelModel([]) }),
  );
  assert.ok(markup.includes(">No agents yet<"));
  assert.ok(
    markup.includes(
      "When this thread spawns subagents or runs a workflow, they show up here with live status, activity, and token usage.",
    ),
  );
  assert.ok(!markup.includes("<footer"));
});

it("opens the Agents surface from the launcher's A key and badges live agents", () => {
  const opened: Surface[] = [];
  const action = agentsAction(3, (surface) => opened.push(surface));
  actionForKey(key("a"), [action])?.onSelect();
  assert.deepEqual(opened, [{ kind: "agents" }]);

  const markup = renderToStaticMarkup(
    createElement(Launcher, { actions: [action] }),
  );
  assert.ok(markup.includes('data-surface-launcher-keys="A"'));
  assert.ok(markup.includes(">Agents<"));
  assert.ok(
    markup.includes(
      'class="absolute -top-1.5 -right-2 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-1 text-3xs font-semibold tabular-nums text-white">3<',
    ),
  );
  assert.ok(
    !renderToStaticMarkup(
      createElement(Launcher, {
        actions: [agentsAction(0, () => {})],
      }),
    ).includes("bg-info"),
  );
});
