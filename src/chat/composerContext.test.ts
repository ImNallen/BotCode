import assert from "node:assert/strict";
import { it } from "node:test";
import { getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { history, undo } from "@tiptap/pm/history";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { composerEditorExtensions } from "./ComposerPromptEditor";
import {
  buildComposerDocument,
  composerDocumentMap,
  editorCursor,
  promptCursor,
  replaceComposerText,
} from "./composerDocument";
import {
  appendContext,
  contextReference,
  messageContext,
  referencedContext,
  truncateContextText,
  type ComposerContextRecord,
} from "./composerContext";
import {
  encodeContextClipboard,
  readContextClipboard,
} from "./composerContextClipboard";
import {
  activateComposer,
  clearAcceptedInput,
  restoreFollowUps,
  recoveryFit,
  mergeRecoveredInput,
  sendAttempt,
} from "./composerAttachments";
import { detectComposerTrigger } from "./composer-logic";
import { ChatMarkdown } from "./ChatMarkdown";
import { readComposerDraft, writeComposerDraft } from "./composerDrafts";

const terminal: ComposerContextRecord = {
  version: 1,
  contextId: "terminal_test",
  label: "Terminal 1 lines 3-4",
  kind: "terminal",
  terminalId: "term-1",
  terminalLabel: "Terminal 1",
  lineStart: 3,
  lineEnd: 4,
  text: "one\ntwo",
};
const citation: ComposerContextRecord = {
  version: 1,
  contextId: "citation_test",
  label: "Assistant quote",
  kind: "citation",
  environmentId: "workspace",
  threadId: "thread",
  messageId: "message",
  text: " selected text ",
  start: 2,
  end: 17,
  prefix: "a ",
  suffix: " z",
};
const review: ComposerContextRecord = {
  version: 1,
  contextId: "review_test",
  label: "file.ts +3",
  kind: "review-comment",
  sectionId: "working",
  sectionTitle: "Working tree",
  filePath: "file.ts",
  startIndex: 2,
  endIndex: 2,
  rangeLabel: "+3",
  text: "Fix this",
  diff: "@@ -2,0 +3,1 @@\n+three",
};
const skill: ComposerContextRecord = {
  version: 1,
  contextId: "skill_test",
  label: "repo-proof",
  kind: "skill",
  name: "repo-proof",
};
const schema = getSchema(composerEditorExtensions);

it("round trips every context payload through one document node and preserves cursor boundaries", () => {
  const content = [terminal, citation, review, skill].reduce(appendContext, {
    text: "Please inspect",
    records: [] as ComposerContextRecord[],
  });
  const doc = schema.nodeFromJSON(
    buildComposerDocument(content.text, content.records),
  );
  const restored = composerDocumentMap(schema.nodeFromJSON(doc.toJSON()));
  assert.equal(restored.text, content.text);
  assert.deepEqual(restored.records, content.records);
  for (const reference of content.records) {
    const offset = content.text.indexOf(contextReference(reference));
    assert.equal(promptCursor(doc, editorCursor(doc, offset)), offset);
  }
  assert.equal(
    new Set(
      doc.firstChild?.content.content
        .filter((node) => !node.isText)
        .map((node) => node.type.name),
    ).size,
    1,
  );
});

it("restores deleted chip payloads through ProseMirror undo", () => {
  const text = contextReference(terminal);
  let state = EditorState.create({
    schema,
    doc: schema.nodeFromJSON(buildComposerDocument(text, [terminal])),
    plugins: [history()],
  });
  state = state.apply(state.tr.delete(1, 2));
  assert.deepEqual(composerDocumentMap(state.doc).records, []);
  assert.ok(
    undo(state, (transaction) => {
      state = state.apply(transaction);
    }),
  );
  assert.equal(composerDocumentMap(state.doc).text, text);
  assert.deepEqual(composerDocumentMap(state.doc).records, [terminal]);
});

it("replaces the selected prompt with every pasted line and preserves surrounding chips and undo", () => {
  const original = `Before ${contextReference(terminal)} selected after`;
  let state = EditorState.create({
    schema,
    doc: schema.nodeFromJSON(buildComposerDocument(original, [terminal])),
    plugins: [history()],
  });
  const start = original.indexOf("selected");
  const tr = state.tr;
  assert.equal(
    replaceComposerText(tr, {
      start,
      end: start + "selected".length,
      expectedText: "selected",
      replacement: "first\n\nthird",
    }),
    true,
  );
  state = state.apply(tr);
  assert.equal(
    composerDocumentMap(state.doc).text,
    original.replace("selected", "first\n\nthird"),
  );
  assert.deepEqual(composerDocumentMap(state.doc).records, [terminal]);
  assert.equal(promptCursor(state.doc, state.selection.from), start + 12);
  assert.ok(
    undo(state, (transaction) => {
      state = state.apply(transaction);
    }),
  );
  assert.equal(composerDocumentMap(state.doc).text, original);
  assert.deepEqual(composerDocumentMap(state.doc).records, [terminal]);
});

it("keeps a full chip draft valid when a staged file cannot fit an inline chip", () => {
  const records = Array.from({ length: 200 }, (_, i) => ({
    ...terminal,
    contextId: `full_${i}`,
  }));
  const text = records.map(contextReference).join(" ");
  const state = EditorState.create({
    schema,
    doc: schema.nodeFromJSON(buildComposerDocument(text, records)),
  });
  const file: ComposerContextRecord = {
    version: 1,
    kind: "file",
    contextId: "file_new",
    label: "report.pdf",
    attachmentId: "a".repeat(64),
    name: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 4,
  };
  const tr = state.tr;
  assert.equal(
    replaceComposerText(tr, {
      start: text.length,
      end: text.length,
      expectedText: "",
      replacement: ` ${contextReference(file)}`,
      records: [file],
    }),
    false,
  );
  assert.equal(tr.doc, state.doc);
  assert.equal(
    messageContext.safeParse({
      version: 1,
      records: composerDocumentMap(tr.doc).records,
    }).success,
    true,
  );
});

it("pastes HTML clipboard chips with their complete captured content and new identities", () => {
  const original = {
    text: `${contextReference(terminal)} ${contextReference(citation)} ${contextReference(terminal)}`,
    records: [terminal, citation],
  };
  const encoded = encodeContextClipboard(original);
  const pasted = readContextClipboard({
    getData: (type) =>
      type === "text/html"
        ? encoded.html
        : type === "text/plain"
          ? encoded.text
          : "",
  });
  assert.ok(pasted);
  assert.equal(pasted.records.length, 2);
  assert.ok(pasted.records[0]?.contextId !== terminal.contextId);
  assert.equal(pasted.records[0]?.kind, "terminal");
  assert.equal(pasted.records[1]?.kind, "citation");
  if (pasted.records[1]?.kind === "citation")
    assert.equal(pasted.records[1].text, citation.text);
  assert.equal(
    pasted.text.match(
      new RegExp(pasted.records[0]?.contextId ?? "missing", "g"),
    )?.length,
    2,
  );
  const doc = schema.nodeFromJSON(
    buildComposerDocument(pasted.text, pasted.records),
  );
  assert.deepEqual(composerDocumentMap(doc).records, pasted.records);
});

it("rejects malformed, overlong and duplicate payloads and keeps unavailable links pasteable", () => {
  assert.equal(
    messageContext.safeParse({ version: 1, records: [terminal, terminal] })
      .success,
    false,
  );
  assert.equal(
    messageContext.safeParse({
      version: 1,
      records: [{ ...terminal, text: "x".repeat(64_001) }],
    }).success,
    false,
  );
  assert.equal(
    messageContext.safeParse({
      version: 1,
      records: [{ ...terminal, lineEnd: 1 }],
    }).success,
    false,
  );
  const text = contextReference(terminal);
  const pasted = readContextClipboard({
    getData: (type) =>
      type === "application/x-t3-context-fragment+json"
        ? "{invalid"
        : type === "text/plain"
          ? text
          : "",
  });
  assert.deepEqual(pasted, { text, records: [] });
  assert.equal(
    composerDocumentMap(schema.nodeFromJSON(buildComposerDocument(text))).text,
    text,
  );
  const html = renderToStaticMarkup(createElement(ChatMarkdown, { text }));
  assert.ok(html.includes('data-state="unresolved"'));
});

it("holds immutable records in captured sends and safely restores queued chips beside a draft", () => {
  const content = appendContext({ text: "Check", records: [] }, terminal);
  const started = { ...activateComposer("thread"), ...content };
  const context = referencedContext(content);
  let minted = 0;
  const first = sendAttempt(
    null,
    "thread",
    content.text,
    [],
    () => String(++minted),
    context,
  );
  assert.equal(
    sendAttempt(
      first,
      "thread",
      content.text,
      [],
      () => String(++minted),
      context,
    ).requestId,
    first.requestId,
  );
  assert.ok(
    sendAttempt(first, "thread", content.text, [], () => String(++minted), {
      ...context,
      records: [{ ...terminal, text: "changed" }],
    }).requestId !== first.requestId,
  );
  const later = {
    ...started,
    text: "Later",
    generation: started.generation + 1,
  };
  assert.equal(clearAcceptedInput(later, started), later);
  const recovered = restoreFollowUps(started, [
    { id: "queued", text: content.text, attachments: [], context },
  ]);
  assert.equal(recovered.error, null);
  assert.equal(recovered.input.records.length, 2);
  assert.ok(recovered.input.records[1]?.contextId !== terminal.contextId);
  assert.equal(referencedContext(recovered.input).records.length, 2);
});

it("opens the PR menu for recent, number and text queries with T3 boundaries", () => {
  for (const query of ["", "123", "search", "fix-issue", "日本語"])
    assert.deepEqual(
      detectComposerTrigger(`Check #${query}`, `Check #${query}`.length),
      {
        kind: "pull-request",
        query,
        rangeStart: 6,
        rangeEnd: 7 + query.length,
      },
    );
  for (const text of ["#word!", "issue#123", "##", "#abc.def"])
    assert.equal(detectComposerTrigger(text, text.length), null);
});

it("renders saved context chips as labels backed by their captured payload", () => {
  const html = renderToStaticMarkup(
    createElement(ChatMarkdown, {
      text: contextReference(terminal),
      records: [terminal],
    }),
  );
  assert.ok(html.includes('data-composer-context-kind="terminal"'));
  assert.ok(html.includes("Terminal 1 lines 3-4"));
  assert.ok(html.includes("one\ntwo"));
  assert.equal(html.includes('data-state="unresolved"'), false);
});

it("refuses rewind recovery without consuming it when the chip limit is full", () => {
  const current = activateComposer("thread");
  current.records = Array.from({ length: 200 }, (_, i) => ({
    ...terminal,
    contextId: `c_${i}`,
  }));
  const result = {
    requestId: "revert",
    turnId: "turn",
    turnCount: 0,
    prompt: contextReference(terminal),
    attachments: [],
    context: { version: 1 as const, records: [terminal] },
  };
  assert.ok(recoveryFit([], result, current.records)?.includes("200-chip"));
  assert.equal(mergeRecoveredInput(current, result), current);
  assert.equal(current.appliedRevertId, null);
});

it("keeps bounded context text valid at a UTF-16 surrogate boundary", () => {
  assert.equal(
    truncateContextText("a".repeat(63_999) + "😀", 64_000),
    "a".repeat(63_999),
  );
  assert.equal(truncateContextText("a😀", 3), "a😀");
});

it("retains full paths and skill names behind bounded chip labels", () => {
  for (const text of [
    `[${"x".repeat(201)}](src/${"x".repeat(201)})`,
    `$${"s".repeat(201)} `,
  ]) {
    const mapped = composerDocumentMap(
      schema.nodeFromJSON(buildComposerDocument(text)),
    );
    assert.equal(mapped.records.length, 1);
    assert.equal(mapped.records[0]?.label.length, 200);
    assert.equal(
      messageContext.safeParse({ version: 1, records: mapped.records }).success,
      true,
    );
  }
});

it("retains recovered attachments and their recovery marker across draft reload", async () => {
  const previous = globalThis.localStorage;
  const values = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
  try {
    const attachment = {
      id: "a".repeat(64),
      name: "image.png",
      mimeType: "image/png" as const,
      kind: "image" as const,
      sizeBytes: 1,
    };
    const recovery = {
      requestId: "revert-image",
      turnId: "turn",
      turnCount: 0,
      prompt: contextReference(terminal),
      context: { version: 1 as const, records: [terminal] },
      attachments: [attachment],
    };
    const recovered = mergeRecoveredInput(activateComposer("thread"), recovery);
    await writeComposerDraft("draft-test", recovered);
    const reloaded = {
      ...activateComposer("thread"),
      ...readComposerDraft("draft-test"),
    };
    const merged = mergeRecoveredInput(reloaded, recovery);
    assert.equal(merged.attachments.length, 1);
    assert.equal(merged.records.length, 1);
    assert.equal(merged.text, recovered.text);
    assert.equal(merged.appliedRevertId, recovery.requestId);
    await writeComposerDraft("draft-test", {
      ...merged,
      text: "",
      records: [],
      attachments: [],
    });
    const cleared = {
      ...activateComposer("thread"),
      ...readComposerDraft("draft-test"),
    };
    assert.equal(mergeRecoveredInput(cleared, recovery).text, "");
    assert.equal(cleared.appliedRevertId, recovery.requestId);
  } finally {
    globalThis.localStorage = previous;
  }
});
