// Classes ported from pingdotgg/t3code v0.0.45 components/ui/scroll-area.tsx (MIT).
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { cn } from "../lib/cn";

export function ScrollArea({
  children,
  className,
  scrollFade = false,
}: {
  children: ReactNode;
  className?: string;
  scrollFade?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => {
      node.style.setProperty(
        "--scroll-area-overflow-y-start",
        `${node.scrollTop}px`,
      );
      node.style.setProperty(
        "--scroll-area-overflow-y-end",
        `${Math.max(0, node.scrollHeight - node.clientHeight - node.scrollTop)}px`,
      );
      node.style.setProperty(
        "--scroll-area-overflow-x-start",
        `${node.scrollLeft}px`,
      );
      node.style.setProperty(
        "--scroll-area-overflow-x-end",
        `${Math.max(0, node.scrollWidth - node.clientWidth - node.scrollLeft)}px`,
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    node.addEventListener("scroll", update);
    update();
    return () => {
      observer.disconnect();
      node.removeEventListener("scroll", update);
    };
  }, [children]);
  return (
    <div
      className={cn(
        "relative size-full min-h-0 overflow-hidden rounded-[inherit]",
        className,
      )}
    >
      <div
        ref={ref}
        data-slot="scroll-area-viewport"
        className={cn(
          "h-full max-h-[inherit] overflow-auto overscroll-contain rounded-[inherit] outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background data-has-overflow-x:overscroll-x-contain",
          scrollFade &&
            "mask-t-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-start)))] mask-b-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-end)))] mask-l-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-start)))] mask-r-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-end)))] [--fade-size:1.5rem] scroll-p-[var(--fade-size)]",
        )}
      >
        {children}
      </div>
    </div>
  );
}
