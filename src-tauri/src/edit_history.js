function (command) {
  if (!document.hasFocus()) return;
  let target = document.activeElement;
  while (target?.shadowRoot?.activeElement)
    target = target.shadowRoot.activeElement;
  const redo = command === "redo";
  const keydown = new KeyboardEvent("keydown", {
    key: redo ? "Z" : "z",
    code: "KeyZ",
    keyCode: 90,
    metaKey: true,
    shiftKey: redo,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  if ((target ?? document.body).dispatchEvent(keydown))
    document.execCommand(command);
}
