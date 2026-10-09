// Ported from pingdotgg/t3code v0.0.45 PullRequestDetailPanel.tsx (MIT).
import { MenuRadioItem } from "../ui/menu";
import { MERGE_METHOD_LABELS } from "./prLifecycle";
import type { MergeMethod } from "./prReview";
import { PullRequestGlyph } from "./pullRequestPresentation";

export function PullRequestMergeMethods({
  allowed,
  selected,
  pending,
  onSelect,
}: {
  allowed: readonly MergeMethod[];
  selected: MergeMethod;
  pending: boolean;
  onSelect: (method: MergeMethod) => void;
}) {
  return (
    <div role="group" data-slot="menu-radio-group">
      {allowed.map((method) => (
        <MenuRadioItem
          key={method}
          checked={selected === method}
          disabled={pending}
          onClick={() => onSelect(method)}
        >
          <span className="flex min-w-0 items-center gap-2">
            <PullRequestGlyph.merged className="size-3.5" />
            <span>{MERGE_METHOD_LABELS[method]}</span>
          </span>
        </MenuRadioItem>
      ))}
    </div>
  );
}
