import assert from "node:assert/strict";
import { it } from "node:test";
import { getSchema } from "@tiptap/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { composerEditorExtensions } from "./ComposerPromptEditor";
import {
  detectComposerTrigger,
  replaceTextRange,
  serializeComposerFileLink,
} from "./composer-logic";
import {
  buildComposerDocument,
  composerDocumentMap,
  composerMentions,
  editorCursor,
  promptCursor,
} from "./composerDocument";
import {
  searchComposerPaths,
  searchSlashCommandItems,
} from "./composerSlashCommandSearch";
import {
  buildPlanImplementationPrompt,
  resolvePlanFollowUpSubmission,
  proposedPlanTitle,
} from "./proposedPlan";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

it("detects triggers at the caret with T3 line and token boundaries", () => {
  assert.deepEqual(detectComposerTrigger("Check @src/fi after", 13), {
    kind: "path",
    query: "src/fi",
    rangeStart: 6,
    rangeEnd: 13,
  });
  assert.deepEqual(detectComposerTrigger("First\n/pl", 9), {
    kind: "slash-command",
    query: "pl",
    rangeStart: 6,
    rangeEnd: 9,
  });
  for (const text of [
    "email@host",
    "See /plan",
    "$skill",
    "#123",
    "/plan prompt",
  ])
    assert.equal(detectComposerTrigger(text, text.length), null);
  assert.equal(detectComposerTrigger("\n@file", 0), null);
});

it("replaces only the selected range and keeps surrounding draft text", () => {
  assert.deepEqual(replaceTextRange("Before @src after", 7, 11, "chip "), {
    text: "Before chip  after",
    cursor: 12,
  });
});

it("serializes path chips without losing spaces, brackets, punctuation or Unicode", () => {
  const paths = [
    "src/My file.ts",
    "src/[x](a)#?%.tsx",
    "folder/日本語.md",
    "@scope/package",
    "folder\\file.txt",
  ];
  const schema = getSchema(composerEditorExtensions);
  for (const path of paths) {
    const link = serializeComposerFileLink(path);
    assert.equal(composerMentions(`Before ${link} after`)[0]?.path, path);
    const value = `Before ${link} after\nsecond line\n`;
    const doc = schema.nodeFromJSON(buildComposerDocument(value));
    assert.equal(composerDocumentMap(doc).text, value);
    assert.equal(doc.firstChild?.child(1).type.name, "composer-mention");
    for (const offset of [
      0,
      7,
      7 + link.length,
      value.length - 1,
      value.length,
    ])
      assert.equal(promptCursor(doc, editorCursor(doc, offset)), offset);
  }
});

it("keeps external links and scoped package prose as ordinary text", () => {
  assert.deepEqual(
    composerMentions("[test](https://example.com/test) @scope/package "),
    [],
  );
  assert.equal(
    composerMentions('@"folder/My file.ts" ')[0]?.path,
    "folder/My file.ts",
  );
});

it("searches only supplied checkout files and supports subsequence search", () => {
  const files = ["src/My file.ts", "README.md", "src/composer.tsx"];
  assert.equal(searchComposerPaths(files, "my")[0]?.id, "path:src/My file.ts");
  assert.equal(
    searchComposerPaths(files, "cmps")[0]?.id,
    "path:src/composer.tsx",
  );
  assert.deepEqual(searchComposerPaths(files, "another-checkout"), []);
});

it("gates mode commands on live support and ranks command names before descriptions", () => {
  assert.deepEqual(
    searchSlashCommandItems("", false).map((item) => item.command),
    ["model", "usage-limits"],
  );
  assert.deepEqual(
    searchSlashCommandItems("", true).map((item) => item.command),
    ["model", "plan", "default", "usage-limits"],
  );
  assert.equal(searchSlashCommandItems("/plan", true)[0]?.command, "plan");
  assert.equal(
    searchSlashCommandItems("limits", true)[0]?.command,
    "usage-limits",
  );
});

it("refines typed plan followups and implements empty followups in Build", () => {
  const plan = "# Safe plan\n\nDo the work.";
  assert.deepEqual(
    resolvePlanFollowUpSubmission({
      draftText: " Keep it small ",
      planMarkdown: plan,
    }),
    { text: "Keep it small", interactionMode: "plan" },
  );
  assert.deepEqual(
    resolvePlanFollowUpSubmission({ draftText: " ", planMarkdown: plan }),
    { text: buildPlanImplementationPrompt(plan), interactionMode: "default" },
  );
  assert.equal(proposedPlanTitle(plan), "Safe plan");
  const card = renderToStaticMarkup(
    createElement(ProposedPlanCard, { text: plan, streaming: false }),
  );
  assert.ok(card.includes("Safe plan"));
  assert.ok(card.includes("Do the work"));
});

it("labels a typed plan followup Refine while keeping the composer action pill", () => {
  const html = renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      running: false,
      canStop: false,
      stopping: false,
      canSend: true,
      followUpBehavior: "queue",
      showPlanFollowUp: true,
      promptHasText: true,
      onStop() {},
      onImplementInNewThread() {},
    }),
  );
  assert.ok(html.includes(">Refine<"));
  assert.ok(html.includes('type="submit"'));
});
