import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import type { Approval } from "../ipc";
import { ApprovalActions, ApprovalDetails } from "./ApprovalDrawer";

function approval(
  action: Approval["action"],
  options: Approval["options"] = [],
): Approval {
  return { id: "request", turnId: "turn", state: "pending", action, options };
}

it("shows complete command, file change, and permission requests with T3's code labels", () => {
  const requests = [
    {
      action: {
        kind: "command",
        command: "curl https://example.test\nprintf done",
        cwd: "/fixture",
        reason: "Needs network",
      },
      label: "Command approval",
      detailLabel: "Command",
      detail: "curl https://example.test\nprintf done",
    },
    {
      action: {
        kind: "file_change",
        text: "*** Update File: example.txt\n+new line",
        reason: "Write the requested file",
      },
      label: "File change approval",
      detailLabel: "File change",
      detail: "*** Update File: example.txt\n+new line",
    },
    {
      action: {
        kind: "permission",
        detail: "Network access\nWrite /tmp/export",
        reason: "Export the report",
      },
      label: "App permission approval",
      detailLabel: "Permission request",
      detail: "Network access\nWrite /tmp/export",
    },
  ] satisfies {
    action: Approval["action"];
    label: string;
    detailLabel: string;
    detail: string;
  }[];
  for (const request of requests) {
    const html = renderToStaticMarkup(
      createElement(ApprovalDetails, {
        approval: approval(request.action),
        pendingCount: 2,
      }),
    );
    assert.ok(html.includes(`aria-label="${request.label}"`));
    assert.ok(html.includes(`<code aria-label="${request.detailLabel}"`));
    assert.ok(html.includes(request.detail));
    assert.ok(html.includes(request.action.reason));
    assert.ok(html.includes("1/2"));
    assert.ok(html.includes('data-approval-detail="complete"'));
  }
});

it("renders app access as wrapping sans text with the MCP app name", () => {
  const html = renderToStaticMarkup(
    createElement(ApprovalDetails, {
      approval: approval({
        kind: "mcp_elicitation",
        detail:
          "Connect your account to the Report app.\nhttps://example.test/authorize",
        reason: "Account access",
        appName: "Report app",
      }),
      pendingCount: 1,
    }),
  );
  assert.ok(html.includes('aria-label="App access approval"'));
  assert.ok(html.includes('<span aria-label="App access request"'));
  assert.ok(html.includes("whitespace-pre-wrap font-sans wrap-break-word"));
  assert.ok(html.includes("Report app"));
  assert.ok(html.includes("https://example.test/authorize"));
  assert.ok(!html.includes("<code"));
  assert.ok(!html.includes("1/1"));
});

function actions(
  options: Approval["options"],
  busy = false,
  action: Approval["action"] = {
    kind: "permission",
    detail: "Network access",
    reason: "",
  },
) {
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return renderToStaticMarkup(
    createElement(RouterContextProvider, {
      router,
      children: createElement(ApprovalActions, {
        approval: approval(action, options),
        busy,
        onAnswer: () => undefined,
      }),
    }),
  );
}

it("shows only provider-supported approval actions with the provider's labels and warning", () => {
  const options = [
    { decision: "decline", label: "Deny network" },
    {
      decision: "accept",
      label: "Allow network",
      warning: "This grants network access.",
    },
  ] satisfies Approval["options"];
  const html = actions(options);
  assert.ok(html.includes("Deny network"));
  assert.ok(html.includes("Allow network"));
  assert.ok(html.includes('aria-description="This grants network access."'));
  assert.ok(html.includes('title="This grants network access."'));
  assert.ok(html.includes("lucide-triangle-alert"));
  assert.ok(!html.includes("More approval options"));
  assert.ok(!html.includes("Always allow"));
  assert.ok(!actions([]).includes("<button"));
  assert.equal(actions(options, true).match(/disabled=""/g)?.length, 2);
});

it("keeps decline available while approval waits for reviewable details", () => {
  const options = [
    { decision: "accept", label: "Approve" },
    { decision: "decline", label: "Decline" },
    { decision: "accept_for_session", label: "Always allow this session" },
    { decision: "cancel", label: "Cancel" },
  ] satisfies Approval["options"];
  for (const action of [
    { kind: "command", command: " ", cwd: "/fixture", reason: "" },
    { kind: "file_change", text: "", reason: "" },
  ] satisfies Approval["action"][]) {
    const html = actions(options, false, action);
    assert.ok(/disabled=""[^>]*><span[^>]*>Approve<\/span>/.test(html));
    assert.equal(html.match(/disabled=""/g)?.length, 1);
    assert.ok(html.includes('aria-label="More approval options"'));
    const ready =
      action.kind === "command"
        ? { ...action, command: "Network access to example.test" }
        : { ...action, text: "Allow file changes under /tmp/export" };
    assert.ok(!actions(options, false, ready).includes('disabled=""'));
  }
});

it("offers the overflow only when the provider supplies session, persistent, or cancel actions", () => {
  for (const decision of [
    "accept_for_session",
    "accept_always",
    "cancel",
  ] as const) {
    assert.ok(
      actions([{ decision, label: "Provider option" }]).includes(
        'aria-label="More approval options"',
      ),
    );
  }
});
