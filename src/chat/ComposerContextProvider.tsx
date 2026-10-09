// Ported from T3 Code v0.0.45 apps/web/src/components/ChatView.tsx composer context insertion (MIT).
import { createContext, useContext } from "react";
import type { ComposerContextRecord } from "./composerContext";

export type ComposerContextChannel = {
  /** Records the composer text still references. */
  readonly records: readonly ComposerContextRecord[];
  /** Appends a chip and focuses the composer. */
  readonly add: (record: ComposerContextRecord) => boolean;
  /** Inserts when new, replaces otherwise. Never moves focus. */
  readonly upsert: (record: ComposerContextRecord) => boolean;
  /** Replaces a record the composer holds. Never inserts or moves focus. */
  readonly replace: (record: ComposerContextRecord) => void;
  readonly remove: (contextId: string) => void;
};

/** Null while the composer cannot accept context: reverting, sending, or appending a pull request handoff. */
export const ComposerContextProvider =
  createContext<ComposerContextChannel | null>(null);
export const useComposerContext = () => useContext(ComposerContextProvider);
