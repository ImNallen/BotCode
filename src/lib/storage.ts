import { ipc, native } from "../ipc";

const values = new Map<string, string>();
let writes: Promise<unknown> = Promise.resolve();

function persist(key: string, value: string | null): Promise<void> {
  if (value === null) values.delete(key);
  else values.set(key, value);
  const write = writes.then(async () => {
    await ipc.setUiState(key, value);
  });
  writes = write.catch(() => {});
  return write;
}

export async function loadStorage(): Promise<void> {
  if (!native) return;
  for (const [key, value] of Object.entries(await ipc.uiState()))
    values.set(key, value);
}

export const storage: {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
} = native
  ? {
      getItem: (key) => values.get(key) ?? null,
      setItem: persist,
      removeItem: (key) => persist(key, null),
    }
  : {
      getItem: (key) => localStorage.getItem(key),
      setItem: async (key, value) => localStorage.setItem(key, value),
      removeItem: async (key) => localStorage.removeItem(key),
    };
