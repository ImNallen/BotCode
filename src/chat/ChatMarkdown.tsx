// Ported from T3 Code v0.0.45 apps/web/src/components/ChatMarkdown.tsx and components/ContextChip.tsx (MIT).
import {
  createContext,
  memo,
  useContext,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
} from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { CheckIcon, CopyIcon, GlobeIcon, WrapTextIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { FileEntryIcon } from "../panel/FileEntryIcon";
import { Button } from "../ui/controls";
import { Menu, MenuItem } from "../ui/menu";
import type { OpenTarget, Skill } from "../ipc";
import { contextMenuPoint } from "../fileContextMenu";
import { notifyEditorResult, useEditorActions } from "../lib/editorActions";
import { openInEditorMenuLabel, revealLabel } from "../lib/editors";
import type { ChatFileLink } from "./chatFileLinks";
import { pathBasename } from "./composer-logic";
import { renderSkillInlineMarkdownChildren } from "./SkillInlineText";
import type { ComposerContextRecord } from "./composerContext";
import { ContextRecordChip } from "./ContextRecordChip";
import { RenderErrorBoundary } from "../errors/RenderErrorBoundary";

export type FileLinks = {
  resolve: (target: string, source: "code" | "href") => ChatFileLink | null;
  openInPanel: (path: string) => void;
  target: (link: ChatFileLink) => OpenTarget;
  absolutePath: (link: ChatFileLink) => string;
};

const FileLinkContext = createContext<FileLinks | null>(null);
const ContextRecords = createContext<readonly ComposerContextRecord[]>([]);

export function FileLinkProvider({
  value,
  children,
}: {
  value: FileLinks;
  children: ReactNode;
}) {
  return <FileLinkContext value={value}>{children}</FileLinkContext>;
}

function copyPath(value: string, title: string) {
  void navigator.clipboard.writeText(value).then(
    () => notifyEditorResult("success", `${title} copied`, value),
    (error: unknown) =>
      notifyEditorResult(
        "error",
        `Failed to copy ${title.toLowerCase()}`,
        error instanceof Error ? error.message : "An error occurred.",
      ),
  );
}

function FileChip({ links, link }: { links: FileLinks; link: ChatFileLink }) {
  const editors = useEditorActions();
  const [menu, setMenu] = useState<{
    point: { x: number; y: number };
    returnFocus: HTMLElement;
  }>();
  const { path } = link;
  const label = pathBasename(path);
  const position =
    link.line === undefined
      ? null
      : { line: link.line, column: link.column ?? null };
  const openInEditor = () => editors.open(links.target(link), position);
  return (
    <>
      <button
        type="button"
        title={path}
        data-slot="context-chip"
        onClick={() =>
          link.kind === "workspace" ? links.openInPanel(path) : openInEditor()
        }
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setMenu({
            point: contextMenuPoint(event),
            returnFocus: event.currentTarget,
          });
        }}
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
      {menu ? (
        <Menu
          key={`${menu.point.x}:${menu.point.y}`}
          open
          point={menu.point}
          returnFocus={menu.returnFocus}
          onOpenChange={(open) => {
            if (!open) setMenu(undefined);
          }}
          trigger={() => null}
        >
          {editors.preferred ? (
            <MenuItem onClick={openInEditor}>
              {openInEditorMenuLabel(editors.preferred)}
            </MenuItem>
          ) : null}
          {editors.available.includes("file-manager") ? (
            <MenuItem onClick={() => editors.reveal(links.target(link))}>
              {revealLabel}
            </MenuItem>
          ) : null}
          <MenuItem onClick={() => copyPath(path, "Relative path")}>
            Copy relative path
          </MenuItem>
          <MenuItem
            onClick={() => copyPath(links.absolutePath(link), "Full path")}
          >
            Copy full path
          </MenuItem>
        </Menu>
      ) : null}
    </>
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
      <div className="chat-markdown-shiki">
        <RenderErrorBoundary
          resetKeys={[code, language]}
          fallback={
            <pre>
              <code>{code}</code>
            </pre>
          }
        >
          {children}
        </RenderErrorBoundary>
      </div>
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
    const link = inline && text && links ? links.resolve(text, "code") : null;
    if (links && link) return <FileChip links={links} link={link} />;
    return <code className={className}>{children}</code>;
  },
  a({ href, children }) {
    const links = useContext(FileLinkContext);
    const records = useContext(ContextRecords);
    if (href?.startsWith("t3-context://v1/")) {
      const [kind, contextId] = href
        .slice("t3-context://v1/".length)
        .split("/");
      const record =
        records.find(
          (record) => record.contextId === contextId && record.kind === kind,
        ) ?? null;
      return (
        <ContextRecordChip
          record={record}
          label={typeof children === "string" ? children : undefined}
        />
      );
    }
    const link = href && links ? links.resolve(href, "href") : null;
    if (links && link) return <FileChip links={links} link={link} />;
    if (href && /^file:/i.test(href)) return <span>{children}</span>;
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

// File URLs can become file chips, so they survive react-markdown's sanitizing.
const keepFileUrls = (url: string) =>
  /^file:/i.test(url) ? url : defaultUrlTransform(url);

export const ChatMarkdown = memo(function ChatMarkdown({
  text,
  className,
  lineBreaks = false,
  streaming = false,
  skills,
  records = [],
}: {
  text: string;
  className?: string;
  lineBreaks?: boolean;
  streaming?: boolean;
  skills?: readonly Skill[];
  records?: readonly ComposerContextRecord[];
}) {
  return (
    <div
      className={cn(
        "chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/[calc(80%+var(--appearance-contrast-boost)/5)] [overflow-wrap:anywhere] [word-break:break-word]",
        className,
      )}
      data-streaming={streaming ? "" : undefined}
    >
      <RenderErrorBoundary
        resetKeys={[text, lineBreaks, streaming, skills, records]}
        fallback={<div className="whitespace-pre-wrap">{text}</div>}
      >
        <ContextRecords value={records}>
          <ReactMarkdown
            urlTransform={(url) =>
              url.startsWith("t3-context://v1/") ? url : keepFileUrls(url)
            }
            remarkPlugins={lineBreaks ? [remarkGfm, remarkBreaks] : [remarkGfm]}
            components={
              skills
                ? {
                    ...components,
                    p: ({ children }) => (
                      <p>
                        {renderSkillInlineMarkdownChildren(children, skills)}
                      </p>
                    ),
                    li: ({ children }) => (
                      <li>
                        {renderSkillInlineMarkdownChildren(children, skills)}
                      </li>
                    ),
                  }
                : components
            }
          >
            {text}
          </ReactMarkdown>
        </ContextRecords>
      </RenderErrorBoundary>
    </div>
  );
});
