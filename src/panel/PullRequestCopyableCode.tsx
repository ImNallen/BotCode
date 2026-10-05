// Copied from pingdotgg/t3code 3e6b450 apps/web/src/components/pullRequest/PullRequestCopyableCode.tsx (MIT).
import { useEffect, useState } from "react";
import { cn } from "../lib/cn";

export function PullRequestCopyableCode({
  value,
  copyLabel,
  copiedLabel,
  className,
}: {
  value: string;
  copyLabel: string;
  copiedLabel: string;
  className?: string;
}) {
  const [isCopied, setIsCopied] = useState(false);
  useEffect(() => {
    if (!isCopied) return;
    const timeout = setTimeout(() => setIsCopied(false), 1600);
    return () => clearTimeout(timeout);
  }, [isCopied]);
  return (
    <button
      type="button"
      className={cn(
        "relative grid w-fit min-w-0 max-w-full shrink cursor-pointer rounded px-1 py-0.5 text-left outline-none transition-colors pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:bg-accent/45 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        className,
      )}
      aria-label={isCopied ? copiedLabel : copyLabel}
      title={`${isCopied ? "Copied" : copyLabel}: ${value}`}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => setIsCopied(true));
      }}
    >
      <code
        className={cn(
          "col-start-1 row-start-1 min-w-0 truncate transition-opacity duration-150 motion-reduce:transition-none",
          isCopied ? "opacity-0" : "opacity-100",
        )}
      >
        {value}
      </code>
      <span
        aria-hidden="true"
        className={cn(
          "col-start-1 row-start-1 truncate text-center transition-opacity duration-150 motion-reduce:transition-none",
          isCopied ? "opacity-100" : "opacity-0",
        )}
      >
        Copied
      </span>
    </button>
  );
}
