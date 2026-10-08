// Ported from T3 Code v0.0.45 apps/server/src/mcp/toolkits/preview/tools.ts.
function (request) {
  const { args, key } = request;
  const encoder = new TextEncoder();
  const textInputTypes = new Set([
    "text",
    "search",
    "tel",
    "url",
    "email",
    "password",
  ]);
  const semanticSelector = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "textarea",
    "select",
    "option",
    "summary",
    "[role]",
    "[contenteditable]",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "img[alt]",
    "main",
    "nav",
    "header",
    "footer",
    "aside",
    "form",
    "[tabindex]",
  ].join(",");

  function fail(message) {
    throw new Error(message);
  }

  function characters(text, limit) {
    const prefix = text.slice(0, limit);
    return /[\uD800-\uDBFF]$/.test(prefix) ? prefix.slice(0, -1) : prefix;
  }

  function utf8Prefix(text, limit) {
    let prefix = characters(text, limit);
    if (encoder.encode(prefix).length <= limit) return prefix;
    let low = 0;
    let high = prefix.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (encoder.encode(characters(prefix, middle)).length <= limit)
        low = middle;
      else high = middle - 1;
    }
    return characters(prefix, low);
  }

  function jsonTextPrefix(text, limit) {
    let low = 0;
    let high = Math.min(text.length, limit);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (
        encoder.encode(JSON.stringify(characters(text, middle))).length <= limit
      )
        low = middle;
      else high = middle - 1;
    }
    return characters(text, low);
  }

  function clean(text, limit = 200) {
    return characters(
      String(text ?? "")
        .replace(/\s+/g, " ")
        .trim(),
      limit,
    );
  }

  function visible(element) {
    if (!element.isConnected || element.ownerDocument !== document)
      return false;
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.visibility === "collapse")
      return false;
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      const ancestorStyle = getComputedStyle(ancestor);
      if (
        ancestor.hidden ||
        ancestorStyle.display === "none" ||
        ancestorStyle.contentVisibility === "hidden" ||
        ancestorStyle.opacity === "0"
      )
        return false;
    }
    return Array.from(element.getClientRects()).some(
      (rect) => rect.width > 0 && rect.height > 0,
    );
  }

  function enabled(element) {
    return (
      !element.matches(":disabled") &&
      element.getAttribute("aria-disabled") !== "true" &&
      !element.closest("[inert]")
    );
  }

  function target(input, { optional = false, waiting = false } = {}) {
    let element;
    if (input.ref !== undefined) {
      const state = window[key];
      element =
        state?.document === document ? state.refs.get(input.ref) : undefined;
      if (
        !element ||
        !element.isConnected ||
        element.ownerDocument !== document
      ) {
        fail(
          "Snapshot ref is stale. Take a new preview_snapshot and use its current ref.",
        );
      }
    } else if (input.selector !== undefined) {
      let matches;
      try {
        matches = document.querySelectorAll(input.selector);
      } catch {
        fail("Invalid CSS selector.");
      }
      if (matches.length > 1)
        fail(
          "CSS selector matched several elements. Use a unique selector or snapshot ref.",
        );
      if (matches.length === 0) {
        if (waiting) return null;
        fail("CSS selector did not match an element.");
      }
      element = matches[0];
    } else if (optional) {
      return null;
    } else {
      fail("Supply one snapshot ref or CSS selector.");
    }
    if (!visible(element)) {
      if (waiting) return null;
      fail(
        "Target is hidden. Wait for it to become visible or choose another target.",
      );
    }
    if (!enabled(element)) {
      if (waiting) return null;
      fail("Target is disabled or inert.");
    }
    return element;
  }

  function role(element) {
    const explicit = clean(element.getAttribute("role"), 64);
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "input") {
      if (element.type === "checkbox" || element.type === "radio")
        return element.type;
      if (["button", "submit", "reset", "image"].includes(element.type))
        return "button";
      return element.type === "search" ? "searchbox" : "textbox";
    }
    if (element.isContentEditable) return "textbox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    return (
      {
        a: "link",
        button: "button",
        textarea: "textbox",
        select: element.multiple ? "listbox" : "combobox",
        option: "option",
        summary: "button",
        img: "img",
        main: "main",
        nav: "navigation",
        header: "banner",
        footer: "contentinfo",
        aside: "complementary",
        form: "form",
      }[tag] ?? "generic"
    );
  }

  function name(element) {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const label = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      if (clean(label)) return clean(label);
    }
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) return clean(ariaLabel);
    if (element.labels?.length)
      return clean(
        Array.from(element.labels, (label) => label.innerText).join(" "),
      );
    if (element instanceof HTMLImageElement) return clean(element.alt);
    if (element instanceof HTMLInputElement) {
      if (["button", "submit", "reset"].includes(element.type))
        return clean(element.value);
      return clean(
        element.getAttribute("placeholder") ?? element.getAttribute("title"),
      );
    }
    return clean(element.innerText || element.getAttribute("title"));
  }

  function describe(element) {
    return {
      tag: element.tagName.toLowerCase(),
      role: role(element),
      name: name(element),
    };
  }

  function metadata() {
    return {
      url: jsonTextPrefix(location.href, 4096),
      title: jsonTextPrefix(clean(document.title, 512), 1024),
      viewport: { width: innerWidth, height: innerHeight },
    };
  }

  function status() {
    return {
      ...metadata(),
      readyState: document.readyState,
      colorScheme: matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light",
    };
  }

  function snapshot() {
    const state = { document, snapshotId: args.snapshotId, refs: new Map() };
    Object.defineProperty(window, key, { value: state, configurable: true });
    const bodyText = document.body?.innerText ?? "";
    const value = {
      ...metadata(),
      bodyText: jsonTextPrefix(bodyText, 8000),
      elements: [],
      omitted: { elements: 0, bodyTextCharacters: 0 },
      limitations: [
        "Main document only. Frame contents and shadow roots are not inspected.",
        "Interactions dispatch untrusted DOM events; trusted-input-only behavior is not guaranteed.",
      ],
    };
    value.omitted.bodyTextCharacters = bodyText.length - value.bodyText.length;
    let byteCount = encoder.encode(JSON.stringify(value)).length;
    let index = 0;
    for (const element of document.querySelectorAll(semanticSelector)) {
      if (!visible(element)) continue;
      const ref = `${args.snapshotId}:e${++index}`;
      const entry = { ref, ...describe(element), disabled: !enabled(element) };
      if (element instanceof HTMLInputElement) {
        entry.type = element.type;
        if (textInputTypes.has(element.type) && element.type !== "password")
          entry.value = clean(element.value);
        if (element.type === "checkbox" || element.type === "radio")
          entry.checked = element.checked;
      } else if (
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      ) {
        entry.value = clean(element.value);
      } else if (element instanceof HTMLOptionElement) {
        entry.selected = element.selected;
      }
      if (element instanceof HTMLAnchorElement)
        entry.href = utf8Prefix(element.href, 512);
      const entryBytes = encoder.encode(JSON.stringify(entry)).length + 1;
      if (value.elements.length >= 200 || byteCount + entryBytes > 19500) {
        value.omitted.elements++;
        continue;
      }
      value.elements.push(entry);
      state.refs.set(ref, element);
      byteCount += entryBytes;
    }
    return value;
  }

  function prepare(element) {
    element.scrollIntoView({
      block: "center",
      inline: "center",
      behavior: "instant",
    });
    element.focus?.({ preventScroll: true });
  }

  function activate(element) {
    if (element instanceof HTMLElement)
      HTMLElement.prototype.click.call(element);
    else
      element.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
  }

  function click() {
    const element = target(args);
    const description = describe(element);
    prepare(element);
    activate(element);
    return {
      url: utf8Prefix(location.href, 4096),
      target: description,
      trusted: false,
    };
  }

  function textControl(element) {
    return (
      element instanceof HTMLTextAreaElement ||
      (element instanceof HTMLInputElement && textInputTypes.has(element.type))
    );
  }

  function editable(element) {
    if (textControl(element)) {
      if (element.readOnly) fail("Target is read-only.");
      return "control";
    }
    if (element.isContentEditable) return "contenteditable";
    fail(
      "Target does not support text editing. Choose a text input, textarea or contenteditable element.",
    );
  }

  function beforeInput(element, text, inputType) {
    return element.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        composed: true,
        data: text,
        inputType,
      }),
    );
  }

  function inputEvent(element, text, inputType) {
    element.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        data: text,
        inputType,
      }),
    );
  }

  function replaceControl(
    element,
    start,
    end,
    text,
    inputType,
    change = false,
  ) {
    if (!beforeInput(element, text, inputType)) return false;
    const next =
      element.value.slice(0, start) + text + element.value.slice(end);
    const prototype =
      element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, next);
    if (element.selectionStart !== null) {
      const position = Math.min(start + text.length, element.value.length);
      element.setSelectionRange(position, position);
    }
    inputEvent(element, text, inputType);
    if (change) element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function replaceContent(element, text, clear) {
    if (!beforeInput(element, text, "insertText")) return false;
    const selection = getSelection();
    if (!selection) fail("The page has no editable selection.");
    let range;
    if (
      !clear &&
      selection.rangeCount > 0 &&
      element.contains(selection.anchorNode) &&
      element.contains(selection.focusNode)
    ) {
      range = selection.getRangeAt(0);
    } else {
      range = document.createRange();
      range.selectNodeContents(element);
      if (!clear) range.collapse(false);
    }
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    inputEvent(element, text, "insertText");
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function type() {
    const element = target(args);
    const kind = editable(element);
    const description = describe(element);
    prepare(element);
    const applied =
      kind === "control"
        ? replaceControl(
            element,
            args.clear ? 0 : (element.selectionStart ?? element.value.length),
            args.clear
              ? element.value.length
              : (element.selectionEnd ?? element.value.length),
            args.text,
            "insertText",
            true,
          )
        : replaceContent(element, args.text, args.clear ?? false);
    if (!applied) fail("The page canceled beforeinput. Text was not inserted.");
    return {
      url: utf8Prefix(location.href, 4096),
      target: description,
      insertedCharacters: args.text.length,
      trusted: false,
    };
  }

  function boundaries(text) {
    if (typeof Intl.Segmenter === "function") {
      const segmenter = new Intl.Segmenter(undefined, {
        granularity: "grapheme",
      });
      return [
        ...Array.from(segmenter.segment(text), (part) => part.index),
        text.length,
      ];
    }
    let index = 0;
    const result = [0];
    for (const character of text) {
      index += character.length;
      result.push(index);
    }
    return result;
  }

  function adjacent(text, index, direction) {
    const points = boundaries(text);
    if (direction < 0) return points.findLast((point) => point < index) ?? 0;
    return points.find((point) => point > index) ?? text.length;
  }

  function selection(element) {
    if (!textControl(element))
      fail(
        "This key default supports only text inputs and textareas. Use preview_type or page handlers for other controls.",
      );
    if (element.selectionStart === null || element.selectionEnd === null) {
      fail(
        "This input type does not expose a text selection. Use preview_type with clear=true.",
      );
    }
    return {
      start: element.selectionStart,
      end: element.selectionEnd,
      backward: element.selectionDirection === "backward",
    };
  }

  function editKey(element, pressed) {
    editable(element);
    const range = selection(element);
    let start = range.start;
    let end = range.end;
    let text = pressed;
    let inputType = "insertText";
    if (pressed === "Backspace" || pressed === "Delete") {
      text = "";
      inputType =
        pressed === "Backspace"
          ? "deleteContentBackward"
          : "deleteContentForward";
      if (start === end) {
        if (pressed === "Backspace") start = adjacent(element.value, start, -1);
        else end = adjacent(element.value, end, 1);
      }
    } else if (pressed === "Enter") {
      text = "\n";
      inputType = "insertLineBreak";
    }
    return replaceControl(element, start, end, text, inputType);
  }

  function moveCaret(element, pressed, shift) {
    const range = selection(element);
    const text = element.value;
    const anchor = range.backward ? range.end : range.start;
    const focus = range.backward ? range.start : range.end;
    const lineStart = focus === 0 ? 0 : text.lastIndexOf("\n", focus - 1) + 1;
    const newline = text.indexOf("\n", focus);
    const lineEnd = newline < 0 ? text.length : newline;
    let next;
    if (pressed === "ArrowLeft")
      next =
        !shift && range.start !== range.end
          ? range.start
          : adjacent(text, focus, -1);
    else if (pressed === "ArrowRight")
      next =
        !shift && range.start !== range.end
          ? range.end
          : adjacent(text, focus, 1);
    else if (pressed === "Home")
      next = element instanceof HTMLTextAreaElement ? lineStart : 0;
    else if (pressed === "End")
      next = element instanceof HTMLTextAreaElement ? lineEnd : text.length;
    else if (pressed === "ArrowUp") {
      const previousEnd = lineStart - 1;
      const previousStart =
        previousEnd <= 0 ? 0 : text.lastIndexOf("\n", previousEnd - 1) + 1;
      next =
        previousEnd < 0
          ? 0
          : Math.min(previousStart + focus - lineStart, previousEnd);
    } else {
      const nextStart = lineEnd + 1;
      const nextNewline = text.indexOf("\n", nextStart);
      const nextEnd = nextNewline < 0 ? text.length : nextNewline;
      next =
        nextStart > text.length
          ? text.length
          : Math.min(nextStart + focus - lineStart, nextEnd);
    }
    const safeNext = boundaries(text).findLast((point) => point <= next) ?? 0;
    const start = shift ? Math.min(anchor, safeNext) : safeNext;
    const end = shift ? Math.max(anchor, safeNext) : safeNext;
    element.setSelectionRange(
      start,
      end,
      shift && safeNext < anchor ? "backward" : "forward",
    );
    return true;
  }

  function tab(element, reverse) {
    const selector =
      "a[href],area[href],input,textarea,button,select,iframe,[tabindex],[contenteditable]";
    const elements = Array.from(document.querySelectorAll(selector))
      .filter(
        (candidate) =>
          candidate.tabIndex >= 0 && visible(candidate) && enabled(candidate),
      )
      .sort((left, right) => {
        const leftIndex = left.tabIndex > 0 ? left.tabIndex : Infinity;
        const rightIndex = right.tabIndex > 0 ? right.tabIndex : Infinity;
        return leftIndex - rightIndex;
      });
    if (elements.length === 0) fail("The page has no focusable element.");
    const current = elements.indexOf(element);
    const next = reverse
      ? current < 0
        ? elements.length - 1
        : (current - 1 + elements.length) % elements.length
      : (current + 1) % elements.length;
    elements[next].focus();
    return true;
  }

  function enter(element) {
    if (element instanceof HTMLTextAreaElement)
      return editKey(element, "Enter");
    if (
      element instanceof HTMLInputElement &&
      textInputTypes.has(element.type) &&
      element.form
    ) {
      const submitter = Array.from(
        document.querySelectorAll("button,input"),
      ).find(
        (control) =>
          control.form === element.form &&
          ((control instanceof HTMLButtonElement &&
            control.type === "submit") ||
            (control instanceof HTMLInputElement &&
              ["submit", "image"].includes(control.type))),
      );
      if (submitter) {
        if (!enabled(submitter))
          fail(
            "The default submit button is disabled or inert. Enter did not submit the form.",
          );
        element.form.requestSubmit(submitter);
      } else {
        const blockingTypes = new Set([
          "text",
          "search",
          "url",
          "tel",
          "email",
          "password",
          "date",
          "month",
          "week",
          "time",
          "datetime-local",
          "number",
        ]);
        const blockingInputs = Array.from(element.form.elements).filter(
          (control) =>
            control instanceof HTMLInputElement &&
            blockingTypes.has(control.type),
        );
        if (blockingInputs.length > 1)
          fail(
            "Enter cannot implicitly submit this form without a submit button. Use an explicit page action.",
          );
        element.form.requestSubmit();
      }
      return true;
    }
    if (
      element instanceof HTMLButtonElement ||
      element instanceof HTMLAnchorElement ||
      (element instanceof HTMLInputElement &&
        ["button", "submit", "reset"].includes(element.type)) ||
      element.tagName.toLowerCase() === "summary"
    ) {
      activate(element);
      return true;
    }
    fail(
      "Enter default supports forms, buttons, links and textareas. Other controls receive page key handlers only; use preview_click or preview_evaluate.",
    );
  }

  function keyCode(pressed) {
    if (/^[a-z]$/i.test(pressed)) return `Key${pressed.toUpperCase()}`;
    if (/^[0-9]$/.test(pressed)) return `Digit${pressed}`;
    return pressed === " " ? "Space" : pressed;
  }

  function press() {
    const element =
      target(args, { optional: true }) ??
      document.activeElement ??
      document.body;
    if (!element || !visible(element) || !enabled(element))
      fail("The active target is hidden, disabled or inert.");
    const modifiers = new Set(args.modifiers ?? []);
    const event = {
      key: args.key,
      code: keyCode(args.key),
      bubbles: true,
      cancelable: true,
      composed: true,
      altKey: modifiers.has("Alt"),
      ctrlKey: modifiers.has("Control"),
      metaKey: modifiers.has("Meta"),
      shiftKey: modifiers.has("Shift"),
    };
    prepare(element);
    const accepted = element.dispatchEvent(new KeyboardEvent("keydown", event));
    const handlerOnly =
      event.altKey || event.ctrlKey || event.metaKey || args.key === "Escape";
    let defaultApplied = false;
    try {
      if (accepted && !handlerOnly) {
        if (args.key === "Enter") defaultApplied = enter(element);
        else if (args.key === "Tab")
          defaultApplied = tab(element, event.shiftKey);
        else if (
          [
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
            "Home",
            "End",
          ].includes(args.key)
        ) {
          defaultApplied = moveCaret(element, args.key, event.shiftKey);
        } else if (
          ["Backspace", "Delete"].includes(args.key) ||
          (args.key.length > 0 && boundaries(args.key).length === 2)
        ) {
          defaultApplied = editKey(element, args.key);
        } else {
          fail(
            "Unsupported key default. Modifiers run page handlers only; use preview_type, preview_click or preview_evaluate for this action.",
          );
        }
      }
    } finally {
      (document.activeElement ?? element).dispatchEvent(
        new KeyboardEvent("keyup", event),
      );
    }
    return {
      url: utf8Prefix(location.href, 4096),
      key: args.key,
      defaultApplied,
      defaultPrevented:
        !accepted || (accepted && !handlerOnly && !defaultApplied),
      handlerOnly,
      trusted: false,
      activeElement: document.activeElement
        ? describe(document.activeElement)
        : null,
    };
  }

  function scroll() {
    const element = target(args, { optional: true });
    const left = args.deltaX ?? 0;
    const top = args.deltaY ?? 0;
    if (element) {
      element.scrollBy({ left, top, behavior: "instant" });
      return { x: element.scrollLeft, y: element.scrollTop };
    }
    window.scrollBy({ left, top, behavior: "instant" });
    return { x: scrollX, y: scrollY };
  }

  function evaluate() {
    const value = (0, eval)(args.expression);
    if (value != null && typeof value.then === "function") {
      fail(
        "Promise and thenable results are unsupported. Evaluate synchronously or use preview_wait_for.",
      );
    }
    let serialized;
    try {
      serialized = JSON.stringify(value === undefined ? null : value);
    } catch {
      fail(
        "Expression result is not JSON serializable. Return a value without cycles or BigInt.",
      );
    }
    if (serialized === undefined)
      fail("Expression result is not JSON serializable.");
    if (encoder.encode(serialized).length > 65536)
      fail("Expression result exceeds 64 KB. Return a smaller value.");
    return { value: JSON.parse(serialized) };
  }

  function waitFor() {
    const element = target(args, { optional: true, waiting: true });
    const suppliedTarget =
      args.ref !== undefined || args.selector !== undefined;
    const matchesTarget = !suppliedTarget || element !== null;
    const text = element
      ? (element.innerText ?? element.textContent ?? "")
      : (document.body?.innerText ?? "");
    return {
      matched:
        matchesTarget &&
        (args.text === undefined || text.includes(args.text)) &&
        (args.urlIncludes === undefined ||
          location.href.includes(args.urlIncludes)),
      url: utf8Prefix(location.href, 4096),
    };
  }

  try {
    const operations = {
      snapshot,
      click,
      type,
      press,
      scroll,
      evaluate,
      wait_for: waitFor,
      status,
    };
    const operation = operations[request.operation];
    if (!Object.hasOwn(operations, request.operation))
      fail("Unsupported preview operation.");
    return { ok: true, value: operation() };
  } catch (error) {
    let message = "Preview operation failed.";
    try {
      message = clean(error?.message ?? error, 512);
    } catch {}
    return {
      ok: false,
      error: message,
    };
  }
}
