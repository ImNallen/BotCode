import { registerHooks } from "node:module";
import { Children, isValidElement } from "react";

let header;
let collapsed;
let options;
let item;
export function CodeView({
  items,
  renderHeaderMetadata,
  options: viewOptions,
}) {
  options = viewOptions;
  item = items[0];
  header = renderHeaderMetadata(items[0]);
  collapsed = items[0].collapsed;
  return null;
}
export function capturePrCodeHeader() {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        specifier === "@pierre/diffs/react" &&
        context.parentURL?.endsWith("/PullRequestCodeTab.tsx")
      ) {
        return { url: import.meta.url, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  return () => hooks.deregister();
}
export function capturedViewedPress() {
  function find(node) {
    if (!isValidElement(node)) return;
    if (typeof node.props.onCheckedChange === "function")
      return node.props.onCheckedChange;
    for (const child of Children.toArray(node.props.children)) {
      const press = find(child);
      if (press) return press;
    }
  }
  const press = find(header);
  if (!press)
    throw new Error("No Viewed checkbox was rendered in the file header.");
  return press;
}
export function capturedFileCollapsed() {
  return collapsed;
}

export function clickCheckbox(button) {
  if (typeof button.props.onClick !== "function")
    throw new Error("No checkbox click handler was rendered.");
  let prevented = false;
  button.props.onClick({
    preventDefault() {
      prevented = true;
    },
  });
  return prevented;
}

export async function completePrCodeGesture(kind, start, end) {
  const managerUrl = new URL(
    "managers/InteractionManager.js",
    import.meta.resolve("@pierre/diffs"),
  );
  const { InteractionManager } = await import(managerUrl.href);
  if (!options?.enableGutterUtility || !options.onGutterUtilityClick)
    throw new Error("The comment gutter utility is disabled.");
  const previousElement = globalThis.HTMLElement;
  const previousDocument = globalThis.document;
  const previousFrame = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  class Element {
    hasAttribute(name) {
      return kind === "gutter" && name === "data-utility-button";
    }
    getAttribute() {
      return null;
    }
  }
  globalThis.HTMLElement = Element;
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const manager = new InteractionManager("diff", {
    enableLineSelection: options.enableLineSelection,
    enableGutterUtility: options.enableGutterUtility,
    onGutterUtilityClick: (range) =>
      options.onGutterUtilityClick(range, { item }),
    onLineSelectionEnd: (range) => options.onLineSelectionEnd(range, { item }),
  });
  manager.pre = new Element();
  manager.placeUtility = () => {};
  manager.resolveSelectionPoint = (event) => ({
    lineNumber: event.line,
    side: "additions",
  });
  manager.resolveSelectionInfo = (event) => ({
    lineNumber: event.line,
    eventSide: "additions",
    lineIndex: event.line,
  });
  const event = (line) => ({
    line,
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    composedPath: () => [new Element()],
    preventDefault() {},
    stopPropagation() {},
  });
  try {
    manager.handlePointerDown(event(start));
    if (start !== end) manager.handleDocumentPointerMove(event(end));
    manager.handleDocumentPointerUp(event(end));
  } finally {
    manager.pre = undefined;
    manager.cleanUp();
    globalThis.HTMLElement = previousElement;
    globalThis.document = previousDocument;
    globalThis.requestAnimationFrame = previousFrame;
    globalThis.cancelAnimationFrame = previousCancel;
  }
}
