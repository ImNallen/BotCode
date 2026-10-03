import { useQuery } from "@tanstack/react-query";
import { File, MultiFileDiff } from "@pierre/diffs/react";
import { FileCode2 } from "lucide-react";
import { ipc } from "./ipc";
export function CodePane({
  workspaceId,
  path,
  view,
}: {
  workspaceId: string;
  path: string | undefined;
  view: "file" | "staged" | "unstaged";
}) {
  const file = useQuery({
    queryKey: ["file", workspaceId, path],
    queryFn: () => ipc.file(workspaceId, path ?? ""),
    enabled: Boolean(path) && view === "file",
  });
  const diff = useQuery({
    queryKey: ["diff", workspaceId, path, view],
    queryFn: () =>
      ipc.diff(
        workspaceId,
        path ?? "",
        view === "staged" ? "staged" : "unstaged",
      ),
    enabled: Boolean(path) && view !== "file",
  });
  if (!path)
    return (
      <div className="code-empty">
        <FileCode2 size={30} />
        <h2>Your working copy</h2>
        <p>Select a file or a Git change to inspect it.</p>
      </div>
    );
  const query = view === "file" ? file : diff;
  if (query.isPending)
    return <div className="pane-message">Loading {path}…</div>;
  if (query.error)
    return <div className="pane-message error">{query.error.message}</div>;
  if (view === "file" && file.data) {
    return file.data.kind === "unavailable" ? (
      <div className="pane-message">{file.data.reason}</div>
    ) : (
      <File
        file={{ name: file.data.name, contents: file.data.contents }}
        options={{
          theme: { light: "pierre-light", dark: "pierre-dark" },
          themeType: "system",
        }}
      />
    );
  }
  if (diff.data) {
    return diff.data.kind === "unavailable" ? (
      <div className="pane-message">{diff.data.reason}</div>
    ) : (
      <MultiFileDiff
        oldFile={{ name: diff.data.old_name, contents: diff.data.old_contents }}
        newFile={{ name: diff.data.new_name, contents: diff.data.new_contents }}
        options={{
          theme: { light: "pierre-light", dark: "pierre-dark" },
          themeType: "system",
          diffStyle: "unified",
        }}
      />
    );
  }
  return null;
}
