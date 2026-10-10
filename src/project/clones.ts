// Ports T3 Code v0.0.45 packages/contracts/src/projectClone.ts (MIT).
import { z } from "zod";

export const projectCloneSnapshot = z.object({
  workspaceId: z.uuid(),
  remoteUrl: z.string(),
  destinationPath: z.string(),
  phase: z.enum(["running", "done", "failed", "cancelled"]),
  stage: z.enum([
    "connecting",
    "counting",
    "receiving",
    "resolving",
    "checkout",
  ]),
  percent: z.number().int().min(0).max(100).nullable(),
  detail: z.string().max(200).nullable(),
  error: z.string().max(1000).nullable(),
  startedAtMs: z.number(),
  endedAtMs: z.number().nullable(),
  sequence: z.number(),
});
export type ProjectCloneSnapshot = z.infer<typeof projectCloneSnapshot>;
const stages = {
  connecting: "Connecting",
  counting: "Counting objects",
  receiving: "Receiving objects",
  resolving: "Resolving deltas",
  checkout: "Checking out files",
};
export function cloneName(clone: ProjectCloneSnapshot) {
  return (
    clone.destinationPath.split(/[\\/]/).filter(Boolean).at(-1) ??
    clone.destinationPath
  );
}
export function cloneProgress(clone: ProjectCloneSnapshot) {
  return [
    stages[clone.stage],
    ...(clone.percent === null ? [] : [`${clone.percent}%`]),
    ...(clone.detail ? [clone.detail] : []),
  ].join(" · ");
}
export function cloneFolder(url: string) {
  const leaf = url
    .trim()
    .replace(/[\\/]+$/, "")
    .split(/[\\/:]/)
    .at(-1)
    ?.replace(/\.git$/, "");
  return leaf &&
    /^[\p{L}\p{N}._-]+$/u.test(leaf) &&
    leaf !== "." &&
    leaf !== ".."
    ? leaf
    : "repository";
}
