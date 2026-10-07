// Ported from T3 Code v0.0.45 chat/ComposerPendingApprovalPanel.tsx and ComposerPendingApprovalActions.tsx (MIT).
import { EllipsisIcon, ShieldIcon, TriangleAlertIcon } from "lucide-react";
import type { Approval, ApprovalDecision } from "../ipc";
import { cn } from "../lib/cn";
import { Button } from "../ui/controls";
import { Menu, MenuItem } from "../ui/menu";
import { ComposerBanner } from "./ComposerBanner";

function approvalDetail(action: Approval["action"]): {
  label: string;
  detailLabel: string;
  detail: string;
} {
  switch (action.kind) {
    case "command":
      return {
        label: "Command approval",
        detailLabel: "Command",
        detail: action.command,
      };
    case "file_change":
      return {
        label: "File change approval",
        detailLabel: "File change",
        detail: action.text,
      };
    case "permission":
      return {
        label: "App permission approval",
        detailLabel: "Permission request",
        detail: action.detail,
      };
    case "mcp_elicitation":
      return {
        label: "App access approval",
        detailLabel: "App access request",
        detail: action.detail,
      };
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

export function ApprovalDetails({
  approval,
  pendingCount,
}: {
  approval: Approval;
  pendingCount: number;
}) {
  const { label, detailLabel, detail } = approvalDetail(approval.action);
  const isAppAccess = approval.action.kind === "mcp_elicitation";
  const Detail = isAppAccess ? "span" : "code";
  const context =
    approval.action.kind === "mcp_elicitation"
      ? approval.action.appName
      : approval.action.reason;
  return (
    <span
      aria-label={label}
      className="flex min-w-0 flex-1 flex-col items-start gap-1"
      role="group"
    >
      <span className="flex w-full min-w-0 items-center gap-2 text-2xs text-muted-foreground">
        <span className="shrink-0 font-medium text-warning">{label}</span>
        {context ? <span className="min-w-0 truncate">{context}</span> : null}
        {pendingCount > 1 ? (
          <span className="ml-auto shrink-0 tabular-nums">
            1/{pendingCount}
          </span>
        ) : null}
      </span>
      <Detail
        aria-label={detailLabel}
        className={cn(
          "block max-h-20 w-full min-w-0 overflow-auto text-xs text-foreground [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 [&::-webkit-scrollbar]:h-1.5",
          isAppAccess
            ? "whitespace-pre-wrap font-sans wrap-break-word"
            : "whitespace-pre font-mono",
        )}
        data-approval-detail="complete"
        tabIndex={0}
      >
        {detail || label}
      </Detail>
    </span>
  );
}

export function ApprovalActions({
  approval,
  busy,
  onAnswer,
}: {
  approval: Approval;
  busy: boolean;
  onAnswer: (decision: ApprovalDecision) => void;
}) {
  const reviewable = approvalDetail(approval.action).detail.trim().length > 0;
  const disabled = (decision: ApprovalDecision) =>
    busy || (!reviewable && decision !== "decline" && decision !== "cancel");
  const primaryOptions = approval.options.filter(
    (option) => option.decision === "decline" || option.decision === "accept",
  );
  const moreOptions = approval.options.filter(
    (option) => option.decision !== "decline" && option.decision !== "accept",
  );
  return (
    <>
      {primaryOptions.map((option) => (
        <Button
          key={option.decision}
          size="xs"
          variant={option.decision === "accept" ? "default" : "outline"}
          disabled={disabled(option.decision)}
          aria-description={option.warning ?? undefined}
          title={option.warning ?? undefined}
          onClick={() => onAnswer(option.decision)}
        >
          {option.warning ? (
            <TriangleAlertIcon className="size-3 shrink-0" />
          ) : null}
          <span className="max-w-40 truncate">{option.label}</span>
        </Button>
      ))}
      {moreOptions.length > 0 ? (
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
          {moreOptions.map((option) => (
            <MenuItem
              key={option.decision}
              disabled={disabled(option.decision)}
              aria-description={option.warning ?? undefined}
              title={option.warning ?? undefined}
              className="mb-1 last:mb-0"
              onClick={() => onAnswer(option.decision)}
            >
              {option.warning ? (
                <TriangleAlertIcon className="size-3 text-warning" />
              ) : null}
              <span className="min-w-0 whitespace-normal wrap-break-word">
                {option.label}
              </span>
            </MenuItem>
          ))}
        </Menu>
      ) : null}
    </>
  );
}

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
                <ApprovalDetails
                  approval={approval}
                  pendingCount={pendingCount}
                />
              </ComposerBanner.Content>
              <ComposerBanner.Actions>
                <ApprovalActions
                  approval={approval}
                  busy={busy}
                  onAnswer={onAnswer}
                />
              </ComposerBanner.Actions>
            </ComposerBanner.Row>
          </ComposerBanner.Root>
        </ComposerBanner.Attachment>
      </div>
    </ComposerBanner.Attachment>
  );
}
