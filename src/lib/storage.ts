import { ipc, native } from "../ipc";
import { serial } from "./serial";

export type Storage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
  setItemDurable: (key: string, value: string) => Promise<void>;
  removeItemDurable: (key: string) => Promise<void>;
};

export function persistentStorage(
  write: (key: string, value: string | null) => Promise<unknown>,
) {
  const values = new Map<string, string>();
  const committed = new Map<string, string>();
  const revisions = new Map<string, number>();
  const enqueue = serial();
  const publish = (key: string, value: string | null) => {
    if (value === null) values.delete(key);
    else values.set(key, value);
  };
  const persist = (key: string, value: string | null, durable: boolean) => {
    const revision = (revisions.get(key) ?? 0) + 1;
    revisions.set(key, revision);
    if (!durable) publish(key, value);
    return enqueue(async () => {
      try {
        await write(key, value);
        if (value === null) committed.delete(key);
        else committed.set(key, value);
        if (durable && revisions.get(key) === revision) publish(key, value);
      } catch (cause) {
        if (revisions.get(key) === revision)
          publish(key, committed.get(key) ?? null);
        throw cause;
      }
    });
  };
  return {
    load: (entries: Record<string, string>) => {
      for (const [key, value] of Object.entries(entries)) {
        committed.set(key, value);
        if (!revisions.has(key)) values.set(key, value);
      }
    },
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => persist(key, value, false),
    removeItem: (key: string) => persist(key, null, false),
    setItemDurable: (key: string, value: string) => persist(key, value, true),
    removeItemDurable: (key: string) => persist(key, null, true),
  };
}
const persisted = persistentStorage(ipc.setUiState);
export async function loadStorage(): Promise<void> {
  if (native) persisted.load(await ipc.uiState());
}
export const storage: Storage = native
  ? persisted
  : {
      getItem: (key) => localStorage.getItem(key),
      setItem: async (key, value) => localStorage.setItem(key, value),
      removeItem: async (key) => localStorage.removeItem(key),
      setItemDurable: async (key, value) => localStorage.setItem(key, value),
      removeItemDurable: async (key) => localStorage.removeItem(key),
    };
