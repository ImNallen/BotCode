// Optimistic file overlay copied from pingdotgg/t3code v0.0.45 components/files/projectFilesQueryState.ts,
// with the pending file set from components/ChatView.tsx (MIT).
import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { checkoutKey, ipc, type CheckoutRef } from "../ipc";

/** An in-app write to the file, overlaying the read query until a read after the write succeeds. */
export type FileDraft = {
  readonly contents: string;
  readonly confirmed: boolean;
};

const NO_PENDING_FILES: ReadonlySet<string> = new Set();
const drafts = new Map<string, FileDraft>();
const pendingFiles = new Map<string, ReadonlySet<string>>();
const listeners = new Set<() => void>();

const checkoutId = ({ workspaceId, threadId }: CheckoutRef) =>
  JSON.stringify([workspaceId, threadId ?? null]);
const draftId = (checkout: CheckoutRef, path: string) =>
  JSON.stringify([checkoutId(checkout), path]);

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function putDraft(id: string, draft: FileDraft | null) {
  if (draft) drafts.set(id, draft);
  else drafts.delete(id);
  for (const listener of listeners) listener();
}

export const fileQuery = (checkout: CheckoutRef, path: string) =>
  queryOptions({
    queryKey: [...checkoutKey("file", checkout), path],
    queryFn: () => ipc.file(checkout, path),
  });

export const readFileDraft = (checkout: CheckoutRef, path: string) =>
  drafts.get(draftId(checkout, path));

export function useFileDraft(checkout: CheckoutRef, path: string) {
  return useSyncExternalStore(subscribe, () => readFileDraft(checkout, path));
}

export function setFileDraft(
  checkout: CheckoutRef,
  path: string,
  contents: string,
): void {
  putDraft(draftId(checkout, path), { contents, confirmed: false });
}

export function confirmFileDraft(
  client: QueryClient,
  checkout: CheckoutRef,
  path: string,
  contents: string,
): boolean {
  const id = draftId(checkout, path);
  if (drafts.get(id)?.contents !== contents) return false;

  const confirmed: FileDraft = { contents, confirmed: true };
  putDraft(id, confirmed);
  void client.invalidateQueries({
    queryKey: checkoutKey("workspace", checkout),
  });
  void client.invalidateQueries({ queryKey: checkoutKey("diff", checkout) });
  const query = fileQuery(checkout, path);
  // A read already in flight may have started before the write landed.
  void client
    .cancelQueries({ queryKey: query.queryKey, exact: true })
    .then(() => client.fetchQuery({ ...query, staleTime: 0 }))
    .then(
      () => {
        if (drafts.get(id) === confirmed) putDraft(id, null);
      },
      () => {},
    );
  return true;
}

export const readPendingFiles = (checkout: CheckoutRef) =>
  pendingFiles.get(checkoutId(checkout)) ?? NO_PENDING_FILES;

export function usePendingFiles(checkout: CheckoutRef) {
  return useSyncExternalStore(subscribe, () => readPendingFiles(checkout));
}

export function setFilePending(
  checkout: CheckoutRef,
  path: string,
  pending: boolean,
): void {
  const id = checkoutId(checkout);
  const current = readPendingFiles(checkout);
  if (current.has(path) === pending) return;
  const next = new Set(current);
  if (pending) next.add(path);
  else next.delete(path);
  if (next.size > 0) pendingFiles.set(id, next);
  else pendingFiles.delete(id);
  for (const listener of listeners) listener();
}
