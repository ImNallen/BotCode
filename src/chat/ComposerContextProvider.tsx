// Ported from T3 Code v0.0.45 apps/web/src/components/ChatView.tsx composer context insertion (MIT).
import { createContext, useContext } from "react";
import type { ComposerContextRecord } from "./composerContext";

export const ComposerContextProvider = createContext<
  ((record: ComposerContextRecord) => boolean) | null
>(null);
export const useComposerContext = () => useContext(ComposerContextProvider);
