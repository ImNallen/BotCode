import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Thread } from "../ipc";
import { detectComposerTrigger } from "./composer-logic";
import { searchSlashCommandItems } from "./composerSlashCommandSearch";
import { ContextWindowDetails } from "./ContextWindowMeter";
import {
  compactDisabledReason,
  compactSlashCommandAvailable,
  isCompactCommand,
} from "./contextCompaction";
import { immediateIntent } from "./followUps";
import { deriveRows } from "./timelineRows";

type Turn = Thread["turns"][number];
const UNAVAILABLE = "Compacting is unavailable right now";

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "018ba719-19f4-4fdb-bd79-aa4a676ea056",
    kind: "prompt",
    prompt: "hello",
    nativeTurnId: "native-turn",
    delivery: { kind: "accepted" },
    execution: { kind: "completed" },
    tasks: null,
    items: [],
    settings: null,
    startedAtMs: 1,
    completedAtMs: 2,
    attachments: [],
    checkpoint: { kind: "unavailable", before: null, reason: "No Git" },
    ...overrides,
  };
}

function thread(turns: Turn[], overrides: Partial<Thread> = {}): Thread {
  return {
    id: "018ba719-19f4-4fdb-bd79-aa4a676ea054",
    workspaceId: "018ba719-19f4-4fdb-bd79-aa4a676ea055",
    title: "Compaction",
    worktreeSetup: null,
    nativeThreadId: "native-thread",
    revision: 1,
    session: { kind: "ready" },
    settings: {
      model: null,
      effort: null,
      permissionMode: "full-access",
      interactionMode: "default",
    },
    checkout: { kind: "local" },
    approvals: [],
    userQuestions: [],
    diagnostic: null,
    pendingRevert: null,
    lastRevert: null,
    subagents: [],
    context: null,
    turns,
    ...overrides,
  } as Thread;
}

const idle = { working: false, planFollowUp: false };

it("recognizes the standalone /compact command in any case", () => {
  assert.equal(isCompactCommand("/compact"), true);
  assert.equal(isCompactCommand("  /COMPACT \n"), true);
  assert.equal(isCompactCommand("/compact now"), false);
  assert.equal(isCompactCommand("compact"), false);
});

it("allows compaction only for an idle conversation with a finished prompt", () => {
  assert.equal(
    compactDisabledReason({ thread: thread([turn()]), ...idle }),
    null,
  );
  const refusals: Array<[string, Parameters<typeof compactDisabledReason>[0]]> =
    [
      ["no thread", { thread: undefined, ...idle }],
      ["no turns", { thread: thread([]), ...idle }],
      [
        "no native thread",
        { thread: thread([turn()], { nativeThreadId: null }), ...idle },
      ],
      [
        "only a compaction",
        { thread: thread([turn({ kind: "compaction" })]), ...idle },
      ],
      [
        "prompt still running",
        {
          thread: thread([turn({ execution: { kind: "running" } })]),
          ...idle,
        },
      ],
      [
        "working",
        { thread: thread([turn()]), working: true, planFollowUp: false },
      ],
      [
        "plan follow-up",
        { thread: thread([turn()]), working: false, planFollowUp: true },
      ],
      [
        "pending approval",
        {
          thread: thread([turn()], {
            approvals: [
              {
                id: "018ba719-19f4-4fdb-bd79-aa4a676ea058",
                turnId: "018ba719-19f4-4fdb-bd79-aa4a676ea056",
                action: {
                  kind: "command",
                  command: "ls",
                  cwd: "/",
                  reason: "",
                },
                options: [],
                state: "pending",
              },
            ],
          } as Partial<Thread>),
          ...idle,
        },
      ],
    ];
  for (const [label, input] of refusals)
    assert.equal(compactDisabledReason(input), UNAVAILABLE, label);
});

it("offers /compact only when the prompt holds nothing but the command", () => {
  const offered = (
    prompt: string,
    extra: Partial<Parameters<typeof compactSlashCommandAvailable>[0]> = {},
  ) => {
    const trigger = detectComposerTrigger(prompt, prompt.length);
    const available = compactSlashCommandAvailable({
      prompt,
      trigger,
      attachmentCount: 0,
      contextCount: 0,
      disabledReason: null,
      ...extra,
    });
    return searchSlashCommandItems(trigger?.query ?? "", false, [], available)
      .filter((item) => item.type === "slash-command")
      .find((item) => item.command === "compact");
  };
  assert.deepEqual(offered("/comp"), {
    id: "slash:compact",
    type: "slash-command",
    command: "compact",
    label: "/compact",
    description: "Summarize the conversation and reduce context usage",
  });
  assert.equal(offered("/comp", { attachmentCount: 1 }), undefined);
  assert.equal(offered("/comp", { contextCount: 1 }), undefined);
  assert.equal(offered("/comp", { disabledReason: UNAVAILABLE }), undefined);
  assert.equal(offered("Before\n/comp"), undefined);
});

it("shows Compact context with T3's disabled reason in the meter card", () => {
  const usage = {
    usedTokens: 13067,
    maxTokens: 258400,
    totalProcessedTokens: 20659,
  };
  const card = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(ContextWindowDetails, {
        usage,
        modelDisplayName: null,
        ...props,
      }),
    );
  const disabled = card({
    onCompact: () => {},
    compactDisabled: true,
    compactDisabledReason: UNAVAILABLE,
  });
  assert.match(
    disabled,
    /<button[^>]*disabled=""[^>]*>.*Compact context<\/button>/,
  );
  assert.ok(
    disabled.includes(
      `<div class="text-pretty text-secondary-label text-2xs">${UNAVAILABLE}</div>`,
    ),
  );
  const enabled = card({
    onCompact: () => {},
    compactDisabled: false,
    compactDisabledReason: null,
  });
  assert.match(enabled, /Compact context<\/button>/);
  assert.ok(!enabled.includes(`disabled=""`));
  assert.ok(!enabled.includes(UNAVAILABLE));
  assert.ok(!card({}).includes("Compact context"));
});

it("never steers follow-ups into a running compaction", () => {
  const running = (kind: Turn["kind"]) =>
    thread([turn(), turn({ kind, execution: { kind: "running" } })], {
      session: { kind: "running" },
    });
  assert.deepEqual(immediateIntent(running("prompt")), {
    kind: "steer",
    expectedTurnId: "018ba719-19f4-4fdb-bd79-aa4a676ea056",
  });
  assert.equal(immediateIntent(running("compaction")), null);
});

it("labels a compaction turn Compacting before Codex reports its item", () => {
  const working = (kind: Turn["kind"]) =>
    deriveRows(
      thread([
        turn({
          kind,
          prompt: kind === "compaction" ? "/compact" : "hello",
          execution: { kind: "running" },
        }),
      ]),
      new Set(),
      new Set(),
    ).find((row) => row.kind === "working");
  assert.equal(working("compaction")?.compacting, true);
  assert.equal(working("prompt")?.compacting, false);
});
