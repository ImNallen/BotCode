import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { ipc } from "../ipc";
export const githubReadinessKey = ["github-publish-readiness"];
export function useGitHubReadiness() {
  const query = useQuery({
    queryKey: githubReadinessKey,
    queryFn: ipc.githubPublishReadiness,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    retry: false,
  });
  const { refetch } = query;
  useEffect(() => {
    const refresh = () => {
      void refetch();
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refetch]);
  return query;
}
