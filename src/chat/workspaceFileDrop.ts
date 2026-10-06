// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/chat/workspaceFileDrop.ts (MIT): files only, dropped folders are skipped.
export interface WorkspaceFileDragEvent {
  readonly dataTransfer: {
    readonly types: ReadonlyArray<string>;
    readonly files: Iterable<File>;
    readonly items?: Iterable<{
      readonly kind: string;
      getAsFile(): File | null;
      webkitGetAsEntry(): { readonly isDirectory: boolean } | null;
    }>;
    dropEffect: string;
  };
  readonly relatedTarget: EventTarget | null;
  readonly currentTarget: {
    contains(target: Node | null): boolean;
  };
  preventDefault(): void;
}

export interface WorkspaceFileDropHost {
  setDragActive(active: boolean): void;
  addFiles(files: File[]): void;
}

function isFileDrag(event: WorkspaceFileDragEvent): boolean {
  return event.dataTransfer.types.includes("Files");
}

function movedWithinDropTarget(event: WorkspaceFileDragEvent): boolean {
  return (
    event.relatedTarget !== null &&
    event.currentTarget.contains(event.relatedTarget as Node)
  );
}

function droppedFiles(
  dataTransfer: WorkspaceFileDragEvent["dataTransfer"],
): File[] {
  if (dataTransfer.items === undefined) return Array.from(dataTransfer.files);

  const files: File[] = [];
  for (const item of dataTransfer.items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file === null) continue;
    if (item.webkitGetAsEntry()?.isDirectory === true) continue;
    files.push(file);
  }
  return files;
}

export function makeWorkspaceFileDropHandlers(host: WorkspaceFileDropHost) {
  return {
    onDragEnter(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (movedWithinDropTarget(event)) return;
      host.setDragActive(true);
    },
    onDragOver(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      host.setDragActive(true);
    },
    onDragLeave(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (movedWithinDropTarget(event)) return;
      host.setDragActive(false);
    },
    onDrop(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      host.setDragActive(false);
      const files = droppedFiles(event.dataTransfer);
      if (files.length > 0) host.addFiles(files);
    },
  };
}
