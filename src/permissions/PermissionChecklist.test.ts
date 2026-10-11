import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PermissionChecklist } from "./PermissionChecklist";

it("shows observed grants as Allowed and retains an Allow control for denied permissions", () => {
  const html = renderToStaticMarkup(
    createElement(PermissionChecklist, {
      permissions: [
        {
          id: "screen-recording",
          title: "Screen Recording",
          description: "Screen capture",
          icon: null,
          granted: true,
          onAllow: () => {},
        },
        {
          id: "accessibility",
          title: "Accessibility",
          description: "App control",
          icon: null,
          granted: false,
          onAllow: () => {},
        },
      ],
    }),
  );
  assert.match(html, /role="status"/);
  assert.match(html, /Allowed/);
  assert.equal((html.match(/<button/g) ?? []).length, 1);
  assert.match(html, />Allow<\/button>/);
  assert.equal(html.includes(' disabled=""'), false);
});
it("disables denied permission actions while System Settings is opening", () => {
  const html = renderToStaticMarkup(
    createElement(PermissionChecklist, {
      busy: true,
      permissions: [
        {
          id: "accessibility",
          title: "Accessibility",
          description: "App control",
          icon: null,
          granted: false,
          onAllow: () => {},
        },
      ],
    }),
  );
  assert.match(html, /disabled=""/);
  assert.equal(html.includes("Allowed"), false);
});
