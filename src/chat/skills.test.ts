import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getSchema } from "@tiptap/core";
import { QueryClient } from "@tanstack/react-query";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { Skill } from "../ipc";
import { detectComposerTrigger } from "./composer-logic";
import { composerEditorExtensions } from "./ComposerPromptEditor";
import {
  buildComposerDocument,
  composerDocumentMap,
  editorCursor,
  promptCursor,
} from "./composerDocument";
import { searchProviderSkills } from "./providerSkillSearch";
import { searchSlashCommandItems } from "./composerSlashCommandSearch";
import { ChatMarkdown } from "./ChatMarkdown";
import { normalizeSkillMentions } from "./composerSkillTokens";
import { checkoutSkillsQuery, SKILLS_STALE_TIME } from "./useCheckoutSkills";

const poteto: Skill = {
  name: "pstack:poteto-mode",
  path: "/skills/poteto-mode/SKILL.md",
  enabled: true,
  scope: "user",
  shortDescription: "Deliberate agents and verified work",
};
const repository: Skill = {
  name: "repo-proof",
  path: "/checkout/.agents/skills/repo-proof/SKILL.md",
  enabled: true,
  scope: "repo",
  displayName: "Repository proof",
};

it("opens skills at a token boundary and leaves monetary amounts as prose", () => {
  assert.equal(
    normalizeSkillMentions("£repo-proof $5 $20k $1e6"),
    "$repo-proof $5 $20k $1e6",
  );
  for (const token of ["$", "$pot", "$pstack:poteto-mode"]) {
    const text = `Use ${token}`;
    assert.deepEqual(detectComposerTrigger(text, text.length), {
      kind: "skill",
      query: token.slice(1),
      rangeStart: 4,
      rangeEnd: text.length,
    });
  }
  for (const token of [
    "$5",
    "$20k",
    "$100M",
    "$1e6",
    "$5.00",
    "cost$pot",
    "#123",
  ]) {
    assert.equal(detectComposerTrigger(token, token.length), null, token);
    const doc = getSchema(composerEditorExtensions).nodeFromJSON(
      buildComposerDocument(`${token} `),
    );
    assert.equal(doc.firstChild?.firstChild?.isText, true, token);
  }
});

it("uses T3 name, label, description and scope ranking in both menus", () => {
  const skills = [
    repository,
    { ...poteto, enabled: false },
    poteto,
    { ...poteto, name: "PSTACK:POTETO-MODE" },
    { ...poteto, name: "Poteto Mode" },
    { ...poteto, name: "20k" },
  ];
  assert.deepEqual(
    searchProviderSkills(skills, "").map((skill) => skill.name),
    ["repo-proof", "pstack:poteto-mode"],
  );
  for (const query of ["pot", "$pot", "ptt", "verified"])
    assert.equal(searchProviderSkills(skills, query)[0]?.name, poteto.name);
  assert.equal(
    searchProviderSkills(skills, "Repository proof")[0]?.name,
    repository.name,
  );
  assert.equal(searchProviderSkills(skills, "repo")[0]?.name, repository.name);
  for (const query of ["pot", "/pot", "skill:pot"])
    assert.equal(
      searchSlashCommandItems(query, false, skills)[0]?.id,
      `skill:codex:${poteto.name}`,
    );
  assert.ok(
    searchSlashCommandItems("", false, skills).some(
      (item) => item.id === "slash:usage-limits",
    ),
  );
  assert.equal(searchSlashCommandItems("skill:", false, skills).length, 2);
});

it("serializes picked skill atoms through draft, clipboard and cursor mapping as $name text", () => {
  const value = `Before $${poteto.name} after\n$repo-proof `;
  const doc = getSchema(composerEditorExtensions).nodeFromJSON(
    buildComposerDocument(value),
  );
  assert.equal(doc.firstChild?.child(1).type.name, "composer-skill");
  assert.equal(doc.firstChild?.child(1).attrs.name, poteto.name);
  assert.equal(composerDocumentMap(doc).text, value);
  assert.equal(
    doc.textBetween(0, doc.content.size, "\n", (node) => node.attrs.source),
    value,
  );
  for (const offset of [0, 7, 7 + poteto.name.length + 1, value.length])
    assert.equal(promptCursor(doc, editorCursor(doc, offset)), offset);
});

it("renders sent skills with T3 chips while preserving currency, code, links and copy text", () => {
  const html = renderToStaticMarkup(
    createElement(ChatMarkdown, {
      text: `$${poteto.name} costs $5. \`$${poteto.name}\` [\u0024${poteto.name}](https://example.com)`,
      skills: [poteto],
      lineBreaks: true,
    }),
  );
  assert.equal(html.match(/data-slot="context-chip"/g)?.length, 1);
  assert.ok(html.includes(`data-markdown-copy="$${poteto.name}"`));
  assert.ok(html.includes("Pstack Poteto Mode"));
  assert.ok(html.includes("costs $5."));
  assert.ok(html.includes(`<code>$${poteto.name}</code>`));
  assert.ok(html.includes("https://example.com"));
});

it("isolates checkout catalogs, caches fresh reads, refreshes stale menus and clears failed discovery", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {},
  });
  const calls: string[] = [];
  let fail = false;
  mockIPC((command, payload) => {
    assert.equal(command, "list_skills");
    const cwd = payload && "cwd" in payload ? payload.cwd : null;
    assert.equal(typeof cwd, "string");
    calls.push(String(cwd));
    if (fail) throw new Error("skills/list is unavailable");
    return cwd === "/checkout" ? [repository] : [poteto];
  });
  const client = new QueryClient();
  try {
    assert.deepEqual(
      await client.fetchQuery(checkoutSkillsQuery("/checkout")),
      [repository],
    );
    assert.deepEqual(await client.fetchQuery(checkoutSkillsQuery("/other")), [
      poteto,
    ]);
    await client.fetchQuery(checkoutSkillsQuery("/checkout"));
    assert.deepEqual(calls, ["/checkout", "/other"]);
    client.setQueryData(["skills", "/checkout"], [repository], {
      updatedAt: Date.now() - SKILLS_STALE_TIME - 1,
    });
    await client.fetchQuery(checkoutSkillsQuery("/checkout"));
    assert.equal(calls.length, 3);
    fail = true;
    await client.invalidateQueries({ queryKey: ["skills", "/checkout"] });
    assert.deepEqual(
      await client.fetchQuery(checkoutSkillsQuery("/checkout")),
      [],
    );
    assert.deepEqual(client.getQueryData(["skills", "/other"]), [poteto]);
  } finally {
    client.clear();
    clearMocks();
    if (previousWindow)
      Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
