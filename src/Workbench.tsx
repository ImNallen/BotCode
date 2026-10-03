import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import {
  FolderOpen,
  Plus,
  RefreshCw,
  GitBranch,
  FileCode2,
  Files,
  GitCompareArrows,
  X,
  MessageSquare,
  ChevronDown,
} from "lucide-react";
import { ipc, native, setThreadSnapshot } from "./ipc";
import { RepositoryTree } from "./RepositoryTree";
import { CodePane } from "./CodePane";
import { Conversation } from "./Conversation";
type RightPanel = "closed" | "files" | "diff";

export function Workbench() {
  const selection = useSearch({ from: "__root__" });
  const navigate = useNavigate({ from: "/" });
  const client = useQueryClient();
  const filesToggle = useRef<HTMLButtonElement>(null);
  const changesToggle = useRef<HTMLButtonElement>(null);
  const [rightPanel, setRightPanel] = useState<RightPanel>(() =>
    selection.path ? (selection.view === "file" ? "files" : "diff") : "closed",
  );
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
  useEffect(() => {
    setRightPanel(
      selection.path
        ? selection.view === "file"
          ? "files"
          : "diff"
        : "closed",
    );
  }, [workspaceId, selection.path, selection.view]);
  const chooseFile = useCallback(
    (path: string) => {
      setRightPanel("files");
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
  const chooseDiff = (path: string, basis: "staged" | "unstaged") => {
    setRightPanel("diff");
    void navigate({
      search: (previous) => ({
        ...previous,
        workspace: workspaceId,
        path,
        view: basis,
      }),
    });
  };
  const togglePanel = (panel: Exclude<RightPanel, "closed">) => {
    setRightPanel((current) => (current === panel ? "closed" : panel));
  };
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
    return (
      <div className="welcome">
        <header className="welcome-top" data-tauri-drag-region>
          Z1 Code
        </header>
        <main>
          <p className="muted">Opening Z1 Code…</p>
        </main>
      </div>
    );
  if (!workspaceId)
    return (
      <div className="welcome">
        <header className="welcome-top" data-tauri-drag-region>
          Z1 Code
        </header>
        <main>
          <h1>Z1 Code</h1>
          <p>Open a repository to start a Codex conversation.</p>
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
          Local workspace <span>Codex</span>
        </footer>
      </div>
    );
  const workspace = view.data?.workspace;
  const threads = view.data?.threads ?? [];
  const selectedThread = threads.find(
    (thread) => thread.id === selection.thread,
  );
  const inspectedPath =
    rightPanel === "files"
      ? selection.view === "file"
        ? selection.path
        : undefined
      : selection.view !== "file"
        ? selection.path
        : undefined;
  return (
    <div className="workbench">
      <div className="panes">
        <aside className="sidebar" aria-label="Repository conversations">
          <header className="sidebar-title" data-tauri-drag-region>
            Z1 Code
          </header>
          <div className="workspace-picker">
            <select
              aria-label="Selected repository"
              value={workspaceId}
              onChange={(event) => {
                setRightPanel("closed");
                void navigate({
                  search: { workspace: event.target.value, view: "file" },
                });
              }}
            >
              {workspaces.data?.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.label}
                </option>
              ))}
            </select>
            <ChevronDown size={12} />
          </div>
          <div className="sidebar-actions">
            <button className="quiet" onClick={() => void openRepository()}>
              <FolderOpen size={14} /> Open repository
            </button>
            <button
              className="quiet"
              disabled={create.isPending}
              onClick={() => create.mutate()}
            >
              <Plus size={14} /> New conversation
            </button>
          </div>
          <div className="sidebar-heading">Conversations</div>
          <div className="thread-list">
            {threads.length === 0 && (
              <p className="sidebar-empty">No conversations yet.</p>
            )}
            {threads.map((thread) => (
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
            ))}
          </div>
          <footer className="sidebar-footer" title={workspace?.root}>
            <FolderOpen size={12} />
            <span>{workspace?.root ?? "Local workspace"}</span>
          </footer>
        </aside>
        <main className="main-column">
          <header className="titlebar">
            <div className="breadcrumb" data-tauri-drag-region="deep">
              <span>{workspace?.label ?? "Repository"}</span>
              <span className="breadcrumb-divider">/</span>
              <strong>{selectedThread?.title ?? "New conversation"}</strong>
            </div>
            <div className="titlebar-right">
              <span
                className="branch"
                title={view.data?.branch || "Detached HEAD"}
              >
                <GitBranch size={13} />
                {view.data?.branch || "Detached HEAD"}
              </span>
              <button
                className="icon-button"
                aria-label="Refresh workspace"
                title="Refresh workspace"
                onClick={refresh}
              >
                <RefreshCw size={15} />
              </button>
              <button
                ref={filesToggle}
                className="quiet panel-toggle"
                aria-label="Toggle files panel"
                aria-pressed={rightPanel === "files"}
                onClick={() => togglePanel("files")}
              >
                <Files size={14} />
                Files
              </button>
              <button
                ref={changesToggle}
                className="quiet panel-toggle"
                aria-label="Toggle changes panel"
                aria-pressed={rightPanel === "diff"}
                onClick={() => togglePanel("diff")}
              >
                <GitCompareArrows size={14} />
                Changes
              </button>
            </div>
          </header>
          <div className="main-content">
            {selection.thread ? (
              <Conversation
                key={selection.thread}
                threadId={selection.thread}
              />
            ) : (
              <section className="conversation no-thread">
                <div className="chat-empty">
                  <h2>New conversation</h2>
                  <p>
                    Work with Codex in {workspace?.label ?? "this repository"}.
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
            {rightPanel !== "closed" && (
              <aside className="inspector" aria-label="Repository inspector">
                <header className="inspector-header">
                  <div
                    className="inspector-tabs"
                    role="group"
                    aria-label="Inspector view"
                  >
                    <button
                      className="quiet"
                      aria-pressed={rightPanel === "files"}
                      onClick={() => setRightPanel("files")}
                    >
                      Files
                    </button>
                    <button
                      className="quiet"
                      aria-pressed={rightPanel === "diff"}
                      onClick={() => setRightPanel("diff")}
                    >
                      Changes
                    </button>
                  </div>
                  <button
                    className="icon-button"
                    aria-label="Close inspector"
                    onClick={() => {
                      const trigger =
                        rightPanel === "files" ? filesToggle : changesToggle;
                      setRightPanel("closed");
                      trigger.current?.focus();
                    }}
                  >
                    <X size={15} />
                  </button>
                </header>
                <div className="inspector-selector">
                  {view.isPending ? (
                    <p className="pane-message">Loading repository…</p>
                  ) : rightPanel === "files" ? (
                    view.data && (
                      <RepositoryTree
                        key={workspaceId}
                        paths={view.data.files}
                        onSelect={chooseFile}
                      />
                    )
                  ) : (
                    <div className="changes-list">
                      {view.data?.changes.length === 0 && (
                        <p className="muted clean">Working tree clean</p>
                      )}
                      {view.data?.changes.map((change) => (
                        <div className="change-row" key={change.path}>
                          <span className="change-status">
                            {change.status.trim()}
                          </span>
                          <span title={change.path}>{change.path}</span>
                          {change.unstaged && (
                            <button
                              aria-label={`Unstaged diff for ${change.path}`}
                              onClick={() =>
                                chooseDiff(change.path, "unstaged")
                              }
                            >
                              Work
                            </button>
                          )}
                          {change.staged && (
                            <button
                              aria-label={`Staged diff for ${change.path}`}
                              onClick={() => chooseDiff(change.path, "staged")}
                            >
                              Index
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <header className="code-header">
                  <FileCode2 size={14} />
                  <span title={inspectedPath}>
                    {inspectedPath ??
                      (rightPanel === "files"
                        ? "Select a file"
                        : "Select a change")}
                  </span>
                  {inspectedPath && (
                    <small>
                      {selection.view === "file"
                        ? "File"
                        : selection.view === "staged"
                          ? "Staged"
                          : "Working tree"}
                    </small>
                  )}
                </header>
                <div className="code-content">
                  {inspectedPath ? (
                    <CodePane
                      workspaceId={workspaceId}
                      path={inspectedPath}
                      view={selection.view}
                    />
                  ) : (
                    <div className="code-empty">
                      <p>
                        {rightPanel === "files"
                          ? "Select a file to inspect its contents."
                          : "Select Work or Index to inspect a diff."}
                      </p>
                    </div>
                  )}
                </div>
              </aside>
            )}
          </div>
          {(error || view.error) && (
            <div className="global-error" role="alert">
              <span>{error ?? view.error?.message}</span>
              <button onClick={() => setError(undefined)}>Dismiss</button>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
