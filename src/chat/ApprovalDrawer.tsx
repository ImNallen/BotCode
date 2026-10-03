// Mirrors pingdotgg/t3code v0.0.45 ComposerPendingApprovalPanel.tsx and
// ComposerPendingApprovalActions.tsx inside the composer top drawer (MIT).
import { EllipsisIcon, ShieldIcon } from "lucide-react";
import type { Approval, ApprovalDecision } from "../ipc";
import { Button } from "../ui/controls";
import { Menu, MenuItem } from "../ui/menu";
import { ComposerBanner } from "./ComposerBanner";

export function ApprovalDrawer({
  approval,
  pendingCount,
  busy,
  onAnswer,
}: {
  approval: Approval;
  pendingCount: number;
  busy: boolean;
  onAnswer: (decision: ApprovalDecision) => void;
}) {
  const label =
    approval.action.kind === "command"
      ? "Command approval"
      : "File change approval";
  const detail =
    approval.action.kind === "command"
      ? approval.action.command
      : approval.action.text;
  return (
    <ComposerBanner.Attachment className="flex items-end gap-1">
      <div className="flex min-w-0 flex-1 flex-col empty:hidden [&>[data-slot=composer-banner-attachment]]:w-full [&>[data-slot=composer-banner-attachment]:last-child]:mb-0">
        <ComposerBanner.Attachment>
          <ComposerBanner.Root
            data-chat-composer-top-drawer="true"
            variant="warning"
            density="spacious"
          >
            <ComposerBanner.Row layout="approval">
              <ComposerBanner.Icon>
                <ShieldIcon />
              </ComposerBanner.Icon>
              <ComposerBanner.Content>
                <span
                  aria-label={label}
                  className="flex min-w-0 flex-1 flex-col items-start gap-1"
                  role="group"
                >
                  <span className="flex w-full min-w-0 items-center gap-2 text-2xs text-muted-foreground">
                    <span className="shrink-0 font-medium text-warning">
                      {label}
                    </span>
                    {approval.action.reason ? (
                      <span className="min-w-0 truncate">
                        {approval.action.reason}
                      </span>
                    ) : null}
                    {pendingCount > 1 ? (
                      <span className="ml-auto shrink-0 tabular-nums">
                        1/{pendingCount}
                      </span>
                    ) : null}
                  </span>
                  <code
                    className="block max-h-20 w-full min-w-0 overflow-auto text-xs text-foreground [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 [&::-webkit-scrollbar]:h-1.5 whitespace-pre font-mono"
                    data-approval-detail="complete"
                    tabIndex={0}
                  >
                    {detail || "The provider has not supplied action details."}
                  </code>
                </span>
              </ComposerBanner.Content>
              <ComposerBanner.Actions>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => onAnswer("decline")}
                >
                  <span className="max-w-40 truncate">Decline</span>
                </Button>
                <Button
                  size="xs"
                  variant="default"
                  disabled={busy || !detail}
                  onClick={() => onAnswer("accept")}
                >
                  <span className="max-w-40 truncate">Approve</span>
                </Button>
                <Menu
                  side="top"
                  align="end"
                  trigger={(props) => (
                    <Button
                      size="icon-xs"
                      variant="outline"
                      aria-label="More approval options"
                      disabled={busy}
                      {...props}
                    >
                      <EllipsisIcon />
                    </Button>
                  )}
                >
                  <MenuItem onClick={() => onAnswer("cancel")}>
                    <span className="min-w-0 whitespace-normal wrap-break-word">
                      Cancel turn
                    </span>
                  </MenuItem>
                </Menu>
              </ComposerBanner.Actions>
            </ComposerBanner.Row>
          </ComposerBanner.Root>
        </ComposerBanner.Attachment>
      </div>
    </ComposerBanner.Attachment>
  );
}
