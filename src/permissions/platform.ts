import { isTauri } from "@tauri-apps/api/core";
export const isMac =
  isTauri() &&
  typeof navigator !== "undefined" &&
  /Mac/.test(navigator.platform);
