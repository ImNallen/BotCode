const assert = {
  equal(actual, expected, message = "Values differ") {
    if (!Object.is(actual, expected))
      throw new Error(
        `${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
      );
  },
  deepEqual(actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `Values differ: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
      );
    }
  },
  match(actual, pattern) {
    if (!pattern.test(actual))
      throw new Error(`Expected ${JSON.stringify(actual)} to match ${pattern}`);
  },
};

const source = await (await fetch("./automation.js")).text();
const automate = (0, eval)(`(${source})`);
const fixture = document.querySelector("#fixture");
const cases = [];
let snapshotNumber = 0;
const key = "__botcode_preview_behavior_fixture";

function call(operation, args = {}) {
  return automate({ operation, key, args });
}

function success(operation, args = {}) {
  const result = call(operation, args);
  assert.equal(result.ok, true, result.error);
  return result.value;
}

function error(operation, args, pattern) {
  const result = call(operation, args);
  assert.equal(result.ok, false, `${operation} should refuse this request`);
  assert.match(result.error, pattern);
}

function snapshot() {
  return success("snapshot", { snapshotId: `fixture-${++snapshotNumber}` });
}

function reset() {
  window.scrollTo({ left: 0, top: 0, behavior: "instant" });
  fixture.innerHTML = `
    <form id="form">
      <label for="name">Name</label><input id="name" value="initial" />
      <label for="other">Other</label><input id="other" value="second" />
      <label for="password">Password</label><input id="password" type="password" value="secret-password-value" />
      <button id="apply" type="button">Apply name</button>
      <button id="submit" type="submit">Submit name</button>
    </form>
    <label for="textarea">Notes</label><textarea id="textarea">first\nsecond</textarea>
    <div id="editor" contenteditable="true" aria-label="Editor">initial edit</div>
    <input id="readonly" aria-label="Read only" readonly value="locked" />
    <input id="number" aria-label="Number" type="number" value="42" />
    <button id="disabled" disabled>Disabled</button>
    <button id="hidden" style="display: none">Hidden</button>
    <div inert><button id="inert">Inert</button></div>
    <div id="scroll-box"><div id="scroll-content">Scrollable content</div></div>
    <p id="result" role="status">Ready</p>
  `;
  window.fixtureClicks = 0;
  window.fixtureSubmissions = 0;
  document.querySelector("#apply").addEventListener("click", () => {
    window.fixtureClicks++;
    document.querySelector("#result").textContent =
      `Applied ${document.querySelector("#name").value}`;
  });
  document.querySelector("#form").addEventListener("submit", (event) => {
    event.preventDefault();
    window.fixtureSubmissions++;
    window.fixtureSubmitter = event.submitter?.id ?? null;
    document.querySelector("#result").textContent =
      `Submitted ${document.querySelector("#name").value}`;
  });
}

async function test(name, check) {
  reset();
  try {
    await check();
    cases.push({ name, passed: true });
  } catch (failure) {
    cases.push({
      name,
      passed: false,
      error: String(failure.message ?? failure),
    });
  }
}

await test("Snapshot refs type and click the visible form", () => {
  const page = snapshot();
  const name = page.elements.find((element) => element.name === "Name");
  const apply = page.elements.find((element) => element.name === "Apply name");
  success("type", { ref: name.ref, text: "Codex preview", clear: true });
  success("click", { ref: apply.ref });
  assert.equal(
    document.querySelector("#result").textContent,
    "Applied Codex preview",
  );
  assert.equal(window.fixtureClicks, 1);
  assert.equal(page.url, location.href);
});

await test("Old and detached refs refuse replacement nodes", () => {
  const first = snapshot().elements.find(
    (element) => element.name === "Name",
  ).ref;
  snapshot();
  error("type", { ref: first, text: "wrong" }, /stale/i);
  const current = snapshot().elements.find(
    (element) => element.name === "Name",
  ).ref;
  document.querySelector("#name").outerHTML =
    '<input id="name" aria-label="Replacement" value="replacement" />';
  error("type", { ref: current, text: "wrong" }, /stale/i);
  success("type", { selector: "#name", text: "correct", clear: true });
  assert.equal(document.querySelector("#name").value, "correct");
});

await test("Ambiguous, hidden, disabled and inert targets refuse interaction", () => {
  error("click", { selector: "button" }, /several/i);
  error("click", { selector: "#hidden" }, /hidden/i);
  error("click", { selector: "#disabled" }, /disabled/i);
  error("click", { selector: "#inert" }, /inert/i);
  error("click", { selector: "[" }, /invalid css/i);
  success("click", { selector: "#apply" });
  assert.equal(window.fixtureClicks, 1);
});

await test("Password values stay out of semantic snapshots", () => {
  const page = snapshot();
  const password = page.elements.find((element) => element.name === "Password");
  assert.equal(password.type, "password");
  assert.equal(Object.hasOwn(password, "value"), false);
  assert.equal(JSON.stringify(page).includes("secret-password-value"), false);
  success("type", {
    selector: "#password",
    text: "another-secret",
    clear: true,
  });
  assert.equal(document.querySelector("#password").value, "another-secret");
  assert.equal(JSON.stringify(snapshot()).includes("another-secret"), false);
});

await test("Native text setter inserts literal selection text and emits events", () => {
  const element = document.querySelector("#name");
  element.value = "abcdef";
  element.focus();
  element.setSelectionRange(2, 5);
  const events = [];
  for (const type of ["beforeinput", "input", "change"]) {
    element.addEventListener(type, (event) =>
      events.push([event.type, event.isTrusted]),
    );
  }
  success("type", { selector: "#name", text: "<b>X</b>" });
  assert.equal(element.value, "ab<b>X</b>f");
  assert.deepEqual(events, [
    ["beforeinput", false],
    ["input", false],
    ["change", false],
  ]);
  assert.equal(element.selectionStart, 10);
});

await test("Canceled beforeinput and read-only controls preserve their values", () => {
  const element = document.querySelector("#name");
  const cancel = (event) => event.preventDefault();
  element.addEventListener("beforeinput", cancel);
  error(
    "type",
    { selector: "#name", text: "changed", clear: true },
    /canceled beforeinput/i,
  );
  assert.equal(element.value, "initial");
  element.removeEventListener("beforeinput", cancel);
  success("type", { selector: "#name", text: "changed", clear: true });
  assert.equal(element.value, "changed");
  error("type", { selector: "#readonly", text: "wrong" }, /read.only/i);
  assert.equal(document.querySelector("#readonly").value, "locked");
  success("press", { selector: "#readonly", key: "Home" });
  assert.equal(document.querySelector("#readonly").selectionStart, 0);
  error("press", { selector: "#readonly", key: "Delete" }, /read.only/i);
  assert.equal(document.querySelector("#readonly").value, "locked");
  error(
    "type",
    { selector: "#number", text: "wrong" },
    /does not support text/i,
  );
  assert.equal(document.querySelector("#number").value, "42");
});

await test("Contenteditable clear inserts text rather than HTML", () => {
  const editor = document.querySelector("#editor");
  success("type", { selector: "#editor", text: "<b>literal</b>", clear: true });
  assert.equal(editor.innerText, "<b>literal</b>");
  assert.equal(editor.querySelector("b"), null);
  success("type", { selector: "#editor", text: " appended" });
  assert.equal(editor.innerText, "<b>literal</b> appended");
});

await test("Enter submits through the form with its submitter", () => {
  success("type", { selector: "#name", text: "submitted", clear: true });
  const result = success("press", { selector: "#name", key: "Enter" });
  assert.equal(result.defaultApplied, true);
  assert.equal(window.fixtureSubmissions, 1);
  assert.equal(window.fixtureSubmitter, "submit");
  assert.equal(
    document.querySelector("#result").textContent,
    "Submitted submitted",
  );
});

await test("Enter refuses a disabled default submitter without skipping it", () => {
  const first = document.querySelector("#submit");
  first.disabled = true;
  first.insertAdjacentHTML(
    "afterend",
    '<button id="later" type="submit">Later submitter</button>',
  );
  error(
    "press",
    { selector: "#name", key: "Enter" },
    /default submit button.*disabled/i,
  );
  assert.equal(window.fixtureSubmissions, 0);
  first.disabled = false;
  success("press", { selector: "#name", key: "Enter" });
  assert.equal(window.fixtureSubmissions, 1);
  assert.equal(window.fixtureSubmitter, "submit");
});

await test("Enter without a submitter refuses multiple blocking inputs", () => {
  document.querySelector("#submit").remove();
  error(
    "press",
    { selector: "#name", key: "Enter" },
    /without a submit button/i,
  );
  assert.equal(window.fixtureSubmissions, 0);
  document.querySelector("#other").remove();
  document.querySelector("#password").remove();
  success("press", { selector: "#name", key: "Enter" });
  assert.equal(window.fixtureSubmissions, 1);
  assert.equal(window.fixtureSubmitter, null);
});

await test("Prevented keyboard defaults still emit untrusted keyup", () => {
  const element = document.querySelector("#name");
  const events = [];
  element.addEventListener("keydown", (event) => {
    events.push([event.type, event.isTrusted]);
    event.preventDefault();
  });
  element.addEventListener("keyup", (event) =>
    events.push([event.type, event.isTrusted]),
  );
  const result = success("press", { selector: "#name", key: "Backspace" });
  assert.equal(result.defaultPrevented, true);
  assert.equal(element.value, "initial");
  assert.deepEqual(events, [
    ["keydown", false],
    ["keyup", false],
  ]);
});

await test("Tab and Shift+Tab move focus through page controls", () => {
  success("press", { selector: "#name", key: "Tab" });
  assert.equal(document.activeElement.id, "other");
  success("press", { key: "Tab", modifiers: ["Shift"] });
  assert.equal(document.activeElement.id, "name");
});

await test("Backspace and Delete remove whole graphemes", () => {
  const element = document.querySelector("#name");
  const family = "👨‍👩‍👧‍👦";
  success("type", { selector: "#name", text: `a${family}b`, clear: true });
  element.setSelectionRange(1 + family.length, 1 + family.length);
  success("press", { selector: "#name", key: "Backspace" });
  assert.equal(element.value, "ab");
  success("type", { selector: "#name", text: `a${family}b`, clear: true });
  element.setSelectionRange(1, 1);
  success("press", { selector: "#name", key: "Delete" });
  assert.equal(element.value, "ab");
});

await test("Caret selection and literal character defaults edit inputs", () => {
  const element = document.querySelector("#name");
  success("type", { selector: "#name", text: "abcd", clear: true });
  element.setSelectionRange(3, 3);
  success("press", {
    selector: "#name",
    key: "ArrowLeft",
    modifiers: ["Shift"],
  });
  assert.deepEqual([element.selectionStart, element.selectionEnd], [2, 3]);
  success("press", { selector: "#name", key: "x" });
  assert.equal(element.value, "abxd");
  success("press", { selector: "#name", key: "Home" });
  assert.equal(element.selectionStart, 0);
  success("press", { selector: "#name", key: "End" });
  assert.equal(element.selectionStart, 4);
});

await test("Textarea caret movement and Enter honor logical lines", () => {
  const element = document.querySelector("#textarea");
  success("type", {
    selector: "#textarea",
    text: "first\nsecond",
    clear: true,
  });
  element.setSelectionRange(8, 8);
  success("press", { selector: "#textarea", key: "ArrowUp" });
  assert.equal(element.selectionStart, 2);
  success("press", { selector: "#textarea", key: "ArrowDown" });
  assert.equal(element.selectionStart, 8);
  success("press", { selector: "#textarea", key: "Home" });
  assert.equal(element.selectionStart, 6);
  success("press", { selector: "#textarea", key: "Enter" });
  assert.equal(element.value, "first\n\nsecond");
  success("type", { selector: "#textarea", text: "\nfirst", clear: true });
  element.setSelectionRange(0, 0);
  success("press", { selector: "#textarea", key: "Home" });
  assert.equal(element.selectionStart, 0);
});

await test("Modified keys run page handlers without OS shortcuts", () => {
  const element = document.querySelector("#name");
  const events = [];
  element.addEventListener("keydown", (event) =>
    events.push([event.key, event.metaKey, event.isTrusted]),
  );
  const result = success("press", {
    selector: "#name",
    key: "a",
    modifiers: ["Meta"],
  });
  assert.equal(result.handlerOnly, true);
  assert.equal(result.defaultApplied, false);
  assert.equal(element.value, "initial");
  assert.deepEqual(events, [["a", true, false]]);
  success("press", { selector: "#name", key: "Escape" });
  error("press", { selector: "#name", key: "F12" }, /unsupported key default/i);
});

await test("Scroll reports actual element and page positions", () => {
  const box = success("scroll", {
    selector: "#scroll-box",
    deltaX: 20,
    deltaY: 50,
  });
  const element = document.querySelector("#scroll-box");
  assert.deepEqual(box, { x: element.scrollLeft, y: element.scrollTop });
  assert.equal(box.x > 0 && box.x <= 20, true);
  assert.equal(box.y > 0 && box.y <= 50, true);
  const page = success("scroll", { deltaY: 200 });
  assert.deepEqual(page, { x: window.scrollX, y: window.scrollY });
  assert.equal(page.x, 0);
  assert.equal(page.y > 0 && page.y <= 200, true);
});

await test("Wait conditions all match and stale refs fail immediately", () => {
  const ref = snapshot().elements.find(
    (element) => element.name === "Ready",
  ).ref;
  const ready = success("wait_for", {
    ref,
    text: "Ready",
    urlIncludes: "automation.fixture.html",
  });
  assert.equal(ready.matched, true);
  assert.equal(
    success("wait_for", { selector: "#missing", text: "Ready" }).matched,
    false,
  );
  assert.equal(success("wait_for", { selector: "#hidden" }).matched, false);
  assert.equal(
    success("wait_for", { ref, text: "not present" }).matched,
    false,
  );
  snapshot();
  error("wait_for", { ref }, /stale/i);
});

await test("Text waits handle inputs and SVG text without throwing", () => {
  assert.equal(
    success("wait_for", { selector: "#name", text: "initial" }).matched,
    false,
  );
  fixture.insertAdjacentHTML(
    "beforeend",
    '<svg width="160" height="40"><text id="svg-text" x="0" y="20">SVG ready</text></svg>',
  );
  assert.equal(
    success("wait_for", { selector: "#svg-text", text: "SVG ready" }).matched,
    true,
  );
});

await test("Evaluate uses page globals and rejects asynchronous or invalid results", () => {
  window.fixtureGlobal = 5;
  assert.deepEqual(success("evaluate", { expression: "fixtureGlobal + 2" }), {
    value: 7,
  });
  assert.deepEqual(success("evaluate", { expression: "undefined" }), {
    value: null,
  });
  error(
    "evaluate",
    { expression: "Promise.resolve(1)" },
    /promise.*unsupported/i,
  );
  error("evaluate", { expression: "({then() {}})" }, /thenable.*unsupported/i);
  error(
    "evaluate",
    { expression: "(() => { const x = {}; x.x = x; return x; })()" },
    /not json serializable/i,
  );
  error("evaluate", { expression: "1n" }, /bigint/i);
  error(
    "evaluate",
    { expression: "(() => { throw {toString() {throw 1}}; })()" },
    /preview operation failed/i,
  );
  error("evaluate", { expression: "'x'.repeat(66000)" }, /exceeds 64 kb/i);
  assert.equal(
    success("evaluate", { expression: "'x'.repeat(60000)" }).value.length,
    60000,
  );
});

await test("Large Unicode snapshots stay bounded and report omitted content", () => {
  const hugeText = document.createElement("p");
  hugeText.textContent = "🔥\\\u0001".repeat(12000);
  fixture.append(hugeText);
  for (let index = 0; index < 800; index++) {
    const button = document.createElement("button");
    button.textContent = `Extra ${index} ${"🔥".repeat(150)}`;
    fixture.append(button);
  }
  const page = snapshot();
  assert.equal(
    new TextEncoder().encode(JSON.stringify(page)).length <= 20000,
    true,
  );
  assert.equal(page.elements.length <= 200, true);
  assert.equal(page.omitted.elements > 0, true);
  assert.equal(page.omitted.bodyTextCharacters > 0, true);
  const first = page.elements.find((element) => element.name === "Apply name");
  success("click", { ref: first.ref });
  assert.equal(window.fixtureClicks, 1);
});

reset();
window.automationVerification = {
  passed: cases.filter((entry) => entry.passed).length,
  failed: cases.filter((entry) => !entry.passed).length,
  cases,
};
document.querySelector("#report").textContent = JSON.stringify(
  window.automationVerification,
  null,
  2,
);
document.title =
  window.automationVerification.failed === 0
    ? "Preview automation passed"
    : "Preview automation failed";
