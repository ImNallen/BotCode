// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/chat/agentSpawnSummary.ts (MIT).
import type { Subagent } from "../ipc";
import { isActiveSubagentStatus } from "./subagents";

export function deriveAgentSpawnSummary(
  agents: ReadonlyArray<Pick<Subagent, "status">>,
) {
  const working = agents.filter((agent) =>
    isActiveSubagentStatus(agent.status),
  ).length;
  const failed = agents.filter((agent) => agent.status === "failed").length;
  const live = working > 0;
  const lead = `${live ? "Kicked off" : "Ran"} ${agents.length} subagent${agents.length === 1 ? "" : "s"}`;
  return { live, lead, failed: !live && failed > 0 };
}
