// Ported from pingdotgg/t3code v0.0.45 PullRequestStackPopover.tsx (MIT).
import { useState, type ComponentProps } from "react";
import { usePullRequestStack } from "./usePullRequestStack";
import { Menu, MenuGroupLabel, MenuItem } from "../ui/menu";
import { Tooltip } from "../ui/tooltip";
import type { PrAccess } from "./prInbox";
import {
  type PullRequestStack,
  type PullRequestStackReference,
  type pullRequestStackMembership,
} from "./pullRequestStack";
import type { z } from "zod";
import { PullRequestStackHeader } from "./PullRequestStackHeader";
import { PullRequestStackLayers } from "./PullRequestStackLayers";
import { PullRequestGlyph } from "./pullRequestPresentation";

type Membership = z.infer<typeof pullRequestStackMembership>;
type TriggerProps = {
  ref: (node: HTMLElement | null) => void;
  onClick: () => void;
  "aria-haspopup": "menu" | "dialog";
  "aria-expanded": boolean;
  "data-popup-open"?: "";
};

export function PullRequestStackPopoverTrigger({
  membership,
  trigger,
  onOpenWithFocus,
}: {
  onOpenWithFocus: (focus: "first" | "last") => void;
  membership: Membership;
  trigger: TriggerProps;
}) {
  return (
    <Tooltip
      content={`View stack #${membership.number}, layer ${membership.position} of ${membership.size}`}
    >
      <span className="inline-flex">
        <span
          {...trigger}
          role="button"
          tabIndex={0}
          className="inline-flex shrink-0 cursor-pointer items-center gap-1 text-xs font-normal text-muted-foreground"
          aria-label={`Stack ${membership.number}, layer ${membership.position} of ${membership.size}`}
          onClick={(event) => {
            event.stopPropagation();
            trigger.onClick();
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              if (!event.repeat) trigger.onClick();
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              onOpenWithFocus(event.key === "ArrowUp" ? "last" : "first");
            }
          }}
        >
          <PullRequestGlyph.stack aria-hidden className="size-3" />
          {membership.position}/{membership.size}
        </span>
      </span>
    </Tooltip>
  );
}

type BodyState =
  | {
      kind: "stack";
      stack: PullRequestStack;
      notice: string | null;
      error: boolean;
      refresh: () => void;
    }
  | { kind: "empty"; pending: boolean; error: string | null };

export function PullRequestStackPopoverContent({
  state,
  reference,
  stackNumber,
  onSelect,
}: {
  state: BodyState;
  reference: PullRequestStackReference;
  stackNumber: number;
  onSelect: (target: PullRequestStackReference) => void;
}) {
  return state.kind === "stack" ? (
    <>
      <PullRequestStackHeader
        number={state.stack.number}
        notice={state.notice}
        stale={state.error}
      />
      {state.error ? (
        <MenuItem onClick={state.refresh}>Retry stack refresh</MenuItem>
      ) : null}
      <PullRequestStackLayers
        stack={state.stack}
        reference={reference}
        onSelect={onSelect}
      />
    </>
  ) : (
    <>
      <PullRequestStackHeader number={stackNumber} />
      <MenuGroupLabel>
        {state.error ??
          (state.pending
            ? "Loading stack…"
            : "This pull request is no longer in a stack.")}
      </MenuGroupLabel>
    </>
  );
}

function StackBody({
  workspaceId,
  access,
  ...props
}: {
  workspaceId: string;
  access: PrAccess;
  reference: PullRequestStackReference;
  stackNumber: number;
  onSelect: (target: PullRequestStackReference) => void;
}) {
  const query = usePullRequestStack({
    workspaceId,
    access,
    reference: props.reference,
  });
  const state: BodyState = query.data
    ? {
        kind: "stack",
        stack: query.data,
        error: query.isError,
        notice: query.notice,
        refresh: () => void query.refetch(),
      }
    : {
        kind: "empty",
        pending: query.isPending,
        error: query.error?.message ?? null,
      };
  return <PullRequestStackPopoverContent {...props} state={state} />;
}

export function PullRequestStackPopover({
  workspaceId,
  access,
  reference,
  membership,
  onSelect,
}: {
  workspaceId: string;
  access: PrAccess;
  reference: PullRequestStackReference;
  membership: Membership;
  onSelect: (target: PullRequestStackReference) => void;
}) {
  const [open, setOpen] = useState(false);
  const [initialFocus, setInitialFocus] = useState<"first" | "last">("first");
  const isolateKey: ComponentProps<"div">["onKeyDown"] = (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  };
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      initialFocus={initialFocus}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={isolateKey}
      trigger={(trigger) => (
        <PullRequestStackPopoverTrigger
          membership={membership}
          trigger={{
            ...trigger,
            onClick: () => {
              setInitialFocus("first");
              trigger.onClick();
            },
          }}
          onOpenWithFocus={(focus) => {
            setInitialFocus(focus);
            setOpen(true);
          }}
        />
      )}
    >
      <div role="group">
        {open ? (
          <StackBody
            workspaceId={workspaceId}
            access={access}
            reference={reference}
            stackNumber={membership.number}
            onSelect={(target) => {
              setOpen(false);
              onSelect(target);
            }}
          />
        ) : null}
      </div>
    </Menu>
  );
}
