import { createRoot } from "react-dom/client";

const document = {
  nodeType: 9,
  addEventListener() {},
  removeEventListener() {},
  documentElement: { namespaceURI: "http://www.w3.org/1999/xhtml" },
};
export function installNullReactDOM() {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousAct = Object.getOwnPropertyDescriptor(
    globalThis,
    "IS_REACT_ACT_ENVIRONMENT",
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { document, HTMLIFrameElement: class {} },
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return () => {
    if (previousWindow)
      Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousAct)
      Object.defineProperty(
        globalThis,
        "IS_REACT_ACT_ENVIRONMENT",
        previousAct,
      );
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  };
}
export function createNullReactRoot() {
  return createRoot({
    nodeType: 1,
    ownerDocument: document,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    addEventListener() {},
    removeEventListener() {},
    textContent: "",
    contains() {
      return false;
    },
  });
}
