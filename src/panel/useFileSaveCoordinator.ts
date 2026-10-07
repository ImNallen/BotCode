// Copied from pingdotgg/t3code v0.0.45 components/files/useFileSaveCoordinator.ts (MIT).
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { ipc, type CheckoutRef } from "../ipc";
import { confirmFileDraft, setFilePending } from "./fileDrafts";
import { FileSaveCoordinator } from "./fileSaveCoordinator";

const FILE_SAVE_DEBOUNCE_MS = 500;

export type FileSaveSession = {
  readonly change: (contents: string) => void;
  readonly setup: () => () => void;
};

export function createFileSaveSession(
  client: QueryClient,
  checkout: CheckoutRef,
  path: string,
): FileSaveSession {
  let current: FileSaveCoordinator | null = null;
  return {
    change: (contents) => current?.change(contents),
    setup: () => {
      const coordinator = new FileSaveCoordinator({
        debounceMs: FILE_SAVE_DEBOUNCE_MS,
        onPendingChange: (pending) => setFilePending(checkout, path, pending),
        persist: (contents) =>
          ipc.writeFile(checkout, path, contents).then(
            () => true,
            (error: unknown) => {
              console.warn("[file-save] write failed", error);
              return false;
            },
          ),
        onConfirmed: (contents) => {
          confirmFileDraft(client, checkout, path, contents);
        },
      });
      current = coordinator;
      return () => {
        current = null;
        coordinator.dispose();
      };
    },
  };
}

export function useFileSaveCoordinator(
  { workspaceId, threadId }: CheckoutRef,
  path: string,
): Pick<FileSaveSession, "change"> {
  const client = useQueryClient();
  const session = useMemo(
    () => createFileSaveSession(client, { workspaceId, threadId }, path),
    [client, workspaceId, threadId, path],
  );

  // StrictMode replays effect setup. Retired file sessions stay inert, while the
  // replay gets a fresh coordinator instead of reusing a disposed one.
  useEffect(session.setup, [session]);
  return session;
}
