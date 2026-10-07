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
import type { EditorView } from "@tiptap/pm/view";
import {
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type Ref,
  createContext,
  useContext,
} from "react";
import { cn } from "../lib/cn";
import {
  buildComposerDocument,
  composerDocumentMap,
  editorCursor,
  promptCursor,
} from "./composerDocument";
import type { Skill } from "../ipc";
import { ContextRecordChip } from "./ContextRecordChip";
import {
  composerContextRecord,
  type ComposerContextRecord,
} from "./composerContext";
import {
  readContextClipboard,
  writeContextClipboard,
} from "./composerContextClipboard";

const SkillCatalog = createContext<readonly Skill[]>([]);

function copySelection(view: EditorView, event: ClipboardEvent, cut: boolean) {
  if (!event.clipboardData || view.state.selection.empty) return false;
  const slice = view.state.selection.content();
  const records: ComposerContextRecord[] = [];
  slice.content.descendants((node) => {
    if (node.type.name !== "composer-context") return;
    const parsed = composerContextRecord.safeParse(node.attrs.record);
    if (parsed.success) records.push(parsed.data);
  });
  const text = slice.content.textBetween(0, slice.content.size, "\n", (node) =>
    node.type.name === "hardBreak" ? "\n" : (node.attrs.source ?? ""),
  );
  writeContextClipboard(event.clipboardData, { text, records });
  event.preventDefault();
  if (cut) view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
  return true;
}

function ContextNodeView({ node }: NodeViewProps) {
  const skills = useContext(SkillCatalog);
  const parsed = composerContextRecord.safeParse(node.attrs.record);
  return (
    <NodeViewWrapper
      as="span"
      className="relative inline-flex select-none items-center align-middle leading-none"
      contentEditable={false}
      spellCheck={false}
    >
      <ContextRecordChip
        record={parsed.success ? parsed.data : null}
        label={node.attrs.label}
        skills={skills}
      />
    </NodeViewWrapper>
  );
}

const ComposerContext = Node.create({
  name: "composer-context",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    record: { default: null },
    source: { default: "" },
    label: { default: "" },
  }),
  parseHTML: () => [{ tag: "span[data-composer-context]" }],
  renderHTML: ({ node }) => [
    "span",
    { "data-composer-context": "", "data-source": node.attrs.source },
    node.attrs.label || node.attrs.record?.label || "Context",
  ],
  addNodeView: () => ReactNodeViewRenderer(ContextNodeView),
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
  ComposerContext,
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
    records?: ComposerContextRecord[];
  }) => boolean;
};

export function ComposerPromptEditor(props: {
  ref: Ref<ComposerEditorHandle>;
  value: string;
  skills: readonly Skill[];
  records: ComposerContextRecord[];
  onChange: (value: string, records: ComposerContextRecord[]) => void;
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
    content: buildComposerDocument(props.value, props.records),
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
        const fragment = event.clipboardData
          ? readContextClipboard(event.clipboardData)
          : null;
        if (!fragment) return false;
        const existing = composerDocumentMap(view.state.doc).records;
        if (
          new Set([...existing, ...fragment.records].map((r) => r.contextId))
            .size > 200
        )
          return true;
        const content = view.state.schema.nodeFromJSON(
          buildComposerDocument(fragment.text, fragment.records),
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
        copy: (view, event) => copySelection(view, event, false),
        cut: (view, event) => copySelection(view, event, true),
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
      const content = composerDocumentMap(editor.state.doc);
      latest.current.onChange(content.text, content.records);
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
      replaceRange: ({
        start,
        end,
        expectedText,
        replacement,
        records = [],
      }) => {
        if (
          !editor ||
          composing.current ||
          composerDocumentMap(editor.state.doc).text.slice(start, end) !==
            expectedText
        )
          return false;
        const from = editorCursor(editor.state.doc, start);
        const to = editorCursor(editor.state.doc, end);
        const doc = buildComposerDocument(replacement, records);
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
    editor.commands.setContent(
      buildComposerDocument(props.value, props.records),
      {
        emitUpdate: false,
      },
    );
    editor.commands.setTextSelection(
      editorCursor(editor.state.doc, props.value.length),
    );
    publishSelection();
  }, [editor, props.value, props.records]);
  useLayoutEffect(() => {
    if (!editor) return;
    editor.setEditable(!props.disabled, false);
    if (editor.isInitialized)
      editor.view.setProps({ attributes: editorAttributes });
  }, [editor, editorAttributes, props.disabled]);
  return (
    <>
      <SkillCatalog value={props.skills}>
        <EditorContent editor={editor} />
      </SkillCatalog>
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
