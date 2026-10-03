// Monogram and color derivation copied from pingdotgg/t3code v0.0.45
// projectIdentity.ts, projectIconColors.ts and ProjectMonogram.tsx (MIT).
// The scratch icon follows chat/DraftHeroHeadline.tsx at 6b286ae8a (MIT).
import { MessageSquareDashedIcon } from "lucide-react";
import type { Workspace } from "./ipc";
import { cn } from "./lib/cn";

const COLORS = [
  "text-gray-600 dark:text-gray-400",
  "text-red-600 dark:text-red-400",
  "text-orange-600 dark:text-orange-400",
  "text-amber-600 dark:text-amber-400",
  "text-yellow-600 dark:text-yellow-400",
  "text-lime-600 dark:text-lime-400",
  "text-green-600 dark:text-green-400",
  "text-emerald-600 dark:text-emerald-400",
  "text-teal-600 dark:text-teal-400",
  "text-cyan-600 dark:text-cyan-400",
  "text-sky-600 dark:text-sky-400",
  "text-blue-600 dark:text-blue-400",
  "text-indigo-600 dark:text-indigo-400",
  "text-violet-600 dark:text-violet-400",
  "text-purple-600 dark:text-purple-400",
  "text-fuchsia-600 dark:text-fuchsia-400",
  "text-pink-600 dark:text-pink-400",
  "text-rose-600 dark:text-rose-400",
];

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

function colorClassName(name: string): string {
  const seed = normalize(name).toLocaleLowerCase("en-US") || "project";
  let index = 0;
  for (const glyph of seed)
    index = (index * 31 + (glyph.codePointAt(0) ?? 0)) % COLORS.length;
  return COLORS[index] ?? "text-blue-600 dark:text-blue-400";
}

export function ProjectBadge({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const text = monogram(name);
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
          colorClassName(name),
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
  workspace: Pick<Workspace, "kind" | "label">;
  className?: string;
}) {
  return workspace.kind === "scratch" ? (
    <span
      aria-hidden="true"
      className={cn("inline-flex size-4 shrink-0", COLORS[0], className)}
    >
      <MessageSquareDashedIcon className="size-full" />
    </span>
  ) : (
    <ProjectBadge name={workspace.label} className={className} />
  );
}
