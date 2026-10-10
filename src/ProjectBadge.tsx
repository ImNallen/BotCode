// Monogram and color derivation copied from pingdotgg/t3code v0.0.45
// projectIdentity.ts, projectIconColors.ts and ProjectMonogram.tsx (MIT).
// The scratch icon follows chat/DraftHeroHeadline.tsx at 6b286ae8a (MIT).
import { lazy, Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { IconName } from "lucide-react/dynamic";
import {
  PROJECT_ICON_COLORS,
  projectIconColorClassName,
} from "./project/projectIconColors";
import { MessageSquareDashedIcon, FolderCodeIcon } from "lucide-react";
import { ipc, native, type Workspace, type ProjectIconColor } from "./ipc";
import { cn } from "./lib/cn";

const COLORS = PROJECT_ICON_COLORS.map((option) => option.className);
const DynamicIcon = lazy(() =>
  import("lucide-react/dynamic").then((module) => ({
    default: module.DynamicIcon,
  })),
);

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function normalize(name: string): string {
  return name.normalize("NFKC").trim();
}

function monogram(name: string): string {
  const words = normalize(name).match(/[\p{L}\p{N}]+/gu) ?? [];
  const firstWord = words[0];
  if (!firstWord) return "PR";
  const glyphs = Array.from(firstWord);
  const first = glyphs[0] ?? "P";
  const second =
    glyphs.slice(1).find((glyph) => /\p{N}/u.test(glyph)) ??
    (words.length > 1 ? Array.from(words.at(-1) ?? "")[0] : glyphs.at(-1)) ??
    first;
  return Array.from(`${first}${second}`.toUpperCase()).slice(0, 2).join("");
}

export function deriveProjectIdentity(name: string): {
  monogram: string;
  color: ProjectIconColor;
} {
  const seed = normalize(name).toLocaleLowerCase("en-US") || "project";
  let index = 0;
  for (const glyph of seed)
    index = (index * 31 + (glyph.codePointAt(0) ?? 0)) % COLORS.length;
  return {
    monogram: monogram(name),
    color: PROJECT_ICON_COLORS[index]?.value ?? "blue",
  };
}

export function ProjectBadge({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const identity = deriveProjectIdentity(name);
  return (
    <ProjectMonogram
      text={identity.monogram}
      color={identity.color}
      className={className}
    />
  );
}

export function ProjectMonogram({
  text,
  color,
  className,
}: {
  text: string;
  color: ProjectIconColor;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center",
        className,
      )}
    >
      <svg
        viewBox="0 0 16 16"
        className={cn(
          "size-full overflow-hidden rounded-[25%] font-mono select-none",
          projectIconColorClassName(color),
        )}
        style={{
          backgroundColor: "color-mix(in srgb, currentColor 14%, transparent)",
        }}
      >
        <text
          x="8"
          y="10.8"
          textAnchor="middle"
          fill="currentColor"
          className="font-mono"
          fontSize="8.25"
          fontWeight="700"
          textLength={Array.from(segmenter.segment(text)).length === 1 ? 6 : 12}
          lengthAdjust="spacingAndGlyphs"
          textRendering="geometricPrecision"
        >
          {text}
        </text>
      </svg>
    </span>
  );
}

export function WorkspaceBadge({
  workspace,
  className,
}: {
  workspace: Workspace | { kind: "scratch"; label: string };
  className?: string;
}) {
  if (workspace.kind === "scratch")
    return (
      <span
        aria-hidden="true"
        className={cn("inline-flex size-4 shrink-0", COLORS[0], className)}
      >
        <MessageSquareDashedIcon className="size-full" />
      </span>
    );
  const icon = workspace.projectIcon;
  if (icon?.kind === "monogram")
    return (
      <ProjectMonogram
        text={icon.text}
        color={icon.color}
        className={className}
      />
    );
  if (icon?.kind === "emoji")
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex size-3.5 shrink-0 items-center justify-center leading-none [container-type:size]",
          className,
        )}
      >
        <span className="text-[length:80cqh] leading-none">{icon.emoji}</span>
      </span>
    );
  if (icon?.kind === "lucide") {
    const color = projectIconColorClassName(icon.color);
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex size-3.5 shrink-0 items-center justify-center",
          color,
          className,
        )}
      >
        <Suspense
          fallback={<FolderCodeIcon className="size-full text-inherit" />}
        >
          <DynamicIcon
            name={icon.name as IconName}
            className={cn("size-full", color)}
            fallback={() => (
              <FolderCodeIcon className="size-full text-inherit" />
            )}
          />
        </Suspense>
      </span>
    );
  }
  return <ProjectFavicon workspace={workspace} className={className} />;
}

function ProjectFavicon({
  workspace,
  className,
}: {
  workspace: Workspace;
  className?: string;
}) {
  const favicon = useQuery({
    queryKey: ["project-favicon", workspace.id, workspace.faviconPath],
    queryFn: () => ipc.projectFavicon(workspace.id),
    enabled: native,
    staleTime: 60_000,
  });
  const src = favicon.data?.dataUrl;
  return src ? (
    <FaviconImage
      key={src}
      src={src}
      name={workspace.label}
      className={className}
    />
  ) : (
    <ProjectBadge name={workspace.label} className={className} />
  );
}
function FaviconImage({
  src,
  name,
  className,
}: {
  src: string;
  name: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <ProjectBadge name={name} className={className} />
  ) : (
    <img
      src={src}
      alt=""
      className={cn(
        "size-3.5 shrink-0 rounded-[25%] object-contain",
        className,
      )}
      onError={() => setFailed(true)}
    />
  );
}
