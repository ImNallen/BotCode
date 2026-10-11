import assert from "node:assert/strict";
import { it } from "node:test";
import { act, createElement } from "react";
import { findAll, withFakeDom } from "../test/fakeDom";
import { Dialog } from "./dialog";

it("a dialog opened inside a subtree mounts on the body, so moving that subtree cannot hide it", () =>
  withFakeDom(async ({ document, subtree, root }) => {
    const render = (open: boolean) =>
      act(() =>
        root.render(
          createElement(Dialog, {
            open,
            onOpenChange() {},
            children: "Commit",
          }),
        ),
      );
    await render(true);
    const [dialog] = findAll(document, "DIALOG");
    assert.equal(dialog?.parentNode?.tagName, "BODY");
    assert.equal(dialog?.modal, true);
    assert.equal(dialog?.textContent, "Commit");
    assert.equal(findAll(subtree, "DIALOG").length, 0);
    await render(false);
    assert.equal(findAll(document, "DIALOG").length, 0);
    assert.equal(dialog?.modal, false);
  }));
