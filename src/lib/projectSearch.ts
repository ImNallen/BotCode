// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/files/projectFilesQueryState.ts and state/queries.ts (MIT).
import { useEffect, useRef, useState } from "react";
import {
  ipc,
  IpcError,
  type CheckoutRef,
  type ContentSearchInput,
  type ContentSearchResult,
  type PathSearchResult,
} from "../ipc";

export type ProjectSearchRequest =
  | { kind: "paths"; query: string; limit: number; imageOnly?: boolean }
  | ({ kind: "content" } & ContentSearchInput);
export type ProjectSearchResponse =
  | { kind: "paths"; value: PathSearchResult }
  | { kind: "content"; value: ContentSearchResult };
export type SearchState =
  | { kind: "ready"; key: string; response: ProjectSearchResponse }
  | { kind: "error"; key: string; message: string }
  | { kind: "idle" };

export function searchRequestKey(
  checkout: CheckoutRef | undefined,
  request: ProjectSearchRequest | null,
  revision = 0,
) {
  return JSON.stringify([
    checkout?.workspaceId,
    checkout?.threadId,
    request,
    revision,
  ]);
}
export function currentSearchResponse(
  state: SearchState,
  key: string,
): ProjectSearchResponse | null {
  return state.kind === "ready" && state.key === key ? state.response : null;
}
export function useProjectSearch(
  checkout: CheckoutRef | undefined,
  request: ProjectSearchRequest | null,
) {
  const [caller] = useState(() => crypto.randomUUID());
  const sequence = useRef(0);
  const dispatchedRevision = useRef(0);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<SearchState>({ kind: "idle" });
  const key = searchRequestKey(checkout, request, revision);
  useEffect(() => {
    if (!checkout || !request) return;
    const ticket = ++sequence.current;
    let active = true;
    const timer = window.setTimeout(
      () => {
        const refresh = dispatchedRevision.current < revision;
        dispatchedRevision.current = revision;
        const promise =
          request.kind === "paths"
            ? ipc
                .searchPaths(checkout, caller, ticket, {
                  query: request.query,
                  limit: request.limit,
                  refresh,
                  imageOnly: request.imageOnly ?? false,
                })
                .then(
                  (value): ProjectSearchResponse => ({ kind: "paths", value }),
                )
            : ipc
                .searchContents(checkout, caller, ticket, {
                  ...request,
                  refresh,
                })
                .then(
                  (value): ProjectSearchResponse => ({
                    kind: "content",
                    value,
                  }),
                );
        void promise
          .then((response) => {
            if (active) setState({ kind: "ready", key, response });
          })
          .catch((error: unknown) => {
            if (
              active &&
              error instanceof IpcError &&
              error.code === "search_cancelled"
            ) {
              setRevision((value) => value + 1);
              return;
            }
            if (active)
              setState({
                kind: "error",
                key,
                message: error instanceof Error ? error.message : String(error),
              });
          });
      },
      request.kind === "paths" ? 100 : 180,
    );
    return () => {
      active = false;
      window.clearTimeout(timer);
      void ipc.cancelProjectSearch(caller, ticket).catch(() => {});
    };
  }, [key, caller]);
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  const response = currentSearchResponse(state, key);
  const error =
    state.kind === "error" && state.key === key ? state.message : null;
  return {
    response,
    pending: !!checkout && !!request && !response && !error,
    error,
    refresh: () => setRevision((value) => value + 1),
  };
}
