// Error notification adapted from T3 Code v0.0.45 apps/web/src/components/ui/toast.tsx (MIT).
import { useState } from "react";
import { useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { Toast, ToastViewport } from "../ui/toast";
import { useKeybindings } from "./store";

export function KeybindingErrors() {
  const bindings = useKeybindings();
  const navigate = useNavigate();
  const search = useSearch({ from: "__root__" });
  const pathname = useLocation({ select: (location) => location.pathname });
  const [dismissed, setDismissed] = useState<string | null>(null);
  const messages = [
    bindings.error,
    ...bindings.issues.map((issue) => issue.message),
  ]
    .filter(Boolean)
    .join("\n");
  const fingerprint = `${bindings.text}\n${messages}`;
  if (
    !messages ||
    dismissed === fingerprint ||
    pathname === "/settings/keybindings"
  )
    return null;
  return (
    <ToastViewport>
      <Toast
        type="error"
        title="Keybindings need attention"
        description={messages}
        onDismiss={() => setDismissed(fingerprint)}
        action={{
          label: "Open keyboard shortcuts",
          onClick: () => {
            void navigate({
              to: "/settings/$section",
              params: { section: "keybindings" },
              search,
            });
          },
        }}
      />
    </ToastViewport>
  );
}
