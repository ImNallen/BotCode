// Ported from T3 Code v0.0.45 apps/web/src/components/chat/ComposerPrimaryActions.tsx (MIT).
import { ChevronDownIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { Menu, MenuItem } from "../ui/menu";

const messageActionPillClassName =
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-message-action font-medium text-base text-message-action-foreground shadow-xs shadow-message-action/24 outline-none hover:bg-message-action-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none sm:text-sm";

export function ComposerPrimaryActions(props: {
  running: boolean;
  canStop: boolean;
  stopping: boolean;
  canSend: boolean;
  followUpBehavior: "queue" | "steer";
  showPlanFollowUp: boolean;
  promptHasText: boolean;
  onStop: () => void;
  onImplementInNewThread: () => void;
}) {
  if (props.showPlanFollowUp) {
    if (props.promptHasText)
      return (
        <button
          type="submit"
          disabled={!props.canSend}
          className={cn(messageActionPillClassName, "h-9 sm:h-8", "px-4")}
        >
          Refine
        </button>
      );
    return (
      <div
        data-chat-composer-implement-actions="true"
        className="flex items-center justify-end"
      >
        <button
          type="submit"
          disabled={!props.canSend}
          className={cn(
            messageActionPillClassName,
            "h-9 rounded-r-none px-4 sm:h-8",
          )}
        >
          Implement
        </button>
        <Menu
          align="end"
          side="top"
          trigger={(trigger) => (
            <button
              type="button"
              ref={trigger.ref}
              onClick={trigger.onClick}
              aria-haspopup={trigger["aria-haspopup"]}
              aria-expanded={trigger["aria-expanded"]}
              aria-label="Implementation actions"
              disabled={!props.canSend}
              className={cn(
                messageActionPillClassName,
                "h-9 rounded-l-none border-l border-message-action-foreground/20 px-2 sm:h-8",
              )}
            >
              <ChevronDownIcon className="size-3.5" />
            </button>
          )}
        >
          <MenuItem
            disabled={!props.canSend}
            onClick={props.onImplementInNewThread}
          >
            Implement in a new thread
          </MenuItem>
        </Menu>
      </div>
    );
  }
  return (
    <>
      {props.running && props.canStop ? (
        <button
          type="button"
          disabled={props.stopping}
          onClick={props.onStop}
          aria-label="Stop generation"
          className="flex cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-2xs inset-shadow-white/16 transition-all duration-150 hover:bg-destructive hover:scale-105 active:inset-shadow-black/8 active:shadow-none size-8 sm:h-8 sm:w-8"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="currentColor"
            aria-hidden="true"
          >
            <rect x="2" y="2" width="8" height="8" rx="1.5" />
          </svg>
        </button>
      ) : null}
      {!props.running || props.canSend ? (
        <button
          type="submit"
          disabled={!props.canSend}
          aria-label={
            props.running
              ? props.followUpBehavior === "steer"
                ? "Send now"
                : "Queue message"
              : "Send message"
          }
          className="relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-2xs enabled:inset-shadow-white/16 hover:scale-105 active:inset-shadow-black/8 active:shadow-none disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8 bg-message-action text-message-action-foreground enabled:shadow-message-action/24 hover:bg-message-action-hover"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      ) : null}
    </>
  );
}
