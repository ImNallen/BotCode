// Ported from pingdotgg/t3code v0.0.45 components/Sidebar.logic.ts (MIT).
import {
  defaultAnimateLayoutChanges,
  type AnimateLayoutChanges,
} from "@dnd-kit/sortable";
import type { Arrange, ThreadSummary } from "./ipc";
import { planPinnedReorder } from "./lib/threadSort";

// Sortable transforms own dragging; replaying their committed DOM order
// would animate the drop twice.
export const animateSidebarLayoutChanges: AnimateLayoutChanges = (args) =>
  args.isSorting ? defaultAnimateLayoutChanges(args) : false;

export type SidebarSection =
  | "pinned"
  | "active"
  | "working"
  | "snoozed"
  | "settled";

const SIDEBAR_MARKER_PREFIX = "sidebar-marker-";

export type SidebarListMarker =
  | "pinned-header"
  | "active-placeholder"
  | "settled-placeholder"
  | "pinned-divider"
  | "working-header"
  | "snoozed-header"
  | "settled-header";

export function sidebarMarkerId(marker: SidebarListMarker): string {
  return `${SIDEBAR_MARKER_PREFIX}${marker}`;
}

export type SidebarListItem =
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly section: SidebarSection;
    }
  | { readonly kind: "marker"; readonly marker: SidebarListMarker };

export function sidebarListItemId(item: SidebarListItem): string {
  return item.kind === "thread" ? item.key : sidebarMarkerId(item.marker);
}

function sectionAtSidebarSlot(
  items: readonly SidebarListItem[],
  index: number,
): SidebarSection {
  let section: SidebarSection = "pinned";
  for (let i = 0; i < index && i < items.length; i += 1) {
    const item = items[i]!;
    if (item.kind !== "marker") continue;
    if (item.marker === "pinned-divider") section = "active";
    else if (item.marker === "working-header") section = "working";
    else if (item.marker === "snoozed-header") section = "snoozed";
    else if (item.marker === "settled-header") section = "settled";
  }
  return section;
}

export type SidebarDropTarget = {
  readonly section: "pinned" | "active" | "settled";
  readonly pinnedOrder: readonly string[];
  readonly activeOrder: readonly string[];
};

export function resolveSidebarDropTarget(
  items: readonly SidebarListItem[],
  activeKey: string,
  overId: string,
): SidebarDropTarget | null {
  const activeIndex = items.findIndex(
    (item) => sidebarListItemId(item) === activeKey,
  );
  const overIndex = items.findIndex(
    (item) => sidebarListItemId(item) === overId,
  );
  if (
    activeIndex === -1 ||
    overIndex === -1 ||
    items[activeIndex]?.kind !== "thread"
  )
    return null;
  const moved = items.filter((_, index) => index !== activeIndex);
  moved.splice(overIndex, 0, items[activeIndex]!);
  const section = sectionAtSidebarSlot(moved, overIndex);
  if (section === "working" || section === "snoozed") return null;
  const pinnedOrder: string[] = [];
  const activeOrder: string[] = [];
  let currentSection: SidebarSection = "pinned";
  for (const item of moved) {
    if (item.kind === "marker") {
      if (item.marker === "pinned-divider") currentSection = "active";
      else if (
        item.marker === "working-header" ||
        item.marker === "snoozed-header" ||
        item.marker === "settled-header"
      )
        break;
    } else if (currentSection === "pinned") pinnedOrder.push(item.key);
    else activeOrder.push(item.key);
  }
  return { section, pinnedOrder, activeOrder };
}

type OrderAssignments = ReadonlyArray<{
  readonly id: string;
  readonly orderKey: string;
}>;

export type SidebarThreadDropPlan =
  | { readonly kind: "none" }
  | {
      readonly kind: "reorder-pinned";
      readonly order: readonly string[];
      readonly assignments: OrderAssignments;
    }
  | {
      readonly kind: "pin";
      readonly order: readonly string[];
      readonly orderKey: string | undefined;
      readonly extraAssignments: OrderAssignments;
    }
  | {
      readonly kind: "move-active";
      readonly order: readonly string[] | null;
      readonly assignments: OrderAssignments;
      readonly unpin: boolean;
      readonly unsettle: boolean;
      readonly unsnooze: boolean;
    }
  | { readonly kind: "settle" };

export type SidebarDropVerb = "pin" | "unpin" | "settle" | "unsettle" | "wake";

export function resolveSidebarDropVerb(
  from: SidebarSection,
  to: SidebarSection | null,
): SidebarDropVerb | null {
  if (to === null || to === from || to === "working" || to === "snoozed")
    return null;
  if (to === "pinned") return "pin";
  if (to === "settled") return "settle";
  if (from === "pinned") return "unpin";
  if (from === "settled") return "unsettle";
  return "wake";
}

const sameOrder = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length &&
  left.every((key, index) => key === right[index]);

export function planSidebarThreadDrop(input: {
  readonly activeKey: string;
  readonly activeSection: SidebarSection;
  readonly activePinned?: boolean;
  readonly activeSettled?: boolean;
  readonly target: SidebarDropTarget;
  readonly pinnedOrder: readonly string[];
  readonly pinnedKeysById: ReadonlyMap<string, string | null | undefined>;
  readonly activeOrder: readonly string[];
  readonly activeKeysById: ReadonlyMap<string, string | null | undefined>;
  readonly activeTimeOrdered?: boolean;
}): SidebarThreadDropPlan {
  const {
    activeKey,
    activeSection,
    activePinned = activeSection === "pinned",
    activeSettled = activeSection === "settled",
    target,
    pinnedOrder,
    pinnedKeysById,
    activeOrder,
    activeKeysById,
  } = input;
  switch (target.section) {
    case "active": {
      if (input.activeTimeOrdered) {
        return activeSection === "active"
          ? { kind: "none" }
          : {
              kind: "move-active",
              order: null,
              assignments: [],
              unpin: activePinned,
              unsettle: activeSettled,
              unsnooze: activeSection === "snoozed",
            };
      }
      const order = target.activeOrder;
      if (activeSection === "active" && sameOrder(order, activeOrder)) {
        return { kind: "none" };
      }
      return {
        kind: "move-active",
        order,
        assignments: planPinnedReorder({
          orderedIds: order,
          keysById: activeKeysById,
          movedId: activeKey,
        }),
        unpin: activePinned,
        unsettle: activeSettled,
        unsnooze: activeSection === "snoozed",
      };
    }
    case "settled":
      return activeSection === "settled"
        ? { kind: "none" }
        : { kind: "settle" };
    case "pinned": {
      const order = target.pinnedOrder;
      if (activeSection === "pinned" && sameOrder(order, pinnedOrder)) {
        return { kind: "none" };
      }
      const assignments = planPinnedReorder({
        orderedIds: order,
        keysById: pinnedKeysById,
        movedId: activeKey,
      });
      if (activeSection === "pinned") {
        return assignments.length === 0
          ? { kind: "none" }
          : { kind: "reorder-pinned", order, assignments };
      }
      return {
        kind: "pin",
        order,
        orderKey: assignments.find((assignment) => assignment.id === activeKey)
          ?.orderKey,
        extraAssignments: activePinned
          ? assignments
          : assignments.filter((assignment) => assignment.id !== activeKey),
      };
    }
  }
}

export function sidebarDropCommands(
  activeKey: string,
  plan: Exclude<SidebarThreadDropPlan, { kind: "settle" }>,
): Array<{ readonly threadId: string; readonly action: Arrange }> {
  const lifecycle = (action: Arrange) => [{ threadId: activeKey, action }];
  const keyWrites = (
    kind: "reorder_pin" | "reorder_active",
    assignments: OrderAssignments,
  ) =>
    assignments.map(({ id, orderKey }) => ({
      threadId: id,
      action: { kind, orderKey },
    }));
  switch (plan.kind) {
    case "none":
      return [];
    case "reorder-pinned":
      return keyWrites("reorder_pin", plan.assignments);
    case "pin":
      return [
        ...lifecycle(
          plan.orderKey === undefined
            ? { kind: "pin" }
            : { kind: "pin", orderKey: plan.orderKey },
        ),
        ...keyWrites("reorder_pin", plan.extraAssignments),
      ];
    case "move-active":
      return [
        ...(plan.unpin ? lifecycle({ kind: "unpin" }) : []),
        ...(plan.unsettle ? lifecycle({ kind: "unsettle" }) : []),
        ...(plan.unsnooze ? lifecycle({ kind: "wake" }) : []),
        ...keyWrites("reorder_active", plan.assignments),
      ];
  }
}

export function applySidebarThreadDrop(
  thread: ThreadSummary,
  section: "pinned" | "active" | "settled",
  nowMs: number,
  orderKey?: string,
): ThreadSummary {
  const wasSettled = thread.settledAtMs !== null;
  const awake = { ...thread, snoozedUntilMs: null };
  if (section === "settled") {
    return {
      ...awake,
      pinnedAtMs: null,
      pinOrderKey: null,
      activeOrderKey: null,
      settledAtMs: thread.settledAtMs ?? nowMs,
      unsettledAtMs: null,
    };
  }
  const resumed = wasSettled
    ? { ...awake, settledAtMs: null, unsettledAtMs: nowMs }
    : awake;
  return {
    ...resumed,
    pinnedAtMs: section === "pinned" ? (thread.pinnedAtMs ?? nowMs) : null,
    pinOrderKey: section === "pinned" ? (orderKey ?? thread.pinOrderKey) : null,
    ...(section === "active" && orderKey !== undefined
      ? { activeOrderKey: orderKey }
      : {}),
  };
}

export function orderItemsByPreferredIds<TItem, TId>(input: {
  items: readonly TItem[];
  preferredIds: readonly TId[];
  getId: (item: TItem) => TId;
}): TItem[] {
  const { getId, items, preferredIds } = input;
  const indexById = new Map(items.map((item, index) => [getId(item), index]));
  const emitted = new Set<number>();
  const ordered = preferredIds.flatMap((id) => {
    const index = indexById.get(id);
    if (index === undefined || emitted.has(index)) return [];
    emitted.add(index);
    return [items[index]!];
  });
  return [...ordered, ...items.filter((_, index) => !emitted.has(index))];
}

export type SidebarOptimisticDrop = {
  readonly key: string;
  readonly sourceSection: SidebarSection;
  readonly section: "pinned" | "active" | "settled";
  readonly atMs: number;
  readonly clearsSnooze: boolean;
  readonly order: readonly string[] | null;
  readonly keysAtDrop: ReadonlyMap<string, string | null>;
  readonly assignedKeys: ReadonlyMap<string, string>;
};

export function releasesSidebarDrop(input: {
  readonly drop: SidebarOptimisticDrop;
  readonly threadsById: ReadonlyMap<string, ThreadSummary>;
  readonly destinationIds: readonly string[];
  readonly nowMs: number;
}): boolean {
  const { drop, threadsById, destinationIds } = input;
  const thread = threadsById.get(drop.key);
  if (thread === undefined || thread.archivedAtMs !== null) return true;
  const canonicalSection =
    thread.snoozedUntilMs !== null && thread.snoozedUntilMs > input.nowMs
      ? "snoozed"
      : thread.settledAtMs !== null
        ? "settled"
        : thread.pinnedAtMs !== null
          ? "pinned"
          : "active";
  if (
    canonicalSection !== drop.sourceSection &&
    canonicalSection !== drop.section
  )
    return true;
  if (drop.order === null) {
    return (
      canonicalSection === drop.section &&
      thread.pinnedAtMs === null &&
      (!drop.clearsSnooze || thread.snoozedUntilMs === null)
    );
  }
  if (canonicalSection !== drop.section) return false;
  if (drop.clearsSnooze && thread.snoozedUntilMs !== null) return false;
  const keyOf = (id: string) => {
    const candidate = threadsById.get(id);
    return (
      (drop.section === "pinned"
        ? candidate?.pinOrderKey
        : candidate?.activeOrderKey) ?? null
    );
  };
  const heldKeys = new Set(drop.order);
  const membershipChanged =
    destinationIds.length !== drop.order.length ||
    destinationIds.some((id) => !heldKeys.has(id));
  const foreignKeyLanded = destinationIds.some((id) => {
    const currentKey = keyOf(id);
    if (currentKey === (drop.keysAtDrop.get(id) ?? null)) return false;
    return currentKey !== drop.assignedKeys.get(id);
  });
  const allAssignmentsLanded = [...drop.assignedKeys].every(
    ([id, orderKey]) => keyOf(id) === orderKey,
  );
  return membershipChanged || foreignKeyLanded || allAssignmentsLanded;
}
