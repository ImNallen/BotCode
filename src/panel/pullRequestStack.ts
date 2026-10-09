// Shapes ported from pingdotgg/t3code v0.0.45 packages/contracts/src/pullRequest.ts (MIT).
import { z } from "zod";
import { pullRequestKey, type PullRequestKey } from "./pullRequestKey";
import { prObservation, mergeMethod } from "./prIdentity";
import type { PrAccess } from "./prInbox";
const stackLayerNavigation = z.object({
  number: z.number().int().positive(),
  title: z.string().nullable().optional(),
  isDraft: z.boolean().nullable().optional(),
  headBranch: z.string().trim().min(1),
  state: z.enum(["open", "closed", "merged"]),
});
const stackIdentity = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
  url: z.string().min(1),
  base: z.string().trim().min(1),
});
export const pullRequestStack = stackIdentity.extend({
  capabilities: z
    .object({ mergeMethods: z.array(mergeMethod), canRebase: z.boolean() })
    .default({ mergeMethods: [], canRebase: false }),
  layers: z.array(
    stackLayerNavigation.extend({
      headSha: z.string().min(1).nullable().optional(),
    }),
  ),
});
export const savedPullRequestStack = stackIdentity.extend({
  layers: z.array(stackLayerNavigation),
  observedAt: z.number().nonnegative(),
});
export const pullRequestStackMembership = z.object({
  number: z.number().int().positive(),
  position: z.number().int().positive(),
  size: z.number().int().positive(),
  base: z.string().trim().min(1),
});
export type PullRequestStack = z.infer<typeof pullRequestStack>;
export type PullRequestStackReference = { key: PullRequestKey; number: number };
export function stackLayerReference(
  reference: PullRequestStackReference,
  number: number,
): PullRequestStackReference {
  return {
    key: pullRequestKey.parse(
      `${reference.key.slice(0, reference.key.lastIndexOf("/"))}/${number}`,
    ),
    number,
  };
}
export function stackLayerAccess({
  key,
  linkedKeys,
  threadId,
  workspaceId,
}: {
  key: PullRequestKey;
  linkedKeys: readonly PullRequestKey[];
  threadId: string;
  workspaceId: string;
}): PrAccess {
  return linkedKeys.includes(key) ? threadId : { workspaceId };
}

export const prStackAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("merge"), method: mergeMethod }),
  z.object({ kind: z.literal("rebase") }),
]);
export const prStackChange = z.object({
  requestId: z.string().min(1),
  target: prObservation,
  stackNumber: z.number().int().positive(),
  expectedStackHeads: z
    .array(
      z.object({
        number: z.number().int().positive(),
        headSha: z.string().regex(/^[a-fA-F0-9]{40}$/),
      }),
    )
    .min(1),
  action: prStackAction,
});
const stackOutcome = z.enum(["merged", "enqueued", "rebased"]);
export const prStackResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("completed"), outcome: stackOutcome }),
  z.object({ kind: z.literal("accepted"), outcome: stackOutcome }),
  z.object({ kind: z.literal("refused"), message: z.string() }),
  z.object({ kind: z.literal("uncertain"), message: z.string() }),
  z.object({ kind: z.literal("pending"), message: z.string() }),
]);
export const prStackOperation = z.object({
  input: prStackChange,
  affectedKeys: z.array(pullRequestKey),
  progress: z.array(
    z.object({
      number: z.number().int().positive(),
      nodeId: z.string(),
      headSha: z.string(),
      updated: z.boolean(),
    }),
  ),
  dispatchedLayer: z.number().nullable(),
  mergeUuid: z.string().nullable(),
  result: prStackResult,
});
export type PrStackChange = z.infer<typeof prStackChange>;
export type PrStackOperation = z.infer<typeof prStackOperation>;
export function stackActionState(
  stack: PullRequestStack,
  reference: PullRequestStackReference,
  pending: boolean,
) {
  const unmerged = stack.layers.filter((layer) => layer.state !== "merged");
  const position =
    stack.layers.findIndex((layer) => layer.number === reference.number) + 1;
  const mergeLayers = stack.layers
    .slice(0, position)
    .filter((layer) => layer.state !== "merged");
  const selectedLayer = stack.layers[position - 1];
  const mergeHasClosed = mergeLayers.some((layer) => layer.state !== "open");
  return {
    unmerged,
    position,
    mergeLayers,
    selectedLayer,
    mergeHasClosed,
    mergeDisabled:
      pending ||
      selectedLayer?.state !== "open" ||
      mergeLayers.some((layer) => !layer.headSha) ||
      mergeHasClosed ||
      mergeLayers.length === 0 ||
      mergeLayers.some((layer) => layer.isDraft),
    rebaseDisabled:
      pending ||
      unmerged.some((layer) => !layer.headSha || layer.state !== "open") ||
      unmerged.length === 0,
  };
}
export function stackActionInput({
  stack,
  reference,
  target,
  requestId,
  action,
}: {
  stack: PullRequestStack;
  reference: PullRequestStackReference;
  target: z.infer<typeof prObservation>;
  requestId: string;
  action: z.infer<typeof prStackAction>;
}): PrStackChange {
  const { mergeLayers, unmerged } = stackActionState(stack, reference, false);
  return prStackChange.parse({
    requestId,
    target,
    stackNumber: stack.number,
    expectedStackHeads: (action.kind === "merge" ? mergeLayers : unmerged).map(
      (layer) => ({ number: layer.number, headSha: layer.headSha }),
    ),
    action,
  });
}
