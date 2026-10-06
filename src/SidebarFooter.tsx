// Classes copied from pingdotgg/t3code v0.0.45 components/ui/sidebar.tsx and sidebar/SidebarChrome.tsx (MIT).
import {
  ArrowLeftIcon,
  ChartNoAxesColumnIcon,
  SettingsIcon,
} from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "./lib/cn";

const menuButton =
  "peer/menu-button flex w-full cursor-pointer items-center gap-[var(--sidebar-control-gap)] overflow-hidden text-left outline-hidden ring-ring transition-[width,height,padding] hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 active:bg-sidebar-row-active active:text-sidebar-foreground disabled:pointer-events-none disabled:opacity-64 aria-disabled:pointer-events-none aria-disabled:opacity-64 data-[active=true]:bg-sidebar-row-selected data-[active=true]:font-medium data-[active=true]:text-sidebar-foreground data-[state=open]:hover:bg-sidebar-row-hover data-[state=open]:hover:text-sidebar-foreground group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-[var(--sidebar-content-inset)]! [&>span:last-child]:truncate [&>svg:not([class*='size-'])]:size-4 [&>svg]:shrink-0 [&>svg]:text-[var(--sidebar-icon-color)] hover:[&>svg]:text-sidebar-foreground active:[&>svg]:text-sidebar-foreground data-[active=true]:[&>svg]:text-sidebar-foreground";
export function SidebarMenuButton({
  className,
  icon = false,
  ...props
}: ComponentProps<"button"> & { icon?: boolean }) {
  return (
    <button
      type="button"
      data-sidebar="menu-button"
      data-slot="sidebar-menu-button"
      className={cn(
        menuButton,
        "font-medium text-sidebar-muted-foreground/80",
        icon
          ? "size-8 justify-center rounded-[var(--control-radius)] p-0"
          : "h-8 rounded-[var(--control-radius)] px-[var(--sidebar-row-content-inset)] py-1.5 text-sm",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarFooter({
  pageOpen,
  onOpenSettings,
  onOpenUsage,
  onBack,
}: {
  pageOpen: boolean;
  onOpenSettings: () => void;
  onOpenUsage: () => void;
  onBack: () => void;
}) {
  return (
    <div
      data-sidebar="footer"
      data-slot="sidebar-footer"
      className="flex flex-col gap-2 px-[var(--sidebar-content-inset)] py-1"
    >
      <ul
        data-sidebar="menu"
        className={cn(
          "flex w-full min-w-0 flex-col gap-1",
          "flex-row items-center",
        )}
      >
        {pageOpen ? (
          <li className="group/menu-item relative min-w-0 flex-1">
            <SidebarMenuButton key="back" onClick={onBack}>
              <ArrowLeftIcon />
              <span>Back</span>
            </SidebarMenuButton>
          </li>
        ) : (
          <>
            <li className="group/menu-item relative shrink-0">
              <SidebarMenuButton
                key="settings"
                icon
                aria-label="Settings"
                title="Settings"
                data-settings-trigger
                onClick={onOpenSettings}
              >
                <SettingsIcon />
              </SidebarMenuButton>
            </li>
            <li className="group/menu-item relative shrink-0">
              <SidebarMenuButton
                key="usage"
                icon
                aria-label="Usage"
                title="Usage"
                onClick={onOpenUsage}
              >
                <ChartNoAxesColumnIcon />
              </SidebarMenuButton>
            </li>
          </>
        )}
      </ul>
    </div>
  );
}
