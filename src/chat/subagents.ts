// Ported from pingdotgg/t3code v0.0.45 packages/client-runtime/src/state/subagentRuntime.ts (MIT).
import type { Subagent } from "../ipc";

export function isActiveSubagentStatus(status: Subagent["status"]): boolean {
  return status === "running" || status === "waiting";
}

export type AgentPanelModel = {
  agents: readonly Subagent[];
  liveCount: number;
  idleCount: number;
  settledCount: number;
  totalTokens: number;
};

export function deriveAgentPanelModel(
  subagents: readonly Subagent[],
): AgentPanelModel {
  let liveCount = 0;
  let idleCount = 0;
  let settledCount = 0;
  let totalTokens = 0;
  for (const agent of subagents) {
    if (isActiveSubagentStatus(agent.status)) liveCount += 1;
    else if (agent.status === "idle") idleCount += 1;
    else settledCount += 1;
    totalTokens += agent.totalTokens ?? 0;
  }
  return { agents: subagents, liveCount, idleCount, settledCount, totalTokens };
}

export function formatSubagentModelLabel(
  model: string | null,
  effort: string | null,
): string | null {
  if (!model) {
    return null;
  }
  const compact = model
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-latest$/, "");
  return effort ? `${compact} · ${effort}` : compact;
}

export function formatSubagentTokenCount(totalTokens: number): string {
  if (totalTokens < 1000) {
    return `${totalTokens}`;
  }
  if (totalTokens < 1_000_000) {
    const value = totalTokens / 1000;
    return `${value >= 100 ? Math.round(value) : value.toFixed(1)}k`;
  }
  return `${(totalTokens / 1_000_000).toFixed(1)}M`;
}
