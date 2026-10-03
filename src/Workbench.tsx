import { useCallback, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import {
  FolderOpen,
  Plus,
  RefreshCw,
  GitBranch,
  FileCode2,
  PanelLeft,
  MessageSquare,
  ChevronDown,
} from "lucide-react";
import { ipc, native, setThreadSnapshot } from "./ipc";
import { RepositoryTree } from "./RepositoryTree";
import { CodePane } from "./CodePane";
import { Conversation } from "./Conversation";
export function Workbench() {
  const selection = useSearch({ from: "__root__" });
  const navigate = useNavigate({ from: "/" });
  const client = useQueryClient();
  const [error, setError] = useState<string>();
  const workspaces = useQuery({
    queryKey: ["workspaces"],
    queryFn: ipc.workspaces,
    enabled: native,
  });
  const workspaceId = selection.workspace ?? workspaces.data?.[0]?.id;
  const view = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => ipc.workspace(workspaceId ?? ""),
    enabled: native && Boolean(workspaceId),
  });
  const chooseFile = useCallback(
    (path: string) => {
      void navigate({
        search: (previous) => ({
          ...previous,
          workspace: workspaceId,
          path,
          view: "file",
        }),
      });
    },
    [navigate, workspaceId],
  );
  const create = useMutation({
    mutationFn: () => ipc.create(workspaceId ?? ""),
    onSuccess: (thread) => {
      setThreadSnapshot(client, thread);
      void client.invalidateQueries({ queryKey: ["workspace"] });
      void navigate({
        search: (previous) => ({
          ...previous,
          workspace: workspaceId,
          thread: thread.id,
        }),
      });
    },
    onError: (e) => setError(e.message),
  });
  const openRepository = async () => {
    try {
      const path = await open({
        directory: true,
        multiple: false,
        title: "Open a Git repository",
      });
      if (typeof path !== "string") return;
      const workspace = await ipc.openWorkspace(path);
      await client.invalidateQueries({ queryKey: ["workspaces"] });
      void navigate({ search: { workspace: workspace.id, view: "file" } });
      setError(undefined);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const refresh = () => {
    void client.invalidateQueries();
  };
  if (!native)
    return (
      <div className="native-required">
        <div className="brand-mark">Z1</div>
        <h1>Z1 Code</h1>
        <p>This workbench runs in its native macOS window.</p>
        <code>pnpm tauri dev</code>
        <p className="muted">
          The native runtime owns your repositories and Codex processes.
        </p>
      </div>
    );
  if (workspaces.isPending)
    return <div className="pane-message">Opening Z1 Code…</div>;
  if (!workspaceId)
    return (
      <div className="welcome">
        <div className="welcome-top">
          <div className="brand">
            <span className="brand-mark">Z1</span>
            <span>Z1 Code</span>
          </div>
          <small>Your local coding workspace</small>
        </div>
        <main>
          <div className="welcome-symbol">
            <FileCode2 size={28} />
          </div>
          <p className="eyebrow">YOUR CODE. YOUR WORKFLOW.</p>
          <h1>Make room for your next idea.</h1>
          <p>
            Open a repository to explore its files and changes.
            <br />
            Work with Codex in a conversation that stays with your code.
          </p>
          <button className="primary" onClick={() => void openRepository()}>
            <FolderOpen size={16} />
            Open repository
          </button>
          {(error || workspaces.error) && (
            <p className="error" role="alert">
              {error ?? workspaces.error?.message}
            </p>
          )}
          <small>Runs locally · Uses your installed Codex account</small>
        </main>
        <footer>
          Z1 Code <span>First working slice</span>
        </footer>
      </div>
    );
  const workspace = view.data?.workspace;
  const threads = view.data?.threads ?? [];
  return (
    <div className="workbench">
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark">Z1</span>
          <span>Z1 Code</span>
        </div>
        <span className="titlebar-divider" />
        <span className="repository-label">
          {workspace?.label ?? "Repository"}
        </span>
        <div className="titlebar-right">
          <span>
            <GitBranch size={13} />
            {view.data?.branch || "Detached HEAD"}
          </span>
          <button
            className="icon-button"
            aria-label="Refresh workspace"
            onClick={refresh}
          >
            <RefreshCw size={15} />
          </button>
          <button className="quiet" onClick={() => void openRepository()}>
            <FolderOpen size={14} />
            Open
          </button>
        </div>
      </header>
      <div className="panes">
        <aside className="sidebar">
          <div className="workspace-picker">
            <select
              aria-label="Selected repository"
              value={workspaceId}
              onChange={(event) =>
                void navigate({
                  search: { workspace: event.target.value, view: "file" },
                })
              }
            >
              {workspaces.data?.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.label}
                </option>
              ))}
            </select>
            <ChevronDown size={12} />
          </div>
          <div className="sidebar-heading">
            <span>CONVERSATIONS</span>
            <button
              aria-label="New conversation"
              className="icon-button"
              disabled={create.isPending}
              onClick={() => create.mutate()}
            >
              <Plus size={14} />
            </button>
          </div>
          <div className="thread-list">
            {threads.length === 0 ? (
              <button className="new-thread" onClick={() => create.mutate()}>
                <Plus size={13} />
                Start a conversation
              </button>
            ) : (
              threads.map((thread) => (
                <button
                  key={thread.id}
                  className={`thread-row ${selection.thread === thread.id ? "selected" : ""}`}
                  onClick={() => {
                    void navigate({
                      search: (previous) => ({
                        ...previous,
                        workspace: workspaceId,
                        thread: thread.id,
                      }),
                    });
                    void ipc
                      .resume(thread.id)
                      .then((snapshot) => setThreadSnapshot(client, snapshot))
                      .catch((e) =>
                        setError(e instanceof Error ? e.message : String(e)),
                      );
                  }}
                >
                  <MessageSquare size={13} />
                  <span>{thread.title}</span>
                  {thread.session.kind === "running" && (
                    <span className="status-dot active" />
                  )}
                </button>
              ))
            )}
          </div>
          <div className="sidebar-heading">
            <span>FILES</span>
            <span>{view.data?.files.length ?? 0}</span>
          </div>
          <div className="tree-container">
            {view.data && (
              <RepositoryTree
                key={workspaceId}
                paths={view.data.files}
                onSelect={chooseFile}
              />
            )}
          </div>
          <div className="sidebar-heading changes-heading">
            <span>CHANGES</span>
            <span>{view.data?.changes.length ?? 0}</span>
          </div>
          <div className="changes-list">
            {view.data?.changes.length === 0 && (
              <p className="muted clean">Working tree clean</p>
            )}
            {view.data?.changes.map((change) => (
              <div className="change-row" key={change.path}>
                <span className="change-status">{change.status.trim()}</span>
                <span title={change.path}>{change.path}</span>
                {change.unstaged && (
                  <button
                    aria-label={`Unstaged diff for ${change.path}`}
                    onClick={() =>
                      void navigate({
                        search: (previous) => ({
                          ...previous,
                          path: change.path,
                          view: "unstaged",
                        }),
                      })
                    }
                  >
                    Work
                  </button>
                )}
                {change.staged && (
                  <button
                    aria-label={`Staged diff for ${change.path}`}
                    onClick={() =>
                      void navigate({
                        search: (previous) => ({
                          ...previous,
                          path: change.path,
                          view: "staged",
                        }),
                      })
                    }
                  >
                    Index
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="sidebar-footer">
            <PanelLeft size={13} />
            <span>Local workspace</span>
          </div>
        </aside>
        <section className="code-pane">
          <header className="code-header">
            <FileCode2 size={14} />
            <span>{selection.path ?? "Working copy"}</span>
            <small>
              {selection.view === "file"
                ? "File"
                : selection.view === "staged"
                  ? "Staged diff"
                  : "Working diff"}
            </small>
          </header>
          <div className="code-content">
            <CodePane
              workspaceId={workspaceId}
              path={selection.path}
              view={selection.view}
            />
          </div>
        </section>
        {selection.thread ? (
          <Conversation key={selection.thread} threadId={selection.thread} />
        ) : (
          <section className="conversation no-thread">
            <div className="chat-empty">
              <span className="z1-small">Z1</span>
              <h2>A conversation for your code.</h2>
              <p>
                Start a new conversation with Codex.
                <br />
                Your history stays in this workspace.
              </p>
              <button
                className="primary"
                disabled={create.isPending}
                onClick={() => create.mutate()}
              >
                <Plus size={15} />
                New conversation
              </button>
            </div>
          </section>
        )}
      </div>
      {(error || view.error) && (
        <div className="global-error" role="alert">
          <span>{error ?? view.error?.message}</span>
          <button onClick={() => setError(undefined)}>Dismiss</button>
        </div>
      )}
      <footer className="statusbar">
        <span className="status-dot" />
        Local environment
        <span className="statusbar-right">{workspace?.root}</span>
      </footer>
    </div>
  );
}
