// Ported from pingdotgg/t3code v0.0.45 components/settings/ProjectFaviconPickerDialog.tsx (MIT).
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { Workspace } from "../ipc";
import { ProjectFilePicker } from "../search/ProjectFilePicker";
import { Dialog } from "../ui/dialog";
import { notifyProject } from "../project/ProjectToasts";

export function ProjectFaviconPickerDialog({
  workspace,
  onOpenChange,
  onSelect,
}: {
  workspace: Workspace;
  onOpenChange: (open: boolean) => void;
  onSelect: (path: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const select = (path: string) => {
    onOpenChange(false);
    onSelect(path);
  };
  const external = async () => {
    if (picking) return;
    setPicking(true);
    try {
      const path = await open({
        directory: false,
        multiple: false,
        title: "Choose project icon",
        filters: [
          {
            name: "Images",
            extensions: [
              "svg",
              "ico",
              "png",
              "jpg",
              "jpeg",
              "gif",
              "webp",
              "avif",
            ],
          },
        ],
        defaultPath: workspace.root,
      });
      if (typeof path === "string") select(path);
    } catch (error: unknown) {
      notifyProject(
        "error",
        "Could not open image picker",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setPicking(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!picking) onOpenChange(open);
      }}
      variant="command"
      className="overflow-hidden"
    >
      <ProjectFilePicker
        checkout={{ workspaceId: workspace.id }}
        projectName={workspace.label}
        imageOnly
        onOpenFile={select}
        externalPending={picking}
        onPickExternal={() => void external()}
      />
    </Dialog>
  );
}
