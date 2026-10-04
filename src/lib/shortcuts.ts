const mac = /Mac/.test(navigator.userAgent);

export const newWithoutProjectShortcut = mac ? "⌥⌘N" : "Ctrl+Alt+N";
export const settleThreadShortcut = mac ? "⇧⌘S" : "Ctrl+Shift+S";
