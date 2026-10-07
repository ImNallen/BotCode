// Ported from T3 Code v0.0.45 packages/shared/src/composerContextClipboard.ts (MIT).
import { z } from "zod";
import {
  importContext,
  messageContext,
  type ComposerContent,
} from "./composerContext";

const mime = "application/x-t3-context-fragment+json";
const fragmentSchema = messageContext.and(
  z.object({ text: z.string().max(16_000_000) }),
);
export function encodeContextClipboard(content: ComposerContent) {
  const records = [
    ...new Map(content.records.map((r) => [r.contextId, r])).values(),
  ];
  const fragment = JSON.stringify({ version: 1, text: content.text, records });
  const escaped = content.text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return {
    text: content.text,
    fragment,
    html: `<pre data-t3-context-fragment="${encodeURIComponent(fragment)}">${escaped}</pre>`,
  };
}
export function writeContextClipboard(
  clipboard: Pick<DataTransfer, "setData">,
  content: ComposerContent,
) {
  const encoded = encodeContextClipboard(content);
  clipboard.setData("text/plain", encoded.text);
  clipboard.setData("text/html", encoded.html);
  clipboard.setData(mime, encoded.fragment);
}
export async function copyContextContent(
  content: ComposerContent,
): Promise<void> {
  const active = document.activeElement;
  const selection = window.getSelection();
  const anchorNode = selection?.anchorNode;
  const anchorOffset = selection?.anchorOffset ?? 0;
  const focusNode = selection?.focusNode;
  const focusOffset = selection?.focusOffset ?? 0;
  const source = document.createElement("textarea");
  source.value = content.text;
  source.readOnly = true;
  source.style.position = "fixed";
  source.style.left = "-9999px";
  let written = false;
  const copy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    writeContextClipboard(event.clipboardData, content);
    event.preventDefault();
    event.stopImmediatePropagation();
    written = true;
  };
  document.body.append(source);
  document.addEventListener("copy", copy, true);
  try {
    source.focus({ preventScroll: true });
    source.select();
    // WebKit sanitizes payload attributes through ClipboardItem, but retains copy-event flavors.
    if (!document.execCommand("copy") || !written)
      throw new Error("Unable to copy context chips.");
  } finally {
    document.removeEventListener("copy", copy, true);
    source.remove();
    if (active instanceof HTMLElement) active.focus({ preventScroll: true });
    selection?.removeAllRanges();
    if (selection && anchorNode && focusNode)
      selection.setBaseAndExtent(
        anchorNode,
        anchorOffset,
        focusNode,
        focusOffset,
      );
  }
}
export function readContextClipboard(
  clipboard: Pick<DataTransfer, "getData">,
): ComposerContent | null {
  const raw = clipboard.getData(mime) || clipboard.getData("web " + mime);
  const html = clipboard.getData("text/html");
  const boundedHtml = html.length <= 16_000_000 * 9 + 4096 ? html : "";
  const attribute = /data-t3-context-fragment=["']([^"']+)["']/.exec(
    boundedHtml,
  )?.[1];
  try {
    const source =
      (raw.length <= 16_000_000 ? raw : "") ||
      (attribute ? decodeURIComponent(attribute) : "");
    if (source && source.length <= 16_000_000) {
      const result = fragmentSchema.safeParse(JSON.parse(source));
      if (result.success) return importContext(result.data);
    }
  } catch {}
  const text = clipboard.getData("text/plain");
  return text ? { text, records: [] } : null;
}
