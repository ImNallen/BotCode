// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/chat/ExpandedImageDialog.tsx (MIT), without media actions or Snap Shot details.
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { Button } from "../ui/controls";
import { Dialog, DialogTitle } from "../ui/dialog";
import {
  wrapExpandedImageIndex,
  type ExpandedImagePreview,
} from "./ExpandedImagePreview";
import { MediaVideoPlayer } from "./MediaVideoPlayer";
import { ZoomableImage, type ZoomableImageHandle } from "./ZoomableImage";

const EXPANDED_MEDIA_STATE_CLASS_NAME =
  "flex aspect-auto h-48 min-h-0 w-[min(var(--media-width),32rem)] flex-col items-center justify-center gap-3 rounded-lg border border-border/70 bg-black p-6 text-center text-sm text-white shadow-2xl";

export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview,
  onClose,
}: {
  preview: ExpandedImagePreview;
  onClose: () => void;
}) {
  const [imageOffset, setImageOffset] = useState(0);
  const [failedImageSrc, setFailedImageSrc] = useState<string | null>(null);
  const zoomableImageRef = useRef<ZoomableImageHandle>(null);
  // Captured during render, before the modal dialog takes focus.
  const [returnFocusTarget] = useState(() =>
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const index = wrapExpandedImageIndex(
    preview.index + imageOffset,
    preview.images.length,
  );
  const item = preview.images[index];

  const navigateImage = useCallback((direction: -1 | 1) => {
    setImageOffset((current) => current + direction);
  }, []);

  useEffect(() => {
    closeButtonRef.current?.focus();
    return () => {
      if (returnFocusTarget?.isConnected)
        returnFocusTarget.focus({ preventScroll: true });
    };
  }, [returnFocusTarget]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.target instanceof HTMLVideoElement)
      return;
    if (zoomableImageRef.current?.pan(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (preview.images.length <= 1) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      navigateImage(-1);
      return;
    }
    if (event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    navigateImage(1);
  };

  useEffect(() => {
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onEscape, { capture: true });
    return () =>
      window.removeEventListener("keydown", onEscape, { capture: true });
  }, [onClose]);

  if (!item) return null;
  const mediaLabel = item.type === "video" ? "video" : "image";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      variant="media"
      bottomStickOnMobile={false}
      className="row-start-1 max-h-[92vh] w-[92vw] max-w-[92vw] items-center overflow-visible [--media-width:92vw] [--media-height:min(86vh,calc(100vh-160px))] sm:[--media-width:calc(92vw-96px)]"
      popupProps={{
        onKeyDown,
        onClick: (event) => {
          if (event.target === event.currentTarget) onClose();
        },
      }}
    >
      <DialogTitle className="sr-only">
        Expanded {mediaLabel} preview
      </DialogTitle>
      {preview.images.length > 1 && (
        <Button
          type="button"
          size="icon"
          variant="media-navigation"
          className="left-0 top-auto -bottom-12 translate-y-0 sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2"
          aria-label="Previous media"
          onClick={() => navigateImage(-1)}
        >
          <ChevronLeftIcon className="size-5" />
        </Button>
      )}
      <div className="relative isolate z-10 max-h-[92vh] max-w-[var(--media-width)]">
        <Button
          type="button"
          ref={closeButtonRef}
          size="icon-xs"
          variant="media-close"
          className="absolute right-0 -top-10 z-20"
          onClick={onClose}
          aria-label={`Close ${mediaLabel} preview`}
        >
          <XIcon />
        </Button>
        {item.type === "video" ? (
          <MediaVideoPlayer
            key={index}
            src={item.src}
            label={item.name}
            preload="metadata"
            autoPlay
            className="block max-h-[var(--media-height)] max-w-[var(--media-width)] text-center"
            videoClassName="aspect-auto max-h-[var(--media-height)] w-auto max-w-[var(--media-width)] rounded-lg border border-border/70 shadow-2xl"
            stateClassName={EXPANDED_MEDIA_STATE_CLASS_NAME}
          />
        ) : failedImageSrc === item.src ? (
          <div role="alert" className={EXPANDED_MEDIA_STATE_CLASS_NAME}>
            <p>Image unavailable. The file may have been moved or deleted.</p>
          </div>
        ) : (
          <ZoomableImage
            ref={zoomableImageRef}
            key={`${index}:${item.src}`}
            src={item.src}
            name={item.name}
            onError={() => setFailedImageSrc(item.src)}
          />
        )}
        <div className="mt-2 flex max-w-[var(--media-width)] items-center justify-center gap-1.5 text-xs text-white/80">
          <span className="truncate" aria-live="polite" aria-atomic="true">
            {item.name}
            {preview.images.length > 1
              ? ` (${index + 1}/${preview.images.length})`
              : ""}
          </span>
        </div>
      </div>
      {preview.images.length > 1 && (
        <Button
          type="button"
          size="icon"
          variant="media-navigation"
          className="right-0 top-auto -bottom-12 translate-y-0 sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2"
          aria-label="Next media"
          onClick={() => navigateImage(1)}
        >
          <ChevronRightIcon className="size-5" />
        </Button>
      )}
    </Dialog>
  );
});
