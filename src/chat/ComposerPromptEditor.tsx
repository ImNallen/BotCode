// Ported from T3 Code v0.0.45 apps/web/src/components/ComposerPromptEditorTiptap.tsx, ContextChip.tsx and chat/FileTagChip.tsx (MIT).
import { Node } from "@tiptap/core";
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  type NodeViewProps,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Slice } from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import { FileEntryIcon } from "../panel/FileEntryIcon";
import {
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type Ref,
} from "react";
import { cn } from "../lib/cn";
import { pathBasename } from "./composer-logic";
import {
  buildComposerDocument,
  composerDocumentMap,
  editorCursor,
  promptCursor,
} from "./composerDocument";

function MentionNodeView({ node }: NodeViewProps) {
  const path = typeof node.attrs.path === "string" ? node.attrs.path : "";
  return (
    <NodeViewWrapper
      as="span"
      className="relative inline-flex select-none items-center align-middle leading-none data-[composer-chip-selected]:after:pointer-events-none data-[composer-chip-selected]:after:absolute data-[composer-chip-selected]:after:inset-0 data-[composer-chip-selected]:after:rounded-sm data-[composer-chip-selected]:after:bg-[Highlight] data-[composer-chip-selected]:after:opacity-30 data-[composer-chip-selected]:after:content-['']"
    >
      <span
        contentEditable={false}
        spellCheck={false}
        data-composer-mention-chip="true"
        title={path}
        aria-label={path}
        className="inline-flex h-[1.41em] max-w-full items-center gap-[0.33em] rounded-[0.5em] border px-[0.5em] align-middle font-medium text-[0.86em] leading-none [&_svg]:block [&_svg]:size-[1.17em] [&_svg]:shrink-0 [&_svg]:self-center [button&,a&,[data-popup-open]&]:cursor-pointer [button&,a&]:transition-colors [button&,a&]:motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:cursor-default [--context-chip-accent:oklch(0.62_0.11_215)] [--context-chip-border:color-mix(in_oklab,var(--context-chip-accent)_34%,var(--contrast-border))] [--context-chip-border-hover:color-mix(in_oklab,var(--context-chip-accent)_48%,var(--contrast-border))] [--context-chip-foreground:color-mix(in_oklab,var(--context-chip-accent)_22%,var(--contrast-foreground))] border-(--context-chip-border) bg-(--context-chip-accent)/11 text-(--context-chip-foreground) [button:enabled&,a&]:hover:border-(--context-chip-border-hover) [button:enabled&,a&]:hover:bg-(--context-chip-accent)/17"
      >
        <FileEntryIcon path={path} />
        <span
          data-slot="context-chip-label"
          className="block min-w-0 self-center truncate leading-tight"
        >
          {pathBasename(path)}
        </span>
      </span>
    </NodeViewWrapper>
  );
}

const ComposerMention = Node.create({
  name: "composer-mention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({ path: { default: "" }, source: { default: "" } }),
  parseHTML: () => [{ tag: "span[data-composer-mention]" }],
  renderHTML: ({ HTMLAttributes }) => [
    "span",
    { "data-composer-mention": "", ...HTMLAttributes },
  ],
  addNodeView: () => ReactNodeViewRenderer(MentionNodeView),
});

export const composerEditorExtensions = [
  StarterKit.configure({
    blockquote: false,
    bulletList: false,
    codeBlock: false,
    heading: false,
    horizontalRule: false,
    listItem: false,
    link: false,
    orderedList: false,
    underline: false,
    dropcursor: false,
    gapcursor: false,
    trailingNode: false,
    code: false,
    bold: false,
    italic: false,
    strike: false,
    undoRedo: { newGroupDelay: 500 },
  }),
  ComposerMention,
];

export type ComposerSnapshot = {
  value: string;
  start: number;
  end: number;
  composing: boolean;
};
export type ComposerEditorHandle = {
  focus: () => void;
  readSnapshot: () => ComposerSnapshot;
  replaceRange: (input: {
    start: number;
    end: number;
    expectedText: string;
    replacement: string;
  }) => boolean;
};

export function ComposerPromptEditor(props: {
  ref: Ref<ComposerEditorHandle>;
  value: string;
  onChange: (value: string) => void;
  onSelectionChange: (snapshot: ComposerSnapshot) => void;
  onKeyDown: (event: KeyboardEvent) => boolean;
  onPasteFiles: (event: ClipboardEvent) => boolean;
  placeholder: string;
  disabled: boolean;
  approvalState: boolean;
  autoFocus?: boolean;
  suggestionListId?: string;
  activeSuggestionId?: string;
}) {
  const latest = useRef(props);
  latest.current = props;
  const composing = useRef(false);
  const editorAttributes = useMemo(
    () => ({
      class: cn(
        "composer-tiptap -m-1 block max-h-52 min-h-19.5 overflow-y-auto p-1 whitespace-pre-wrap wrap-break-word bg-transparent leading-relaxed text-foreground focus:outline-none",
        props.approvalState && "min-h-10",
      ),
      role: "textbox",
      "aria-label": "Message",
      "aria-multiline": "true",
      "data-testid": "composer-editor",
      "data-composer-rich-text": "false",
      "aria-placeholder": props.placeholder,
      "data-placeholder": props.placeholder,
      ...(props.disabled ? { "aria-readonly": "true" } : {}),
      ...(props.suggestionListId
        ? {
            "aria-autocomplete": "list",
            "aria-haspopup": "listbox",
            "aria-controls": props.suggestionListId,
            ...(props.activeSuggestionId
              ? { "aria-activedescendant": props.activeSuggestionId }
              : {}),
          }
        : {}),
    }),
    [
      props.disabled,
      props.approvalState,
      props.placeholder,
      props.suggestionListId,
      props.activeSuggestionId,
    ],
  );
  const editor = useEditor({
    extensions: composerEditorExtensions,
    content: buildComposerDocument(props.value),
    editable: !props.disabled,
    autofocus: props.autoFocus ? "end" : false,
    editorProps: {
      attributes: editorAttributes,
      handleKeyDown: (_view, event) => {
        if (event.isComposing || event.keyCode === 229 || composing.current)
          return false;
        return latest.current.onKeyDown(event);
      },
      handlePaste: (view, event) => {
        if (latest.current.onPasteFiles(event)) return true;
        const text = event.clipboardData?.getData("text/plain");
        if (!text) return false;
        const content = view.state.schema.nodeFromJSON(
          buildComposerDocument(text),
        ).content;
        view.dispatch(
          view.state.tr
            .replaceSelection(new Slice(content, 1, 1))
            .scrollIntoView(),
        );
        return true;
      },
      clipboardTextSerializer: (slice) =>
        slice.content.textBetween(0, slice.content.size, "\n", (node) =>
          node.type.name === "hardBreak"
            ? "\n"
            : typeof node.attrs.source === "string"
              ? node.attrs.source
              : "",
        ),
      handleDOMEvents: {
        compositionstart: () => {
          composing.current = true;
          return false;
        },
        compositionend: () => {
          composing.current = false;
          queueMicrotask(() => publishSelection());
          return false;
        },
        blur: () => {
          latest.current.onSelectionChange({
            ...readSnapshot(),
            composing: true,
          });
          return false;
        },
        focus: () => {
          queueMicrotask(() => publishSelection());
          return false;
        },
      },
    },
    onUpdate: ({ editor }) => {
      latest.current.onChange(composerDocumentMap(editor.state.doc).text);
      publishSelection();
    },
    onSelectionUpdate: () => publishSelection(),
  });
  function readSnapshot(): ComposerSnapshot {
    if (!editor)
      return {
        value: latest.current.value,
        start: 0,
        end: 0,
        composing: composing.current,
      };
    return {
      value: composerDocumentMap(editor.state.doc).text,
      start: promptCursor(editor.state.doc, editor.state.selection.from),
      end: promptCursor(editor.state.doc, editor.state.selection.to),
      composing: composing.current,
    };
  }
  function publishSelection() {
    latest.current.onSelectionChange(readSnapshot());
  }

  useImperativeHandle(
    props.ref,
    () => ({
      focus: () => {
        editor?.commands.focus();
        publishSelection();
      },
      readSnapshot,
      replaceRange: ({ start, end, expectedText, replacement }) => {
        if (
          !editor ||
          composing.current ||
          composerDocumentMap(editor.state.doc).text.slice(start, end) !==
            expectedText
        )
          return false;
        const from = editorCursor(editor.state.doc, start);
        const to = editorCursor(editor.state.doc, end);
        const doc = buildComposerDocument(replacement);
        const inline = doc.content?.[0]?.content ?? [];
        return editor
          .chain()
          .focus()
          .command(({ tr }) => {
            closeHistory(tr);
            return true;
          })
          .insertContentAt({ from, to }, inline, { updateSelection: true })
          .run();
      },
    }),
    [editor],
  );
  useLayoutEffect(() => {
    if (
      !editor ||
      composing.current ||
      composerDocumentMap(editor.state.doc).text === props.value
    )
      return;
    editor.commands.setContent(buildComposerDocument(props.value), {
      emitUpdate: false,
    });
    editor.commands.setTextSelection(
      editorCursor(editor.state.doc, props.value.length),
    );
    publishSelection();
  }, [editor, props.value]);
  useLayoutEffect(() => {
    if (!editor) return;
    editor.setEditable(!props.disabled, false);
    if (editor.isInitialized)
      editor.view.setProps({ attributes: editorAttributes });
  }, [editor, editorAttributes, props.disabled]);
  return (
    <>
      <EditorContent editor={editor} />
      {!props.value && props.placeholder ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 leading-relaxed text-placeholder/75"
        >
          {props.placeholder}
        </div>
      ) : null}
    </>
  );
}
