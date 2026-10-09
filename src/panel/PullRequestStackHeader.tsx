// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/pullRequest/PullRequestStackHeader.tsx (MIT).
import { MenuGroupLabel } from "../ui/menu";
import { Tooltip } from "../ui/tooltip";
export function PullRequestStackHeader({
  number,
  notice,
  stale = false,
}: {
  number: number;
  notice?: string | null;
  stale?: boolean;
}) {
  return (
    <MenuGroupLabel>
      <div className="flex items-center justify-between gap-2">
        <span>Stack #{number}</span>
        {notice ? (
          <Tooltip content={notice}>
            <span role="status" className="text-xs font-normal">
              {stale ? "May be stale" : "Refreshing…"}
            </span>
          </Tooltip>
        ) : null}
      </div>
    </MenuGroupLabel>
  );
}
