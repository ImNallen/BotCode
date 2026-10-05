import { z } from "zod";

export const prSection = z.enum([
  "threads",
  "conversation_comments",
  "reviews",
  "checks",
  "files",
  "commits",
]);
export const prSectionProblem = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("failed"),
    section: prSection,
    message: z.string().max(500),
  }),
  z.object({
    kind: z.literal("limited"),
    section: prSection,
    message: z.string().max(500),
  }),
]);
export type PrSection = z.infer<typeof prSection>;
export type PrSectionProblem = z.infer<typeof prSectionProblem>;
const labels = {
  threads: "Review threads",
  conversation_comments: "Conversation comments",
  reviews: "Reviews",
  checks: "Checks",
  files: "Files",
  commits: "Commits",
} satisfies Record<PrSection, string>;
export function sectionProblemText(problem: PrSectionProblem): string {
  return `${labels[problem.section]} ${problem.kind === "failed" ? "unavailable" : "limited"}. ${problem.message}`;
}
export function coveragePrompt(problems: PrSectionProblem[]): string[] {
  if (!problems.length) return [];
  return [
    "PR coverage is incomplete. Do not claim all findings, checks, or changes were assessed. Load the missing evidence before making a complete assessment.",
    ...problems.slice(0, 6).map((problem) =>
      sectionProblemText({
        ...problem,
        message: problem.message.slice(0, 500),
      }),
    ),
  ];
}
