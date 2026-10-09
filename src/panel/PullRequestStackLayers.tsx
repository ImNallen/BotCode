// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/pullRequest/PullRequestStackLayers.tsx (MIT).
import { CheckIcon } from "lucide-react";
import { MenuItem, MenuGroupLabel } from "../ui/menu";
import { PullRequestStackLayerContent } from "./PullRequestStackLayerContent";
import {
  stackLayerReference,
  type PullRequestStack,
  type PullRequestStackReference,
} from "./pullRequestStack";
export function PullRequestStackLayers({
  stack,
  reference,
  onSelect,
  pending = false,
}: {
  stack: PullRequestStack;
  reference: PullRequestStackReference;
  onSelect?: (reference: PullRequestStackReference) => void;
  pending?: boolean;
}) {
  return (
    <div className="max-h-80 overflow-y-auto">
      {stack.layers.toReversed().map((layer) => (
        <MenuItem
          key={layer.number}
          onClick={() =>
            onSelect?.(stackLayerReference(reference, layer.number))
          }
          disabled={!onSelect || pending}
          aria-current={layer.number === reference.number ? "true" : undefined}
        >
          <PullRequestStackLayerContent layer={layer} />
          {layer.number === reference.number ? (
            <CheckIcon aria-hidden className="size-3.5" />
          ) : null}
        </MenuItem>
      ))}
      <MenuGroupLabel>↳ {stack.base}</MenuGroupLabel>
    </div>
  );
}
