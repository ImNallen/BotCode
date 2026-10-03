// Icon set, sprite and colors copied from pingdotgg/t3code v0.0.45 apps/web/src/pierre-icons.ts
// and components/chat/PierreEntryIcon.tsx (MIT).
import {
  createFileTreeIconResolver,
  getBuiltInSpriteSheet,
  type FileTreeIcons,
} from "@pierre/trees";
import { FileIcon, FolderIcon } from "lucide-react";
import { useInsertionEffect, useMemo } from "react";
import { cn } from "../lib/cn";
import { useResolvedTheme } from "./useResolvedTheme";

const PIERRE_ICON_SPRITE_ID = "t3code-pierre-file-icon-sprite";

const T3_FILE_ICON_SPRITE = `
<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true">
  <!-- Lucide Film icon, ISC license. -->
  <symbol id="t3-file-icon-video" viewBox="0 0 24 24">
    <g fill="none" stroke="#a631be" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M7 3v18M3 7.5h4M3 12h18M3 16.5h4M17 3v18M17 7.5h4M17 16.5h4" />
    </g>
  </symbol>
  <symbol id="t3-file-icon-agents" viewBox="0 0 32 32">
    <path fill="currentColor" d="M27.2 16c0-6.19-5.01-11.2-11.2-11.2C9.81 4.8 4.8 9.81 4.8 16S9.81 27.2 16 27.2c6.19 0 11.2-5.01 11.2-11.2Zm-5.6 2.1a1.4 1.4 0 1 1 0 2.8h-4.2a1.4 1.4 0 1 1 0-2.8Zm-11.2-6.8c.622-.373 1.42-.208 1.84.361l.079.119 2.1 3.5.088.171c.15.351.15.748 0 1.1l-.088.171-2.1 3.5a1.4 1.4 0 0 1-2.4-1.44L11.59 16l-1.67-2.78-.067-.127c-.302-.642-.075-1.42.547-1.79ZM30 16c0 7.73-6.27 14-14 14S2 23.73 2 16 8.27 2 16 2s14 6.27 14 14Z" />
  </symbol>
  <symbol id="t3-file-icon-pnpm" viewBox="0 0 32 32">
    <path fill="#f9ad00" d="M30 10.75h-8.749V2H30Zm-9.626 0h-8.75V2h8.75Zm-9.625 0H2V2h8.749ZM30 20.375h-8.749v-8.75H30Z" />
    <path fill="currentColor" d="M20.374 20.375h-8.75v-8.75h8.75Zm0 9.625h-8.75v-8.75h8.75ZM30 30h-8.749v-8.75H30Zm-19.251 0H2v-8.75h8.749Z" />
  </symbol>
</svg>`;

const VIDEO_FILE_EXTENSIONS = [
  "avi",
  "m4v",
  "mkv",
  "mov",
  "mp4",
  "ogv",
  "webm",
];

export const T3_PIERRE_ICONS = {
  set: "complete",
  colored: true,
  spriteSheet: T3_FILE_ICON_SPRITE,
  byFileName: {
    "package.json": "file-tree-builtin-npm",
    "tsconfig.json": "file-tree-builtin-typescript",
    "agents.md": "t3-file-icon-agents",
    "pnpm-lock.yaml": "t3-file-icon-pnpm",
    "pnpm-workspace.yaml": "t3-file-icon-pnpm",
  },
  byFileExtension: Object.fromEntries(
    VIDEO_FILE_EXTENSIONS.map((extension) => [extension, "t3-file-icon-video"]),
  ),
} satisfies FileTreeIcons;

const completeIconResolver = createFileTreeIconResolver(T3_PIERRE_ICONS);

const ICON_COLORS: Record<string, readonly [light: string, dark: string]> = {
  astro: ["#a631be", "#d568ea"],
  babel: ["#d5a910", "#ffd452"],
  bash: ["#199f43", "#5ecc71"],
  biome: ["#1a85d4", "#69b1ff"],
  bootstrap: ["#693acf", "#9d6afb"],
  browserslist: ["#d5a910", "#ffd452"],
  bun: ["#594c5b", "#79697b"],
  c: ["#1a85d4", "#69b1ff"],
  claude: ["#d47628", "#ffa359"],
  cpp: ["#1a85d4", "#69b1ff"],
  css: ["#693acf", "#9d6afb"],
  database: ["#a631be", "#d568ea"],
  default: ["#84848a", "#adadb1"],
  docker: ["#1a85d4", "#69b1ff"],
  eslint: ["#693acf", "#9d6afb"],
  git: ["#ff8c5b", "#d5512f"],
  go: ["#1ca1c7", "#68cdf2"],
  graphql: ["#d32a61", "#ff678d"],
  html: ["#d47628", "#ffa359"],
  image: ["#d32a61", "#ff678d"],
  javascript: ["#d5a910", "#ffd452"],
  json: ["#d47628", "#ffa359"],
  markdown: ["#199f43", "#5ecc71"],
  mcp: ["#17a5af", "#64d1db"],
  nextjs: ["#84848a", "#adadb1"],
  npm: ["#d52c36", "#ff6762"],
  oxc: ["#1ca1c7", "#68cdf2"],
  postcss: ["#d52c36", "#ff6762"],
  prettier: ["#17a5af", "#64d1db"],
  python: ["#1a85d4", "#69b1ff"],
  react: ["#1ca1c7", "#68cdf2"],
  ruby: ["#d52c36", "#ff6762"],
  rust: ["#d47628", "#ffa359"],
  sass: ["#d32a61", "#ff678d"],
  stylelint: ["#84848a", "#adadb1"],
  svelte: ["#d52c36", "#ff6762"],
  svg: ["#d47628", "#ffa359"],
  svgo: ["#199f43", "#5ecc71"],
  swift: ["#d47628", "#ffa359"],
  table: ["#17a5af", "#64d1db"],
  tailwind: ["#1ca1c7", "#68cdf2"],
  terraform: ["#693acf", "#9d6afb"],
  text: ["#84848a", "#adadb1"],
  typescript: ["#1a85d4", "#69b1ff"],
  vite: ["#a631be", "#d568ea"],
  vscode: ["#1a85d4", "#69b1ff"],
  vue: ["#199f43", "#5ecc71"],
  wasm: ["#693acf", "#9d6afb"],
  webpack: ["#1a85d4", "#69b1ff"],
  yml: ["#d52c36", "#ff6762"],
  zig: ["#d47628", "#ffa359"],
  zip: ["#d47628", "#ffa359"],
};

function ensurePierreIconSprite(): void {
  if (document.getElementById(PIERRE_ICON_SPRITE_ID)) return;
  const container = document.createElement("div");
  container.id = PIERRE_ICON_SPRITE_ID;
  container.setAttribute("aria-hidden", "true");
  container.style.position = "absolute";
  container.style.width = "0";
  container.style.height = "0";
  container.style.overflow = "hidden";
  container.style.pointerEvents = "none";
  container.innerHTML = `${getBuiltInSpriteSheet("complete")}${T3_FILE_ICON_SPRITE}`;
  document.body.prepend(container);
}

export function FileEntryIcon({
  path,
  kind = "file",
  className,
}: {
  path: string;
  kind?: "file" | "directory";
  className?: string;
}) {
  useInsertionEffect(ensurePierreIconSprite, []);
  const theme = useResolvedTheme();
  const icon = useMemo(
    () =>
      kind === "directory"
        ? null
        : completeIconResolver.resolveIcon("file-tree-icon-file", path),
    [kind, path],
  );
  if (!icon) {
    const Fallback = kind === "directory" ? FolderIcon : FileIcon;
    return <Fallback className={cn("size-4 text-icon-muted", className)} />;
  }
  const colors = ICON_COLORS[icon.token ?? "default"] ?? ICON_COLORS.default;
  return (
    <svg
      aria-hidden="true"
      data-pierre-icon={icon.name}
      data-icon-token={icon.token}
      className={cn("size-4 shrink-0", className)}
      style={{ color: colors?.[theme === "light" ? 0 : 1] }}
      viewBox="0 0 16 16"
    >
      <use href={`#${icon.name}`} />
    </svg>
  );
}
