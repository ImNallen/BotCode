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
  /** Still claims file drags, so the webview never navigates to the file, but neither highlights nor adds. */
  disabled?: boolean;
  setDragActive(active: boolean): void;
  /** Omitted by a target nested in another that adds the same drop, so the drop is added once. */
  addFiles?(files: File[]): void;
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
      host.setDragActive(!host.disabled);
    },
    onDragOver(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      host.setDragActive(!host.disabled);
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
      if (host.disabled || !host.addFiles) return;
      const files = droppedFiles(event.dataTransfer);
      if (files.length > 0) host.addFiles(files);
    },
  };
}
