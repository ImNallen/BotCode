import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  ShieldCheck,
  Square,
  RotateCcw,
  Terminal,
  Check,
  X,
} from "lucide-react";
import { ipc, setThreadSnapshot } from "./ipc";
import type { Approval, ApprovalDecision, Item, Thread } from "./ipc";
function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case "assistant":
      return <div className="assistant-text">{item.text}</div>;
    case "command":
      return (
        <details className="tool" open={item.status === "inProgress"}>
          <summary>
            <Terminal size={13} />
            <span>{item.command}</span>
            <small>{item.status}</small>
          </summary>
          <pre>{item.output || "Waiting for output."}</pre>
        </details>
      );
    case "file_change":
      return (
        <details className="tool">
          <summary>
            File changes<small>{item.status}</small>
          </summary>
          <pre>{item.text}</pre>
        </details>
      );
    case "other":
      return item.text ? (
        <details className="tool">
          <summary>{item.label}</summary>
          <pre>{item.text}</pre>
        </details>
      ) : null;
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}
function ApprovalCard({
  approval,
  onAnswer,
  busy,
}: {
  approval: Approval;
  onAnswer: (id: string, decision: ApprovalDecision) => void;
  busy: boolean;
}) {
  const details =
    approval.action.kind === "command"
      ? approval.action.command
      : approval.action.text;
  return (
    <div className="approval">
      <div className="approval-title">
        <ShieldCheck size={16} />
        <strong>Review before execution</strong>
      </div>
      <p>{approval.action.reason || "Codex requests your approval."}</p>
      <pre>{details || "The provider has not supplied action details."}</pre>
      {approval.action.kind === "command" && (
        <small>{approval.action.cwd}</small>
      )}
      <div className="approval-buttons">
        <button
          disabled={busy || !details}
          onClick={() => onAnswer(approval.id, "accept")}
        >
          <Check size={13} />
          Allow once
        </button>
        <button
          disabled={busy}
          onClick={() => onAnswer(approval.id, "decline")}
        >
          <X size={13} />
          Decline
        </button>
        <button disabled={busy} onClick={() => onAnswer(approval.id, "cancel")}>
          Cancel turn
        </button>
      </div>
    </div>
  );
}
export function Conversation({ threadId }: { threadId: string }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["thread", threadId],
    queryFn: async () => {
      const incoming = await ipc.thread(threadId);
      const current = client.getQueryData<Thread>(["thread", threadId]);
      return current && current.revision > incoming.revision
        ? current
        : incoming;
    },
  });
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const end = useRef<HTMLDivElement>(null);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["thread", threadId] });
    void client.invalidateQueries({ queryKey: ["workspace"] });
    void client.invalidateQueries({ queryKey: ["file"] });
    void client.invalidateQueries({ queryKey: ["diff"] });
  };
  const send = useMutation({
    mutationFn: (input: { text: string; requestId: string }) =>
      ipc.submit(threadId, input.text, input.requestId),
    onSuccess: () => {
      setText("");
      setError(undefined);
      refresh();
    },
    onError: (e) => {
      setError(e.message);
      refresh();
    },
  });
  const approve = useMutation({
    mutationFn: (input: { id: string; decision: ApprovalDecision }) =>
      ipc.approval(input.id, input.decision),
    onSuccess: refresh,
    onError: (e) => setError(e.message),
  });
  const stop = useMutation({
    mutationFn: () => ipc.interrupt(threadId),
    onSuccess: refresh,
    onError: (e) => setError(e.message),
  });
  const resume = useMutation({
    mutationFn: () => ipc.resume(threadId),
    onSuccess: (snapshot) => {
      setThreadSnapshot(client, snapshot);
      setError(undefined);
    },
    onError: (e) => setError(e.message),
  });
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [query.data?.revision]);
  const sessionKind = query.data?.session.kind;
  useEffect(() => {
    if (sessionKind === "ready") {
      void client.invalidateQueries({ queryKey: ["workspace"] });
      void client.invalidateQueries({ queryKey: ["file"] });
      void client.invalidateQueries({ queryKey: ["diff"] });
    }
  }, [sessionKind, client]);
  if (query.isPending)
    return <div className="pane-message">Loading conversation…</div>;
  if (query.error)
    return <div className="pane-message error">{query.error.message}</div>;
  const thread = query.data;
  if (!thread) return null;
  const busy = ["connecting", "running", "interrupting"].includes(
    thread.session.kind,
  );
  const pending = thread.approvals.filter((a) => a.state === "pending");
  const canStop = thread.turns.some(
    (t) => t.execution.kind === "running" && t.nativeTurnId !== null,
  );
  const onSubmit = () => {
    if (!text.trim() || busy || send.isPending) return;
    send.mutate({ text, requestId: crypto.randomUUID() });
  };
  return (
    <section className="conversation" aria-label="Codex conversation">
      <header className="conversation-header">
        <div>
          <span className={`status-dot ${busy ? "active" : ""}`} />
          <span>Codex</span>
          <small>
            {pending.length
              ? "Awaiting approval"
              : thread.session.kind.replaceAll("_", " ")}
          </small>
        </div>
        {canStop && (
          <button
            className="quiet"
            disabled={stop.isPending || thread.session.kind === "interrupting"}
            onClick={() => stop.mutate()}
          >
            <Square size={12} />
            Stop
          </button>
        )}
      </header>
      <div className="transcript">
        {thread.turns.length === 0 && (
          <div className="chat-empty">
            <span className="z1-small">Z1</span>
            <h2>Start with an idea.</h2>
            <p>
              Ask Codex to explore your repository,
              <br />
              fix a bug, or build something new.
            </p>
          </div>
        )}
        {thread.turns.map((turn) => (
          <article className="turn" key={turn.id}>
            <div className="user-message">
              <small>You</small>
              <p>{turn.prompt}</p>
            </div>
            <div className="turn-response">
              <span className="agent-label">Codex</span>
              {turn.items.map((item) => (
                <ItemView item={item} key={item.id} />
              ))}
              {turn.items.length === 0 && turn.execution.kind === "running" && (
                <p className="working">Working…</p>
              )}
              {turn.delivery.kind === "not_sent" ||
              turn.delivery.kind === "uncertain" ? (
                <div className="turn-warning">{turn.delivery.reason}</div>
              ) : null}
              {turn.execution.kind === "failed" ||
              turn.execution.kind === "lost" ? (
                <div className="turn-warning">{turn.execution.reason}</div>
              ) : null}
              <small className="turn-status">
                {turn.execution.kind.replaceAll("_", " ")}
              </small>
            </div>
          </article>
        ))}
        {pending.map((approval) => (
          <ApprovalCard
            key={approval.id}
            approval={approval}
            busy={approve.isPending}
            onAnswer={(id, decision) => approve.mutate({ id, decision })}
          />
        ))}
        <div ref={end} />
      </div>
      {thread.diagnostic && (
        <div className="diagnostic">{thread.diagnostic}</div>
      )}
      {["dormant", "unavailable"].includes(thread.session.kind) && (
        <div className="resume-row">
          <span>
            {thread.session.kind === "dormant"
              ? "Saved conversation. Reconnect to continue."
              : "Codex is unavailable."}
          </span>
          <button disabled={resume.isPending} onClick={() => resume.mutate()}>
            <RotateCcw size={13} />
            Reconnect
          </button>
        </div>
      )}
      {error && (
        <div className="composer-error" role="alert">
          {error}
        </div>
      )}
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <textarea
          aria-label="Message Codex"
          placeholder="What would you like to build?"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
        <div className="composer-bottom">
          <span>
            Workspace write <span className="separator">·</span> Review required
          </span>
          <button
            className="send"
            type="submit"
            aria-label="Send message"
            disabled={busy || send.isPending || !text.trim()}
          >
            <ArrowUp size={17} />
          </button>
        </div>
      </form>
      <footer className="chat-footer">
        ⌘ Enter to send <span>Uses your installed Codex account</span>
      </footer>
    </section>
  );
}
