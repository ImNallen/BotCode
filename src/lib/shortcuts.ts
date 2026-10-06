const mac = /Mac/.test(navigator.userAgent);

export const newWithoutProjectShortcut = mac ? "⌥⌘N" : "Ctrl+Alt+N";
export const settleThreadShortcut = mac ? "⇧⌘S" : "Ctrl+Shift+S";
export const pinThreadShortcut = mac ? "⇧⌘P" : "Ctrl+Shift+P";
export const terminalToggleShortcut = mac ? "⌘J" : "Ctrl+J";
export const terminalSplitShortcut = mac ? "⌘D" : "Ctrl+D";
export const terminalSplitVerticalShortcut = mac ? "⇧⌘D" : "Ctrl+Shift+D";
export const terminalNewShortcut = mac ? "⌘N" : "Ctrl+N";
export const terminalCloseShortcut = mac ? "⌘W" : "Ctrl+W";
