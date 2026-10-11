import assert from "node:assert/strict";
import { it } from "node:test";
import { Editor, getSchema, type JSONContent } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { composerEnter, composerExtensions } from "./ComposerPromptEditor";
import {
  composerContent,
  composerDocumentMap,
  editorCursor,
  promptCursor,
} from "./composerDocument";

// Types through the editor's own plugins the way ProseMirror handles a
// keystroke: input rules first, then the plain insertion. "\n" is Enter.
function typed(richText: boolean, keys: string) {
  const editor = new Editor({
    element: null,
    extensions: composerExtensions(richText),
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
  const view = editor.view;
  view.updateState(
    EditorState.create({
      doc: editor.state.doc,
      plugins: editor.extensionManager.plugins,
    }),
  );
  for (const key of keys) {
    if (key === "\n") {
      composerEnter(view as unknown as EditorView);
      continue;
    }
    const { from, to } = view.state.selection;
    const insert = () => view.state.tr.insertText(key, from, to);
    const handled = view.state.plugins.some((plugin) =>
      plugin.props.handleTextInput?.call(
        plugin,
        view as unknown as EditorView,
        from,
        to,
        key,
        insert,
      ),
    );
    if (!handled) view.dispatch(insert());
  }
  return {
    text: composerDocumentMap(view.state.doc).text,
    doc: editor.getJSON() as JSONContent,
  };
}

it("sends the same prompt for the same keystrokes with rich text on or off", () => {
  for (const keys of [
    "Fix **auth** in `api.ts`, see *notes* and ~~old~~ paths",
    "***both*** and **`code`** then more",
    "first line\nsecond **bold** line",
    "a * b * c and 2*3*4",
    "__under__ and _single_ stay literal",
    "**bold **x and ** lead** y",
    "snake_case_name \\*escaped\\*",
    "- [X] done item",
  ]) {
    const plain = typed(false, keys).text;
    const rich = typed(true, keys).text;
    assert.equal(plain, keys, `plain: ${keys}`);
    assert.equal(rich, keys, `rich: ${keys}`);
  }
});

it("renders typed **bold** as a bold mark in rich mode and as literal text in plain mode", () => {
  assert.deepEqual(typed(true, "say **bold** now").doc, {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "say " },
          { type: "text", text: "bold", marks: [{ type: "bold" }] },
          { type: "text", text: " now" },
        ],
      },
    ],
  });
  assert.deepEqual(typed(false, "say **bold** now").doc, {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "say **bold** now" }],
      },
    ],
  });
  const code = typed(true, "run `pnpm test` here").doc.content?.[0]?.content;
  assert.deepEqual(code?.[1], {
    type: "text",
    text: "pnpm test",
    marks: [{ type: "code" }],
  });
});

it("turns a typed task marker into a checkbox item that serializes back to the marker", () => {
  const { text, doc } = typed(true, "- [ ] add tests");
  assert.equal(text, "- [ ] add tests");
  assert.equal(doc.content?.[0]?.type, "taskList");
  assert.equal(doc.content?.[0]?.content?.[0]?.attrs?.checked, false);
});

it("restores stored prompts styled when lossless and literal otherwise, with cursors that round-trip", () => {
  const schema = getSchema(composerExtensions(true));
  const styled = composerContent(
    schema,
    "use **bold**, `code`\n- [ ] task\n  - [x] nested",
  );
  assert.equal(
    composerDocumentMap(styled).text,
    "use **bold**, `code`\n- [ ] task\n  - [x] nested",
  );
  assert.equal(styled.firstChild?.child(1).marks[0]?.type.name, "bold");
  assert.equal(styled.child(1).type.name, "taskList");
  const lossy = composerContent(schema, "__not__ restyled");
  assert.equal(composerDocumentMap(lossy).text, "__not__ restyled");
  assert.equal(lossy.firstChild?.firstChild?.marks.length, 0);
  const value = "a **bold** b";
  const doc = composerContent(schema, value);
  for (const offset of [0, 1, 4, 5, 6, 7, 10, 11, 12])
    assert.equal(promptCursor(doc, editorCursor(doc, offset)), offset);
  for (const [marker, edge] of [
    [2, 4],
    [3, 4],
    [8, 10],
    [9, 10],
  ])
    assert.equal(promptCursor(doc, editorCursor(doc, marker!)), edge);
});
