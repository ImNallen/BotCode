// Ported from pingdotgg/t3code v0.0.45 packages/contracts/src/editor.ts, apps/web/src/editorLabels.ts and editorPreferences.ts (MIT).
import { z } from "zod";
import { isMacPlatform } from "./utils";
import {
  AntigravityIcon,
  AquaIcon,
  CLionIcon,
  CursorIcon,
  DataGripIcon,
  DataSpellIcon,
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

// Bot Code runs only on macOS, so the file manager is always Finder.
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
  { id: "file-manager", label: "Finder", Icon: FinderIcon, kind: "brand" },
] as const satisfies readonly EditorDefinition[];

export type Editor = (typeof EDITORS)[number];
export type EditorId = Editor["id"];
export const editorId = z.enum(
  EDITORS.map((editor) => editor.id) as [EditorId, ...EditorId[]],
);

export function editorById(id: EditorId): Editor {
  const editor = EDITORS.find((candidate) => candidate.id === id);
  if (!editor) throw new Error(`Unknown editor ${id}`);
  return editor;
}

export function resolvePreferredEditor(
  stored: EditorId | null,
  available: readonly EditorId[],
): EditorId | null {
  if (stored && available.includes(stored)) return stored;
  return EDITORS.find((editor) => available.includes(editor.id))?.id ?? null;
}

export function installedEditors(available: readonly EditorId[]): Editor[] {
  return EDITORS.filter((editor) => available.includes(editor.id));
}

export function openInEditorMenuLabel(id: EditorId | null): string {
  return id === null || id === "file-manager"
    ? "Open in editor"
    : `Open in ${editorById(id).label}`;
}

export const revealLabel = isMacPlatform(navigator.platform)
  ? "Reveal in Finder"
  : "Show in Explorer";
