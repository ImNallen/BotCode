import { z } from "zod";
import { pullRequestKey } from "./pullRequestKey";
export const prObservation = z.object({
  key: pullRequestKey,
  nodeId: z.string().min(1),
  headOid: z.string().regex(/^[a-fA-F0-9]{40}$/),
  viewer: z.string().min(1),
});
export const mergeMethod = z.enum(["merge", "squash", "rebase"]);
