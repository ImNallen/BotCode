import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const HTML = "http://www.w3.org/1999/xhtml";

export class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  attributes = new Map<string, string>();
  style = { setProperty() {}, removeProperty() {} };
  namespaceURI = HTML;
  modal = false;
  text = "";
  readonly nodeType: number;
  readonly tagName: string;
  readonly ownerDocument: FakeDocument | null;
  constructor(
    nodeType: number,
    tagName: string,
    ownerDocument: FakeDocument | null,
  ) {
    this.nodeType = nodeType;
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
  }
  get nodeName() {
    return this.tagName;
  }
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes.at(-1) ?? null;
  }
  set textContent(text: string) {
    this.childNodes = [];
    this.text = text;
  }
  get textContent(): string {
    return this.text + this.childNodes.map((n) => n.textContent).join("");
  }
  addEventListener() {}
  removeEventListener() {}
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  appendChild(child: FakeNode) {
    return this.insertBefore(child, null);
  }
  insertBefore(child: FakeNode, before: FakeNode | null) {
    child.parentNode?.removeChild(child);
    const index = before ? this.childNodes.indexOf(before) : -1;
    if (index < 0) this.childNodes.push(child);
    else this.childNodes.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child: FakeNode) {
    this.childNodes = this.childNodes.filter((node) => node !== child);
    child.parentNode = null;
    return child;
  }
  contains(node: FakeNode | null): boolean {
    return (
      node === this || this.childNodes.some((child) => child.contains(node))
    );
  }
  showModal() {
    this.modal = true;
  }
  close() {
    this.modal = false;
  }
}

export class FakeDocument extends FakeNode {
  body: FakeNode;
  documentElement: FakeNode;
  activeElement = null;
  constructor() {
    super(9, "#document", null);
    this.documentElement = this.appendChild(new FakeNode(1, "HTML", this));
    this.body = this.documentElement.appendChild(new FakeNode(1, "BODY", this));
  }
  createElement(tag: string) {
    return new FakeNode(1, tag.toUpperCase(), this);
  }
  createElementNS(namespaceURI: string, tag: string) {
    const node = new FakeNode(1, tag, this);
    node.namespaceURI = namespaceURI;
    return node;
  }
  createTextNode(text: string) {
    const node = new FakeNode(3, "#text", this);
    node.text = text;
    return node;
  }
}

export function findAll(node: FakeNode, tagName: string): FakeNode[] {
  return [
    ...(node.tagName === tagName ? [node] : []),
    ...node.childNodes.flatMap((child) => findAll(child, tagName)),
  ];
}

export async function withFakeDom(
  run: (dom: {
    document: FakeDocument;
    subtree: FakeNode;
    root: Root;
  }) => Promise<void>,
) {
  const document = new FakeDocument();
  const globals = ["document", "window", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = globals.map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name),
  );
  for (const [name, value] of [
    ["document", document],
    ["window", { document, HTMLIFrameElement: class {} }],
    ["IS_REACT_ACT_ENVIRONMENT", true],
  ] as const)
    Object.defineProperty(globalThis, name, { configurable: true, value });
  const subtree = document.body.appendChild(document.createElement("div"));
  const root = createRoot(subtree as unknown as HTMLElement);
  try {
    await run({ document, subtree, root });
  } finally {
    await act(() => root.unmount());
    globals.forEach((name, index) => {
      const descriptor = previous[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
}
