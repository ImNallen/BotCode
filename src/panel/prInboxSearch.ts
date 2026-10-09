// Preferences and selected detail follow T3 Code v0.0.45 pullRequestListPreferences.ts and _chat.pull-requests.tsx (MIT).
import { z } from "zod";
export const prInboxSearchSchema = z.object({
  involvement: z.enum(["all", "reviewing", "authored"]).default("all"),
  state: z.enum(["all", "open", "closed", "merged"]).default("open"),
  sort: z
    .enum([
      "ready",
      "blocked",
      "updated",
      "newest",
      "oldest",
      "largest",
      "smallest",
    ])
    .default("ready"),
  q: z.string().max(200).default(""),
  projectId: z.uuid().optional(),
  draft: z.enum(["only", "hide"]).optional(),
  review: z
    .enum(["approved", "changes-requested", "review-required", "none"])
    .optional(),
  checks: z.enum(["passing", "failing"]).optional(),
  author: z.string().max(200).optional(),
  labels: z.array(z.string().max(200)).max(10).optional(),
  repository: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .optional(),
  number: z.coerce.number().int().positive().optional(),
  selectedProjectId: z.uuid().optional(),
});
export type PrInboxSearch = z.infer<typeof prInboxSearchSchema>;
export function readPrInboxPreferences() {
  try {
    return prInboxSearchSchema.parse(
      JSON.parse(localStorage.getItem("bot.pullRequests.preferences") ?? "{}"),
    );
  } catch {
    return prInboxSearchSchema.parse({});
  }
}
export function validatePrInboxSearch(raw: unknown) {
  const record = z.record(z.string(), z.unknown()).safeParse(raw);
  const input = record.success ? record.data : {};
  return prInboxSearchSchema.parse(
    Object.fromEntries(
      Object.entries(prInboxSearchSchema.shape).flatMap(([key, schema]) => {
        const parsed = schema.safeParse(input[key]);
        return parsed.success ? [[key, parsed.data]] : [];
      }),
    ),
  );
}
export function savePrInboxPreferences({
  repository: _repository,
  number: _number,
  selectedProjectId: _selectedProjectId,
  ...preferences
}: PrInboxSearch) {
  try {
    localStorage.setItem(
      "bot.pullRequests.preferences",
      JSON.stringify(preferences),
    );
  } catch {}
}

export function clearPrInboxFilters(search: PrInboxSearch): PrInboxSearch {
  return {
    ...search,
    state: "open",
    involvement: "all",
    projectId: undefined,
    draft: undefined,
    review: undefined,
    checks: undefined,
    author: undefined,
    labels: undefined,
  };
}
