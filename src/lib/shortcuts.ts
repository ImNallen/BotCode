import { shortcutLabel } from "./actions";
export { matchesAction, matchAction, shortcutLabel } from "./actions";
export const newWithoutProjectShortcut = shortcutLabel("thread.scratch");
export const settleThreadShortcut = shortcutLabel("thread.settle");
export const pinThreadShortcut = shortcutLabel("thread.pin");
export const terminalToggleShortcut = shortcutLabel("terminal.toggle");
export const terminalSplitShortcut = shortcutLabel("terminal.split");
export const terminalSplitVerticalShortcut = shortcutLabel(
  "terminal.splitVertical",
);
export const terminalNewShortcut = shortcutLabel("terminal.new");
export const terminalCloseShortcut = shortcutLabel("terminal.close");
