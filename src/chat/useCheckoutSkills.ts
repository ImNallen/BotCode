import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "../ipc";
import { useCallback } from "react";

export const SKILLS_STALE_TIME = 30_000;

export function checkoutSkillsQuery(root: string) {
  return queryOptions({
    queryKey: ["skills", root],
    queryFn: () => ipc.skills(root).catch(() => []),
    staleTime: SKILLS_STALE_TIME,
    retry: false,
  });
}

export function useCheckoutSkills(root: string | undefined) {
  const client = useQueryClient();
  const query = useQuery({
    ...checkoutSkillsQuery(root ?? ""),
    enabled: Boolean(root),
  });
  return {
    skills: root ? (query.data ?? []) : [],
    loading: Boolean(root) && query.isFetching,
    refreshIfStale: useCallback(() => {
      if (root) void client.fetchQuery(checkoutSkillsQuery(root));
    }, [client, root]),
  };
}
