// Ported from pingdotgg/t3code v0.0.45 packages/contracts/src/editor.ts, apps/web/src/editorLabels.ts,
// editorPreferences.ts, components/preview/fileExplorerLabel.ts and components/chat/OpenInPicker.tsx (MIT).
import { FolderClosedIcon } from "lucide-react";
import { z } from "zod";
import {
  getLocalFileManagerName,
  isMacPlatform,
  isWindowsPlatform,
} from "./utils";
import {
  AntigravityIcon,
  AquaIcon,
  CLionIcon,
  CursorIcon,
  DataGripIcon,
  DataSpellIcon,
  FileExplorerIcon,
  FinderIcon,
  GoLandIcon,
  IntelliJIdeaIcon,
  KiroIcon,
  PhpStormIcon,
  PyCharmIcon,
  RiderIcon,
  RubyMineIcon,
  RustRoverIcon,
  TraeIcon,
  VisualStudioCode,
  VisualStudioCodeInsiders,
  VSCodium,
  WebStormIcon,
  Zed,
  type Icon,
} from "../ui/editorIcons";

type EditorDefinition = {
  readonly id: string;
  readonly label: string;
  readonly Icon: Icon;
  readonly kind: "brand" | "generic";
};

export const EDITORS = [
  { id: "cursor", label: "Cursor", Icon: CursorIcon, kind: "brand" },
  { id: "trae", label: "Trae", Icon: TraeIcon, kind: "brand" },
  { id: "kiro", label: "Kiro", Icon: KiroIcon, kind: "brand" },
  { id: "vscode", label: "VS Code", Icon: VisualStudioCode, kind: "brand" },
  {
    id: "vscode-insiders",
    label: "VS Code Insiders",
    Icon: VisualStudioCodeInsiders,
    kind: "brand",
  },
  { id: "vscodium", label: "VSCodium", Icon: VSCodium, kind: "brand" },
  { id: "zed", label: "Zed", Icon: Zed, kind: "brand" },
  {
    id: "antigravity",
    label: "Antigravity",
    Icon: AntigravityIcon,
    kind: "brand",
  },
  { id: "idea", label: "IntelliJ IDEA", Icon: IntelliJIdeaIcon, kind: "brand" },
  { id: "aqua", label: "Aqua", Icon: AquaIcon, kind: "brand" },
  { id: "clion", label: "CLion", Icon: CLionIcon, kind: "brand" },
  { id: "datagrip", label: "DataGrip", Icon: DataGripIcon, kind: "brand" },
  { id: "dataspell", label: "DataSpell", Icon: DataSpellIcon, kind: "brand" },
  { id: "goland", label: "GoLand", Icon: GoLandIcon, kind: "brand" },
  { id: "phpstorm", label: "PhpStorm", Icon: PhpStormIcon, kind: "brand" },
  { id: "pycharm", label: "PyCharm", Icon: PyCharmIcon, kind: "brand" },
  { id: "rider", label: "Rider", Icon: RiderIcon, kind: "brand" },
  { id: "rubymine", label: "RubyMine", Icon: RubyMineIcon, kind: "brand" },
  { id: "rustrover", label: "RustRover", Icon: RustRoverIcon, kind: "brand" },
  { id: "webstorm", label: "WebStorm", Icon: WebStormIcon, kind: "brand" },
  {
    id: "file-manager",
    label: "File Manager",
    Icon: FinderIcon,
    kind: "brand",
  },
] as const satisfies readonly EditorDefinition[];

export type EditorId = (typeof EDITORS)[number]["id"];
export type Editor = EditorDefinition & { readonly id: EditorId };
export const editorId = z.enum(
  EDITORS.map((editor) => editor.id) as [EditorId, ...EditorId[]],
);

export function editorById(
  id: EditorId,
  platform: string = navigator.platform,
): Editor {
  if (id === "file-manager") return fileManagerEditor(platform);
  const editor = EDITORS.find((candidate) => candidate.id === id);
  if (!editor) throw new Error(`Unknown editor ${id}`);
  return editor;
}

export function fileManagerEditor(
  platform: string = navigator.platform,
): Editor {
  return {
    id: "file-manager",
    label: editorLabelForPlatform("file-manager", platform),
    Icon: isMacPlatform(platform)
      ? FinderIcon
      : isWindowsPlatform(platform)
        ? FileExplorerIcon
        : FolderClosedIcon,
    kind:
      isMacPlatform(platform) || isWindowsPlatform(platform)
        ? "brand"
        : "generic",
  };
}

export function editorLabelForPlatform(
  id: EditorId,
  platform: string = navigator.platform,
): string {
  if (id === "file-manager") {
    return getLocalFileManagerName(platform);
  }

  return EDITORS.find((editor) => editor.id === id)?.label ?? "Editor";
}

export function resolvePreferredEditor(
  stored: EditorId | null,
  available: readonly EditorId[],
): EditorId | null {
  if (stored && available.includes(stored)) return stored;
  return EDITORS.find((editor) => available.includes(editor.id))?.id ?? null;
}

export function installedEditors(
  available: readonly EditorId[],
  platform: string = navigator.platform,
): Editor[] {
  return EDITORS.filter((editor) => available.includes(editor.id)).map(
    (editor) => editorById(editor.id, platform),
  );
}

export function openInEditorMenuLabel(id: EditorId | null): string {
  return id === null || id === "file-manager"
    ? "Open in editor"
    : `Open in ${editorById(id).label}`;
}

export function revealInFileExplorerLabel(
  platform: string = navigator.platform,
): string {
  const normalized = platform.toLowerCase();
  if (normalized.includes("mac")) return "Reveal in Finder";
  if (normalized.includes("win")) return "Reveal in File Explorer";
  return "Reveal in Files";
}
