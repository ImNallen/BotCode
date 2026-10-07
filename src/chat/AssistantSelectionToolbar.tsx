// Ported from T3 Code v0.0.45 apps/web/src/components/chat/AssistantSelectionToolbar.tsx (MIT).
import { QuoteIcon } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  observeSelectionActions,
  resolveSelectionActionPosition,
  type SelectionActionPoint,
} from "../lib/selectionActions";
import { Button } from "../ui/controls";
import { captureAssistantTextSelection } from "./assistantTextSelection";
import type { ComposerContextRecord } from "./composerContext";
import { useComposerContext } from "./ComposerContextProvider";

type Citation = Extract<ComposerContextRecord, { kind: "citation" }>;

export function AssistantSelectionToolbar({
  viewportRef,
  environmentId,
  threadId,
}: {
  viewportRef: RefObject<HTMLElement | null>;
  environmentId: string;
  threadId: string;
}) {
  const addContext = useComposerContext();
  const enabled = addContext !== null;
  const [selection, setSelection] = useState<{
    citation: Citation;
    position: SelectionActionPoint;
  } | null>(null);
  const toolbarRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<ReturnType<typeof observeSelectionActions> | null>(
    null,
  );

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || !selection) return;
    const rect = toolbar.getBoundingClientRect();
    toolbar.style.left = `${Math.max(8, Math.min(selection.position.x, window.innerWidth - rect.width - 8))}px`;
    toolbar.style.top = `${Math.max(8, Math.min(selection.position.y, window.innerHeight - rect.height - 8))}px`;
  }, [selection]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !enabled) return;
    const clear = () => setSelection(null);
    const update = (pointer: SelectionActionPoint | null) => {
      const captured = captureAssistantTextSelection(
        viewport,
        window.getSelection(),
      );
      const messageId = captured?.source.dataset.assistantCitationSource;
      if (!captured || !messageId) {
        clear();
        return;
      }
      const rect = captured.range.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      if (
        rect.bottom < viewportRect.top ||
        rect.top > viewportRect.bottom ||
        rect.width === 0
      ) {
        clear();
        return;
      }
      const rects = captured.range.getClientRects();
      setSelection({
        citation: {
          version: 1,
          kind: "citation",
          contextId: crypto.randomUUID(),
          label: "Assistant quote",
          environmentId,
          threadId,
          messageId,
          ...captured.selector,
        },
        position: resolveSelectionActionPosition({
          bounds: viewportRect,
          selectionRect: rects.item(rects.length - 1) ?? rect,
          pointer,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        }),
      });
    };
    const actions = observeSelectionActions({
      element: viewport,
      getActionElement: () => toolbarRef.current,
      onSelection: update,
      onDismiss: clear,
    });
    actionsRef.current = actions;
    const focusActions = (event: KeyboardEvent) => {
      const toolbar = toolbarRef.current;
      if (
        event.key !== "Tab" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        event.defaultPrevented ||
        !toolbar ||
        (event.target instanceof Node && toolbar.contains(event.target)) ||
        toolbar.disabled
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      toolbar.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", focusActions, true);
    document.addEventListener("selectionchange", actions.selectionChanged);
    return () => {
      document.removeEventListener("keydown", focusActions, true);
      document.removeEventListener("selectionchange", actions.selectionChanged);
      actions.dispose();
      actionsRef.current = null;
      clear();
    };
  }, [enabled, environmentId, threadId, viewportRef]);

  if (!selection || !addContext) return null;
  const tooLong = selection.citation.text.length > 8000;
  const dismiss = () => {
    actionsRef.current?.cancel();
    setSelection(null);
  };
  return createPortal(
    <Button
      ref={toolbarRef}
      type="button"
      size="xs"
      variant="glass"
      disabled={tooLong}
      aria-label={
        tooLong ? "Selection is too long to cite" : "Cite selection in composer"
      }
      title="Cite in composer"
      className="fixed z-50 max-w-[calc(100vw-1rem)]"
      style={{ left: selection.position.x, top: selection.position.y }}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => {
        if (tooLong || !addContext(selection.citation)) return;
        window.getSelection()?.removeAllRanges();
        dismiss();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          dismiss();
        }
      }}
    >
      <QuoteIcon aria-hidden="true" className="size-3.5" />
      {tooLong ? "Shorten selection" : "Cite"}
    </Button>,
    document.body,
  );
}
