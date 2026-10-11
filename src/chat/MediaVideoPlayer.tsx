// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/media/MediaVideoPlayer.tsx (MIT), for stable local attachment URLs.
import { PlayIcon, RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "../lib/cn";
import { prepareVideoFirstFrame } from "../lib/videoFirstFrame";
import { Button } from "../ui/controls";

interface MediaVideoPlayerProps {
  readonly src: string;
  readonly label: string;
  readonly preload?: "visible" | "metadata" | undefined;
  readonly autoPlay?: boolean | undefined;
  /** Presents a still thumbnail whose full surface opens the video in a viewer. */
  readonly onOpen?: (() => void) | undefined;
  readonly className?: string | undefined;
  readonly videoClassName?: string | undefined;
  /** Styles the failure panels, which otherwise assume an inline light surface. */
  readonly stateClassName?: string | undefined;
}

export function MediaVideoPlayer({
  src,
  label,
  preload = "visible",
  autoPlay = false,
  onOpen,
  className,
  videoClassName,
  stateClassName,
}: MediaVideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [preloadedSrc, setPreloadedSrc] = useState<string | null>(null);
  const failed = failedSrc === src;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || preload === "metadata" || preloadedSrc === src) return;
    if (typeof IntersectionObserver === "undefined") {
      setPreloadedSrc(src);
      return;
    }
    let active = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!active || !entries.some((entry) => entry.isIntersecting)) return;
        setPreloadedSrc(src);
        observer.disconnect();
      },
      { rootMargin: "200px" },
    );
    observer.observe(video);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [src, preload, preloadedSrc, failed, loadAttempt]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const pauseWhenHidden = () => {
      // Native fullscreen can hide the inline page while this video is still visible.
      const fullscreen =
        document.fullscreenElement?.contains(video) ||
        ("webkitDisplayingFullscreen" in video &&
          video.webkitDisplayingFullscreen === true);
      if (document.hidden && !fullscreen) video.pause();
    };
    document.addEventListener("visibilitychange", pauseWhenHidden);
    document.addEventListener("fullscreenchange", pauseWhenHidden);
    video.addEventListener("webkitendfullscreen", pauseWhenHidden);
    return () => {
      document.removeEventListener("visibilitychange", pauseWhenHidden);
      document.removeEventListener("fullscreenchange", pauseWhenHidden);
      video.removeEventListener("webkitendfullscreen", pauseWhenHidden);
      video.pause();
    };
  }, [src, failed, loadAttempt]);

  return (
    <span className={cn("relative inline-block align-middle", className)}>
      {failed && !onOpen ? (
        <span
          role="alert"
          className={cn(
            "flex aspect-video max-h-full min-h-28 w-full flex-col items-center justify-center gap-3 rounded-lg border border-border/40 bg-muted/40 p-4 text-center text-sm text-muted-foreground",
            stateClassName,
          )}
        >
          <span className="inline-flex items-center gap-1.5">
            <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
            Video unavailable{label ? ` · ${label}` : ""}
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setFailedSrc(null);
              setLoadAttempt((current) => current + 1);
            }}
          >
            <RotateCwIcon />
            Retry video
          </Button>
        </span>
      ) : !failed ? (
        <video
          key={loadAttempt}
          ref={videoRef}
          src={src}
          aria-label={label || "Video preview"}
          aria-hidden={onOpen ? true : undefined}
          autoPlay={onOpen ? false : autoPlay}
          controls={!onOpen}
          muted={onOpen ? true : undefined}
          playsInline
          preload={
            preload === "metadata" || preloadedSrc === src ? "metadata" : "none"
          }
          className={cn(
            "aspect-video max-h-full w-full bg-black object-contain",
            onOpen && "pointer-events-none",
            videoClassName,
          )}
          onLoadedMetadata={(event) =>
            prepareVideoFirstFrame(event.currentTarget)
          }
          onError={() => setFailedSrc(src)}
        />
      ) : (
        <span
          role="status"
          aria-label="Video preview unavailable"
          className={cn(
            "block aspect-video w-full rounded-lg bg-muted/60",
            stateClassName,
          )}
        />
      )}
      {onOpen ? (
        <button
          type="button"
          aria-label={label ? `Play ${label}` : "Play video"}
          onClick={onOpen}
          className="absolute inset-0 flex cursor-pointer items-center justify-center rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <span className="flex size-8 items-center justify-center rounded-full bg-black/50 text-white">
            <PlayIcon aria-hidden className="size-4 fill-current" />
          </span>
        </button>
      ) : null}
    </span>
  );
}
