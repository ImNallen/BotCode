// Header and frame follow pingdotgg/t3code v0.0.45 components/usage/UsagePage.tsx, limits only (MIT).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { useState } from "react";
import { ipc } from "../ipc";
import { RefreshIcon } from "../panel/chrome";
import { Button } from "../ui/controls";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
} from "../WorkspaceBreadcrumb";
import { UsageLimitsSection } from "./UsageLimits";
import { usageLimitsQuery } from "./limits";

export function UsagePage() {
  const navigate = useNavigate();
  const selection = useSearch({ from: "__root__" });
  const client = useQueryClient();
  const limits = useQuery(usageLimitsQuery);
  const [refreshedAt, setRefreshedAt] = useState(Date.now);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();
  const refresh = async () => {
    setRefreshing(true);
    try {
      client.setQueryData(
        usageLimitsQuery.queryKey,
        await ipc.usageLimits(true),
      );
      setRefreshError(undefined);
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshing(false);
      setRefreshedAt(Date.now());
    }
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      <header
        data-tauri-drag-region="deep"
        className="flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-3 pl-(--workspace-gutter-start) pr-(--workspace-gutter-end) drag-region [[data-sidebar-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)]"
      >
        <WorkspaceBreadcrumb ariaLabel="Usage breadcrumb">
          <WorkspaceBreadcrumbItem>
            <h1>Usage</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        <div className="ms-auto flex min-w-0 items-center justify-end gap-2">
          <Button
            onClick={() => void refresh()}
            aria-label="Refresh limits"
            aria-busy={refreshing}
            disabled={refreshing}
            size="icon-sm"
            variant="ghost"
          >
            <RefreshIcon refreshing={refreshing} className="size-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="md:hidden [[data-sidebar-state=collapsed]_&]:inline-flex"
            onClick={() =>
              void navigate({
                to: "/",
                search: { ...selection, project: undefined },
                hash: "",
                resetScroll: false,
              })
            }
          >
            <ArrowLeftIcon className="size-4" />
            Back
          </Button>
        </div>
      </header>
      <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full flex-col gap-6 px-5 pt-6 pb-12 sm:px-6 max-w-5xl">
          <UsageLimitsSection
            limits={limits.data}
            error={refreshError ?? limits.error?.message}
            now={refreshedAt}
          />
        </div>
      </div>
    </div>
  );
}
