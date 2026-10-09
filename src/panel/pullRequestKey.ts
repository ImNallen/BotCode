import { z } from "zod";
export const pullRequestKey = z
  .string()
  .regex(/^github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/[1-9][0-9]*$/)
  .brand<"PullRequestKey">();
export type PullRequestKey = z.infer<typeof pullRequestKey>;
