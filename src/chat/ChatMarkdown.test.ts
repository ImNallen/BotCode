import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMarkdown } from "./ChatMarkdown";

const tasks =
  "- [ ] first\n- [x] second\n  - [ ] nested\n\n![logo](./logo.png)\n";
const render = (props: Parameters<typeof ChatMarkdown>[0]) =>
  renderToStaticMarkup(createElement(ChatMarkdown, props));

describe("ChatMarkdown documents", () => {
  it("keeps chat task checkboxes read-only and images as authored", () => {
    const html = render({ text: tasks });
    assert.equal(
      (html.match(/<input type="checkbox" disabled=""/g) ?? []).length,
      3,
    );
    assert.ok(!html.includes("Toggle task"));
    assert.ok(!html.includes("data-task-marker-offset"));
    assert.ok(html.includes('<img src="./logo.png" alt="logo"/>'));
  });

  it("makes file task checkboxes toggleable and marks each item with its source offset", () => {
    const html = render({ text: tasks, onTaskListChange: () => {} });
    assert.ok(!html.includes("disabled"));
    assert.equal((html.match(/aria-label="Toggle task"/g) ?? []).length, 3);
    const offsets = [...html.matchAll(/data-task-marker-offset="(\d+)"/g)].map(
      (match) => Number(match[1]),
    );
    assert.deepEqual(offsets, [2, 14, 29]);
    for (const offset of offsets)
      assert.ok(/^\[[ xX]\]$/.test(tasks.slice(offset, offset + 3)));
  });

  it("rewrites image sources only through imageSrc", () => {
    assert.ok(
      render({
        text: tasks,
        imageSrc: (src) => `botcode-workspace://localhost/w/-/${src}`,
      }).includes('src="botcode-workspace://localhost/w/-/./logo.png"'),
    );
    assert.ok(
      render({ text: tasks, imageSrc: () => undefined }).includes(
        'src="./logo.png"',
      ),
    );
  });

  it("keeps the task-list-item class on skill messages", () => {
    assert.ok(
      render({ text: tasks, skills: [] }).includes(
        '<li class="task-list-item">',
      ),
    );
  });
});
