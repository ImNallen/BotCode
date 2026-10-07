import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

export function mockIpc(
  handler: (command: string, args: unknown) => unknown,
): () => void {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: Object.assign(new EventTarget(), { crypto: globalThis.crypto }),
  });
  mockIPC(handler);
  return () => {
    clearMocks();
    if (previousWindow)
      Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  };
}
