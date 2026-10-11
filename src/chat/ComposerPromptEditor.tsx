// Ported from T3 Code v0.0.45 apps/web/src/components/ComposerPromptEditorTiptap.tsx, ContextChip.tsx and chat/FileTagChip.tsx (MIT).
import { Extension, getSchema, Node, wrappingInputRule } from "@tiptap/core";
import { TaskList } from "@tiptap/extension-task-list";
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  type NodeViewProps,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { splitBlockKeepMarks } from "@tiptap/pm/commands";
import { liftListItem, splitListItem } from "@tiptap/pm/schema-list";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import {
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
  createContext,
  useContext,
} from "react";
import { cn } from "../lib/cn";
import {
  ComposerCodeExtension,
  composerContent,
  composerDocumentMap,
  ComposerTaskItemExtension,
  editorCursor,
  promptCursor,
  replaceComposerText,
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

type StyledRange = {
  from: number;
  to: number;
  markers: { at: number; side: number; text: string }[];
};

function collectStyledRanges(doc: ProseMirrorNode): StyledRange[] {
  const ranges: StyledRange[] = [];
  const map = composerDocumentMap(doc);
  let range: StyledRange | null = null;
  let openLength = 0;
  for (const run of map.runs) {
    if (run.openLen > 0) {
      range ??= { from: run.pmPos, to: run.pmPos, markers: [] };
      range.markers.push({
        at: run.pmPos,
        side: -1,
        text: map.text.slice(run.promptStart, run.promptStart + run.openLen),
      });
    }
    if (range === null) continue;
    range.to = run.pmPos + run.docLen;
    if (run.closeLen > 0) {
      const end = run.promptStart + run.promptLen;
      range.markers.push({
        at: range.to,
        side: -2,
        text: map.text.slice(end - run.closeLen, end),
      });
    }
    openLength += run.openLen - run.closeLen;
    if (openLength === 0) {
      ranges.push(range);
      range = null;
    }
  }
  return ranges;
}

function decorationsForSelection(
  doc: ProseMirrorNode,
  selection: { from: number; to: number; empty: boolean },
): DecorationSet {
  const decorations: Decoration[] = [];
  if (!selection.empty) {
    doc.nodesBetween(selection.from, selection.to, (node, pos) => {
      if (node.type.name.startsWith("composer-")) {
        decorations.push(
          Decoration.node(pos, pos + node.nodeSize, {
            class: "composer-chip-range-selected",
          }),
        );
        return false;
      }
      return true;
    });
  }
  for (const range of collectStyledRanges(doc)) {
    const active = selection.empty
      ? selection.from >= range.from && selection.from <= range.to
      : selection.from < range.to && selection.to > range.from;
    if (!active) continue;
    for (const { at, side, text } of range.markers)
      decorations.push(
        Decoration.widget(
          at,
          () => {
            const marker = document.createElement("span");
            marker.className = "composer-rich-marker";
            marker.textContent = text;
            marker.setAttribute("aria-hidden", "true");
            return marker;
          },
          { side, key: `marker-${at}-${side}-${text}` },
        ),
      );
  }
  return DecorationSet.create(doc, decorations);
}

const markerPluginKey = new PluginKey<DecorationSet>("composer-rich-markers");
const ComposerMarkersExtension = Extension.create({
  name: "composer-rich-markers",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: markerPluginKey,
        state: {
          init: (_, state) =>
            decorationsForSelection(state.doc, state.selection),
          apply: (tr, old) =>
            tr.docChanged || tr.selectionSet
              ? decorationsForSelection(tr.doc, tr.selection)
              : old,
        },
        props: {
          decorations: (state) => markerPluginKey.getState(state),
        },
      }),
    ];
  },
});

// T3's input rules convert typed Markdown into marks. A conversion the
// serializer would not turn back into the typed text is refused, so the
// characters stay literal and the prompt matches plain mode.
const ComposerLosslessInputRules = Extension.create({
  name: "composer-lossless-input-rules",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        filterTransaction: (tr, state) =>
          !tr.getMeta("inputRule") ||
          composerDocumentMap(tr.doc).text ===
            composerDocumentMap(state.doc).text,
        appendTransaction: (transactions, _old, state) =>
          transactions.some((tr) => tr.getMeta("inputRule"))
            ? state.tr.setStoredMarks([])
            : null,
      }),
    ];
  },
});

// The setting toggles styling, not the engine: both modes are Tiptap. Plain
// mode leaves out the marks, so typed markers stay literal characters.
export function composerExtensions(richText: boolean) {
  return [
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
      undoRedo: { newGroupDelay: 500 },
      ...(richText ? {} : { bold: false, italic: false, strike: false }),
    }),
    ComposerContext,
    ComposerMarkersExtension,
    ...(richText
      ? [
          ComposerLosslessInputRules,
          ComposerCodeExtension,
          TaskList,
          ComposerTaskItemExtension.extend({
            addInputRules() {
              return [
                wrappingInputRule({
                  find: /^- \[([ xX])\] $/,
                  type: this.type,
                  getAttributes: (match) => ({
                    checked: match[1]?.toLowerCase() === "x",
                    contentSpace: " ",
                  }),
                }),
              ];
            },
          }),
        ]
      : []),
  ];
}

function inTaskItem(view: EditorView) {
  const { $from } = view.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1)
    if ($from.node(depth).type.name === "taskItem") return true;
  return false;
}

// Enter that neither sends nor picks a suggestion: a task item splits, an
// empty one lifts out of its list, anything else splits the paragraph.
export function composerEnter(view: EditorView): boolean {
  const taskItem = view.state.schema.nodes.taskItem;
  if (
    taskItem &&
    inTaskItem(view) &&
    (splitListItem(taskItem, { checked: false })(view.state, view.dispatch) ||
      (view.state.selection.$from.parent.content.size === 0 &&
        liftListItem(taskItem)(view.state, view.dispatch)))
  )
    return true;
  return splitBlockKeepMarks(view.state, (tr) =>
    view.dispatch(tr.scrollIntoView()),
  );
}

function insertParsed(
  view: EditorView,
  text: string,
  records: readonly ComposerContextRecord[],
) {
  const content = composerContent(view.state.schema, text, records).content;
  const open = (node: ProseMirrorNode | null) =>
    node?.type.name === "paragraph" ? 1 : 0;
  view.dispatch(
    view.state.tr
      .replaceSelection(
        new Slice(content, open(content.firstChild), open(content.lastChild)),
      )
      .scrollIntoView(),
  );
}

export type ComposerSnapshot = {
  value: string;
  start: number;
  end: number;
  composing: boolean;
};
export type ComposerEditorHandle = {
  focus: () => void;
  readSnapshot: () => ComposerSnapshot;
  isCaretOnVisualEdge: (edge: "start" | "end") => boolean;
  containsFocus: () => boolean;
  readRecords: () => ComposerContextRecord[];
  replaceRange: (input: {
    start: number;
    end: number;
    expectedText: string;
    replacement: string;
    records?: ComposerContextRecord[];
  }) => boolean;
};

type ComposerPromptEditorProps = {
  ref: Ref<ComposerEditorHandle>;
  richText: boolean;
  className?: string;
  placeholderClassName?: string;
  value: string;
  skills: readonly Skill[];
  records: ComposerContextRecord[];
  onChange: (value: string, records: ComposerContextRecord[]) => void;
  onSelectionChange: (snapshot: ComposerSnapshot) => void;
  onKeyDown: (event: KeyboardEvent) => boolean;
  onPasteFiles: (event: ClipboardEvent, structured: boolean) => boolean;
  onBlur?: () => void;
  placeholder: string;
  disabled: boolean;
  approvalState: boolean;
  autoFocus?: boolean;
  suggestionListId?: string;
  activeSuggestionId?: string;
};

export function ComposerPromptEditor(props: ComposerPromptEditorProps) {
  // Extensions are creation-time: flipping the setting remounts the editor.
  // Both halves initialize from the controlled Markdown value, so the draft
  // survives the flip.
  return (
    <ComposerPromptEditorInner
      key={props.richText ? "rich" : "plain"}
      {...props}
    />
  );
}

function ComposerPromptEditorInner(props: ComposerPromptEditorProps) {
  const richText = props.richText;
  const [extensions] = useState(() => composerExtensions(richText));
  const latest = useRef(props);
  latest.current = props;
  const composing = useRef(false);
  const editorAttributes = useMemo(
    () => ({
      class: cn(
        "composer-tiptap -m-1 block max-h-52 min-h-19.5 overflow-y-auto p-1 whitespace-pre-wrap wrap-break-word bg-transparent leading-relaxed text-foreground focus:outline-none",
        props.approvalState && "min-h-10",
        props.className,
      ),
      role: "textbox",
      "aria-label": "Message",
      "aria-multiline": "true",
      "data-testid": "composer-editor",
      "data-composer-rich-text": richText ? "true" : "false",
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
      props.className,
      props.placeholder,
      props.suggestionListId,
      props.activeSuggestionId,
    ],
  );
  const editor = useEditor({
    extensions,
    content: composerContent(
      getSchema(extensions),
      props.value,
      props.records,
    ).toJSON(),
    editable: !props.disabled,
    autofocus: props.autoFocus ? "end" : false,
    editorProps: {
      attributes: editorAttributes,
      handleKeyDown: (view, event) => {
        if (event.isComposing || event.keyCode === 229 || composing.current)
          return false;
        // Enter on a focused task checkbox must not send the prompt (or
        // split anything): Space toggles it, Enter does nothing.
        if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
          event.preventDefault();
          return true;
        }
        if (latest.current.onKeyDown(event)) return true;
        if (event.key !== "Enter") return false;
        event.preventDefault();
        return composerEnter(view);
      },
      handlePaste: (view, event) => {
        const fragment = event.clipboardData
          ? readContextClipboard(event.clipboardData)
          : null;
        if (
          latest.current.onPasteFiles(event, Boolean(fragment?.records.length))
        )
          return true;
        if (!fragment) {
          const text = event.clipboardData?.getData("text/plain");
          if (!richText || !text) return false;
          insertParsed(view, text, []);
          return true;
        }
        const existing = composerDocumentMap(view.state.doc).records;
        if (
          new Set([...existing, ...fragment.records].map((r) => r.contextId))
            .size > 200
        )
          return true;
        insertParsed(view, fragment.text, fragment.records);
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
          latest.current.onBlur?.();
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
      containsFocus: () => editor?.isFocused ?? false,
      readRecords: () =>
        editor
          ? composerDocumentMap(editor.state.doc).records
          : latest.current.records,
      isCaretOnVisualEdge: (edge) => {
        const snapshot = readSnapshot();
        const root = editor?.view.dom;
        const selection = window.getSelection();
        if (
          !editor ||
          !root ||
          !selection?.isCollapsed ||
          selection.rangeCount === 0 ||
          !selection.anchorNode ||
          !root.contains(selection.anchorNode) ||
          snapshot.start !== snapshot.end
        )
          return false;
        if (!snapshot.value) return true;
        if (
          (edge === "start"
            ? snapshot.value.slice(0, snapshot.start)
            : snapshot.value.slice(snapshot.start)
          ).includes("\n")
        )
          return false;
        const caret = editor.view.coordsAtPos(
          editor.state.selection.from,
          edge === "start" ? 1 : -1,
        );
        const threshold = (caret.bottom - caret.top) / 2;
        const bounds =
          (edge === "start"
            ? root.firstElementChild
            : root.lastElementChild
          )?.getBoundingClientRect() ?? root.getBoundingClientRect();
        return edge === "start"
          ? caret.top - bounds.top < threshold
          : bounds.bottom - caret.bottom < threshold;
      },
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
        return editor
          .chain()
          .focus()
          .command(({ tr }) => {
            return replaceComposerText(tr, {
              start,
              end,
              expectedText,
              replacement,
              records,
            });
          })
          .run();
      },
    }),
    [editor],
  );
  useLayoutEffect(() => {
    if (
      !editor ||
      composing.current ||
      (composerDocumentMap(editor.state.doc).text === props.value &&
        JSON.stringify(composerDocumentMap(editor.state.doc).records) ===
          JSON.stringify(props.records))
    )
      return;
    editor.commands.setContent(
      composerContent(editor.schema, props.value, props.records).toJSON(),
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
          className={cn(
            "pointer-events-none absolute inset-0 leading-relaxed text-placeholder/75",
            props.placeholderClassName,
          )}
        >
          {props.placeholder}
        </div>
      ) : null}
    </>
  );
}
