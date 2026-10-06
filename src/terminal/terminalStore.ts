import { useSyncExternalStore } from "react";
import { storage } from "../lib/storage";
import {
  parseTerminalStates,
  selectTerminalState,
  updateTerminalStates,
  type TerminalStates,
  type ThreadTerminalUiState,
} from "./terminalState";

const STORAGE_KEY = "z1:terminal-state";

let states: TerminalStates | undefined;
const listeners = new Set<() => void>();

function current(): TerminalStates {
  states ??= parseTerminalStates(storage.getItem(STORAGE_KEY));
  return states;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readTerminalState(scopeKey: string): ThreadTerminalUiState {
  return selectTerminalState(current(), scopeKey);
}

export function useTerminalState(scopeKey: string): ThreadTerminalUiState {
  return useSyncExternalStore(subscribe, () => readTerminalState(scopeKey));
}

export function updateTerminalState(
  scopeKey: string,
  update: (state: ThreadTerminalUiState) => ThreadTerminalUiState,
): void {
  const previous = current();
  const next = updateTerminalStates(previous, scopeKey, update);
  if (next === previous) return;
  states = next;
  for (const listener of listeners) listener();
  void (Object.keys(next).length === 0
    ? storage.removeItem(STORAGE_KEY)
    : storage.setItem(STORAGE_KEY, JSON.stringify(next)));
}
