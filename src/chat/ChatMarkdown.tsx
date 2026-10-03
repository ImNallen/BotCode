// Root, code block and file chip classes copied from pingdotgg/t3code v0.0.45
// components/ChatMarkdown.tsx and components/ContextChip.tsx (MIT).
import {
  createContext,
  memo,
  useContext,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { CheckIcon, CopyIcon, GlobeIcon, WrapTextIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { FileEntryIcon } from "../panel/FileEntryIcon";
import { Button } from "../ui/controls";

export type FileLinks = {
  resolve: (target: string) => string | null;
  open: (path: string) => void;
};

const FileLinkContext = createContext<FileLinks | null>(null);

export function FileLinkProvider({
  value,
  children,
}: {
  value: FileLinks;
  children: ReactNode;
}) {
  return <FileLinkContext value={value}>{children}</FileLinkContext>;
}

function FileChip({ path }: { path: string }) {
  const links = useContext(FileLinkContext);
  const label = path.split("/").at(-1) ?? path;
  return (
    <button
      type="button"
      title={path}
      data-slot="context-chip"
      onClick={() => links?.open(path)}
      className="inline-flex h-[1.41em] max-w-full items-center gap-[0.33em] rounded-[0.5em] border px-[0.5em] align-middle font-medium text-[0.86em] leading-none [&_svg]:block [&_svg]:size-[1.17em] [&_svg]:shrink-0 [&_svg]:self-center [button&,a&,[data-popup-open]&]:cursor-pointer [button&,a&]:transition-colors [button&,a&]:motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:cursor-default [--context-chip-accent:oklch(0.62_0.11_215)] [--context-chip-border:color-mix(in_oklab,var(--context-chip-accent)_34%,var(--contrast-border))] [--context-chip-border-hover:color-mix(in_oklab,var(--context-chip-accent)_48%,var(--contrast-border))] [--context-chip-foreground:color-mix(in_oklab,var(--context-chip-accent)_22%,var(--contrast-foreground))] border-(--context-chip-border) bg-(--context-chip-accent)/11 text-(--context-chip-foreground) [button:enabled&,a&]:hover:border-(--context-chip-border-hover) [button:enabled&,a&]:hover:bg-(--context-chip-accent)/17 chat-markdown-file-link select-text"
    >
      <FileEntryIcon path={path} />
      <span
        data-slot="context-chip-label"
        className="block min-w-0 self-center truncate leading-tight"
      >
        {label}
      </span>
    </button>
  );
}

function CodeBlock({
  language,
  code,
  children,
}: {
  language: string | null;
  code: string;
  children: ReactNode;
}) {
  const [wrapped, setWrapped] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrapLabel = wrapped ? "Disable line wrap" : "Wrap lines";
  const copyLabel = copied ? "Copied" : "Copy code";
  return (
    <div
      className="chat-markdown-codeblock my-[0.65rem] overflow-hidden rounded-lg border border-border/70 bg-secondary leading-snug dark:border-transparent dark:bg-input/32"
      data-language={language ?? undefined}
      data-wrap={wrapped ? "true" : "false"}
    >
      <div className="chat-markdown-codeblock-header flex items-center justify-between gap-2 pt-1.5 pr-1.5 pb-0 pl-3 select-none">
        <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-2xs">
          {language ? <span className="truncate">{language}</span> : null}
        </span>
        <span
          className="flex items-center gap-0.5"
          role="toolbar"
          aria-label="Code block actions"
        >
          <Button
            variant={wrapped ? "secondary" : "ghost-muted"}
            size="icon-xs"
            aria-pressed={wrapped}
            aria-label={wrapLabel}
            title={wrapLabel}
            onClick={() => setWrapped((value) => !value)}
          >
            <WrapTextIcon className="size-3" />
          </Button>
          <Button
            variant="ghost-muted"
            size="icon-xs"
            aria-label={copyLabel}
            title={copyLabel}
            onClick={() => {
              void navigator.clipboard.writeText(code).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              });
            }}
          >
            {copied ? (
              <CheckIcon className="size-3" />
            ) : (
              <CopyIcon className="size-3" />
            )}
          </Button>
        </span>
      </div>
      <div className="chat-markdown-shiki">{children}</div>
    </div>
  );
}

const components: Components = {
  pre({ children, node }) {
    const code = node?.children[0];
    const className =
      code &&
      code.type === "element" &&
      Array.isArray(code.properties.className)
        ? String(code.properties.className[0] ?? "")
        : "";
    const language = className.startsWith("language-")
      ? className.slice(9)
      : null;
    const text =
      code && code.type === "element"
        ? code.children
            .map((child) => (child.type === "text" ? child.value : ""))
            .join("")
        : "";
    return (
      <CodeBlock language={language} code={text.replace(/\n$/, "")}>
        <pre>{children}</pre>
      </CodeBlock>
    );
  },
  code({ children, className, node }) {
    const links = useContext(FileLinkContext);
    const inline =
      node?.position?.start.line === node?.position?.end.line && !className;
    const text = typeof children === "string" ? children : null;
    const path = inline && text ? links?.resolve(text) : null;
    if (path) return <FileChip path={path} />;
    return <code className={className}>{children}</code>;
  },
  a({ href, children }) {
    const links = useContext(FileLinkContext);
    const path = href ? links?.resolve(decodeURI(href)) : null;
    if (path) return <FileChip path={path} />;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" title={href}>
        <span className="whitespace-nowrap">
          <span
            aria-hidden
            className="ms-[0.25em] me-[0.2em] inline-flex size-[14px] [vertical-align:-0.125em]"
          >
            <GlobeIcon className="block size-full shrink-0 select-none" />
          </span>
        </span>
        {children}
      </a>
    );
  },
};

export const ChatMarkdown = memo(function ChatMarkdown({
  text,
  className,
  lineBreaks = false,
  streaming = false,
}: {
  text: string;
  className?: string;
  lineBreaks?: boolean;
  streaming?: boolean;
}) {
  return (
    <div
      className={cn(
        "chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/[calc(80%+var(--appearance-contrast-boost)/5)] [overflow-wrap:anywhere] [word-break:break-word]",
        className,
      )}
      data-streaming={streaming ? "" : undefined}
    >
      <ReactMarkdown
        remarkPlugins={lineBreaks ? [remarkGfm, remarkBreaks] : [remarkGfm]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
