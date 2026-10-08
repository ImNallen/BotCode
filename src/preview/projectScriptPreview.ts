// Adapted from T3 Code v0.0.45 apps/web/src/components/ChatView.tsx project-script preview opening (MIT).
import type { ProjectScript } from "../ipc";
import {
  normalizePreviewUrl,
  previewScopeKey,
  type PreviewScope,
} from "./model";

export async function openProjectScriptPreview({
  script,
  scope,
  currentScope,
  open,
}: {
  script: Pick<ProjectScript, "previewUrl" | "autoOpenPreview">;
  scope: PreviewScope;
  currentScope: () => PreviewScope | null;
  open: (scope: PreviewScope, url: string) => Promise<unknown>;
}): Promise<void> {
  if (!script.autoOpenPreview || !script.previewUrl) return;
  const current = () => {
    const selected = currentScope();
    return (
      selected !== null && previewScopeKey(selected) === previewScopeKey(scope)
    );
  };
  if (!current()) return;
  await open(scope, normalizePreviewUrl(script.previewUrl));
}
