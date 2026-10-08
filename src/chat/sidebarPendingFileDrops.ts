// Ported from T3 Code v0.0.45 apps/web/src/sidebarPendingFileDropStore.ts (MIT).
export function createSidebarPendingFileDrops() {
  let drops: { id: string; threadId: string; files: File[] }[] = [];
  let version = 0;
  const listeners = new Set<() => void>();
  const publish = () => {
    version += 1;
    for (const listener of listeners) listener();
  };
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => version,
    queue: (threadId: string, files: File[]) => {
      const id = crypto.randomUUID();
      drops.push({ id, threadId, files });
      publish();
      return id;
    },
    remove: (id: string) => {
      const next = drops.filter((drop) => drop.id !== id);
      if (next.length === drops.length) return;
      drops = next;
      publish();
    },
    consume: (threadId: string) => {
      const matching = drops.filter((drop) => drop.threadId === threadId);
      if (!matching.length) return [];
      drops = drops.filter((drop) => drop.threadId !== threadId);
      publish();
      return matching.flatMap((drop) => drop.files);
    },
  };
}
export const sidebarPendingFileDrops = createSidebarPendingFileDrops();
