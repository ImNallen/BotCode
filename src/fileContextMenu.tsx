// Ported from pingdotgg/t3code v0.0.45 apps/web/src/fileContextMenu.ts (MIT).
import { FolderTreeIcon, PencilIcon } from "lucide-react";
import { useState, type MouseEvent } from "react";
import type { OpenTarget } from "./ipc";
import { useEditorActions } from "./lib/editorActions";
import { revealLabel } from "./lib/editors";
import { Menu, MenuItem, MenuSub } from "./ui/menu";

type Point = { x: number; y: number };

// A keyboard-opened context menu reports no pointer position.
export function contextMenuPoint(event: MouseEvent<HTMLElement>): Point {
  if (event.clientX !== 0 || event.clientY !== 0)
    return { x: event.clientX, y: event.clientY };
  const bounds = event.currentTarget.getBoundingClientRect();
  return { x: bounds.left, y: bounds.bottom };
}

export function useFileContextMenu() {
  const editors = useEditorActions();
  const [menu, setMenu] = useState<{
    target: OpenTarget;
    point: Point;
    returnFocus: HTMLElement;
  }>();
  const canUseFinder = editors.available.includes("file-manager");
  const openWith = editors.installed.filter(
    (editor) => editor.id !== "file-manager",
  );
  const show = (target: OpenTarget, event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    if (!canUseFinder && openWith.length === 0) return;
    setMenu({
      target,
      point: contextMenuPoint(event),
      returnFocus: event.currentTarget,
    });
  };
  const element = menu ? (
    <Menu
      key={`${menu.point.x}:${menu.point.y}`}
      open
      point={menu.point}
      returnFocus={menu.returnFocus}
      onOpenChange={(open) => {
        if (!open) setMenu(undefined);
      }}
      trigger={() => null}
    >
      {canUseFinder ? (
        <>
          <MenuItem
            onClick={() => editors.open(menu.target, null, "file-manager")}
          >
            <PencilIcon />
            Open
          </MenuItem>
          <MenuItem onClick={() => editors.reveal(menu.target)}>
            <FolderTreeIcon />
            {revealLabel}
          </MenuItem>
        </>
      ) : null}
      {openWith.length > 0 ? (
        <MenuSub label="Open with">
          {openWith.map((editor) => (
            <MenuItem
              key={editor.id}
              onClick={() => editors.open(menu.target, null, editor.id)}
            >
              {editor.label}
            </MenuItem>
          ))}
        </MenuSub>
      ) : null}
    </Menu>
  ) : null;
  return { show, element };
}
