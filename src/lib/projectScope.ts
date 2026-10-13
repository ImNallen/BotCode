import { useSyncExternalStore } from "react";
import { storage, type Storage } from "./storage";

export const PROJECT_SCOPE_KEY = "l1code:sidebar-project-scope";

export function createProjectScopeStore(persistence: Storage) {
  const listeners = new Set<() => void>();
  return {
    read: () => persistence.getItem(PROJECT_SCOPE_KEY),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (workspaceId: string | null) => {
      if (workspaceId === persistence.getItem(PROJECT_SCOPE_KEY)) return;
      void (workspaceId
        ? persistence.setItem(PROJECT_SCOPE_KEY, workspaceId)
        : persistence.removeItem(PROJECT_SCOPE_KEY));
      for (const listener of listeners) listener();
    },
  };
}

export const projectScope = createProjectScopeStore(storage);

export function useProjectScopeId(): string | null {
  return useSyncExternalStore(projectScope.subscribe, projectScope.read);
}
