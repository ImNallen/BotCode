// Ported from pingdotgg/t3code v0.0.45 state/usePullRequestStack.ts (MIT).
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { checkoutKey, ipc } from "../ipc";
import type { PrAccess } from "./prInbox";
import type { PullRequestStackReference } from "./pullRequestStack";
import {
  pullRequestStackView,
  savedPullRequestStack,
} from "./pullRequestStackSnapshot";

export function usePullRequestStack({
  workspaceId,
  access,
  reference,
}: {
  workspaceId: string;
  access: PrAccess;
  reference: PullRequestStackReference;
}) {
  const workspace = useQuery({
    queryKey: checkoutKey("workspace", { workspaceId }),
    queryFn: () => ipc.workspace({ workspaceId }),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const saved = useMemo(
    () =>
      savedPullRequestStack(
        workspace.data?.threads.flatMap(
          (thread) => thread.pullRequests.links,
        ) ?? [],
        reference,
      ),
    [workspace.data?.threads, reference.key, reference.number],
  );
  const query = useQuery({
    queryKey: ["pr-stack", access, reference.key],
    queryFn: () => ipc.readPullRequestStack(access, reference.key),
    retry: false,
    refetchOnWindowFocus: false,
  });
  return {
    ...query,
    ...pullRequestStackView(
      {
        data: query.data ?? null,
        isSuccess: query.isSuccess,
        isPending: query.isPending || query.isFetching,
        error: query.error?.message ?? null,
      },
      saved,
    ),
  };
}
