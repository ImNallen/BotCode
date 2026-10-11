// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/AgentsPanel.tsx (MIT).
import { BotIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import type { Subagent } from "../ipc";
import { cn } from "../lib/cn";
import {
  type AgentPanelModel,
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  isActiveSubagentStatus,
} from "../chat/subagents";
import { ScrollArea } from "../ui/scrollArea";

const STATUS_VISUALS: Record<
  Subagent["status"],
  { dotClass: string; label: string }
> = {
  running: { dotClass: "bg-info", label: "Working" },
  waiting: { dotClass: "bg-info", label: "Working" },
  idle: { dotClass: "bg-muted-foreground/50", label: "Idle · resumable" },
  failed: { dotClass: "bg-destructive", label: "Failed" },
  interrupted: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
};

function formatElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) {
    return `${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours === 0) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

const elapsedBetween = (startedAtMs: number, endMs: number | null) =>
  formatElapsedSeconds(((endMs ?? Date.now()) - startedAtMs) / 1000);

function AgentElapsed({ agent }: { agent: Subagent }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const live = isActiveSubagentStatus(agent.status);
  const { startedAtMs } = agent;

  useEffect(() => {
    if (!live) return;
    const update = () => {
      if (textRef.current) {
        textRef.current.textContent = elapsedBetween(startedAtMs, null);
      }
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [live, startedAtMs]);

  return (
    <span ref={textRef} className="tabular-nums">
      {elapsedBetween(startedAtMs, live ? null : agent.completedAtMs)}
    </span>
  );
}

function AgentRow({ agent }: { agent: Subagent }) {
  const visuals = STATUS_VISUALS[agent.status];
  const modelLabel = formatSubagentModelLabel(agent.model, agent.effort);
  const role =
    agent.role.trim().toLocaleLowerCase() ===
    agent.title.trim().toLocaleLowerCase()
      ? null
      : agent.role;
  const metadata = [
    modelLabel,
    agent.totalTokens !== null
      ? `${formatSubagentTokenCount(agent.totalTokens)} tok`
      : "— tok",
    agent.activationCount > 1 ? `run ${agent.activationCount}` : null,
  ].filter((value): value is string => value !== null);

  return (
    <div className="grid h-[3.875rem] grid-cols-[0.375rem_minmax(0,1fr)_auto] grid-rows-[1.25rem_1.125rem_1rem] items-center gap-x-2 rounded-md px-1.5 py-1">
      <span className="col-start-1 row-start-1 flex items-center">
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", visuals.dotClass)}
        />
      </span>
      <span className="col-start-2 row-start-1 flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate text-sm font-medium">
          {agent.title}
        </span>
        {role ? (
          <span className="max-w-28 shrink-0 truncate rounded-sm border border-border/60 px-1 font-mono text-3xs text-muted-foreground">
            {role}
          </span>
        ) : null}
      </span>
      <span className="col-start-3 row-start-1 min-w-14 text-right font-mono text-2xs text-muted-foreground/80">
        <span className="inline-flex items-center gap-1">
          <AgentElapsed agent={agent} />
        </span>
      </span>
      <span
        className={cn(
          "col-start-2 col-end-4 row-start-2 block truncate text-xs",
          agent.status === "failed"
            ? "text-destructive-foreground"
            : "text-muted-foreground",
        )}
      >
        {agent.progress ?? visuals.label}
      </span>
      <span className="col-start-2 col-end-4 row-start-3 truncate font-mono text-2xs tabular-nums text-muted-foreground/70">
        {metadata.join(" · ")}
      </span>
      <span className="sr-only">{visuals.label}</span>
    </div>
  );
}

export function AgentsPanel({ model }: { model: AgentPanelModel }) {
  if (model.agents.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <BotIcon aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No agents yet</p>
        <p className="max-w-56 text-xs text-muted-foreground">
          When this thread spawns subagents or runs a workflow, they show up
          here with live status, activity, and token usage.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 p-2">
          <section>
            <div className="px-1.5 pt-1 text-3xs font-medium uppercase tracking-wider text-muted-foreground">
              Direct spawns
            </div>
            {model.agents.map((agent) => (
              <AgentRow key={agent.id} agent={agent} />
            ))}
          </section>
        </div>
      </ScrollArea>
      <footer className="flex items-center justify-between border-t border-border/60 px-3 py-1.5 font-mono text-2xs text-muted-foreground">
        <span className="flex items-center gap-2">
          {model.liveCount > 0 ? (
            <span className="text-info-foreground">
              ● {model.liveCount} working
            </span>
          ) : null}
          {model.idleCount > 0 ? <span>{model.idleCount} idle</span> : null}
          {model.settledCount > 0 ? (
            <span>{model.settledCount} settled</span>
          ) : null}
        </span>
        <span className="tabular-nums">
          Σ {formatSubagentTokenCount(model.totalTokens)} tok
        </span>
      </footer>
    </div>
  );
}
