// Ported from pingdotgg/t3code v0.0.45 apps/web/src/keybindings.ts (MIT).
import { shortcutLabel, type ActionId } from "./actions";
import { useKeybindings } from "../keybindings/store";
export {
  matchesAction,
  matchAction,
  shortcutLabel,
  resolveCommand,
} from "./actions";
export function useShortcutLabel(id: ActionId) {
  useKeybindings();
  return shortcutLabel(id);
}
