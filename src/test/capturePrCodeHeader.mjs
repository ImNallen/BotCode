import { registerHooks } from "node:module";
import { Children, isValidElement } from "react";

let header;
let collapsed;
export function CodeView({ items, renderHeaderMetadata }) {
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
