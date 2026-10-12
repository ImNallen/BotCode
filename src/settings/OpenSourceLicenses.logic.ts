// State for the panel ported from T3 Code v0.0.45 apps/web/src/components/settings/OpenSourceLicenses.tsx (MIT).
import {
  decodeThirdPartyLicenseManifest,
  filterThirdPartyLicenseEntries,
  type ThirdPartyLicenseEntry,
  type ThirdPartyLicenseManifest,
} from "./thirdPartyLicenses";

export type LicenseManifestState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly manifest: ThirdPartyLicenseManifest };

export type LicensesPanelState = {
  readonly manifest: LicenseManifestState;
  readonly query: string;
  readonly searchOpen: boolean;
  readonly openEntryKey: string | null;
};

export type LicensesPanelAction =
  | { readonly type: "manifest"; readonly manifest: LicenseManifestState }
  | { readonly type: "search-opened" }
  | { readonly type: "query-changed"; readonly query: string }
  | { readonly type: "search-blurred" }
  | { readonly type: "search-escaped" }
  | {
      readonly type: "entry-open-changed";
      readonly key: string;
      readonly open: boolean;
    };

export const initialLicensesPanelState: LicensesPanelState = {
  manifest: { status: "loading" },
  query: "",
  searchOpen: false,
  openEntryKey: null,
};

export function licensesPanelReducer(
  state: LicensesPanelState,
  action: LicensesPanelAction,
): LicensesPanelState {
  switch (action.type) {
    case "manifest":
      return { ...state, manifest: action.manifest };
    case "search-opened":
      return { ...state, searchOpen: true };
    case "query-changed":
      return { ...state, query: action.query };
    case "search-blurred":
      return state.query.length === 0 ? { ...state, searchOpen: false } : state;
    case "search-escaped":
      return { ...state, query: "", searchOpen: false };
    case "entry-open-changed":
      return { ...state, openEntryKey: action.open ? action.key : null };
  }
}

export function licensesPanelView({
  manifest,
  query,
}: Pick<LicensesPanelState, "manifest" | "query">): {
  readonly entries: ReadonlyArray<ThirdPartyLicenseEntry>;
  readonly countLabel: string;
} {
  const all = manifest.status === "ready" ? manifest.manifest.entries : [];
  const entries = filterThirdPartyLicenseEntries(all, query);
  return {
    entries,
    countLabel:
      entries.length === all.length
        ? `${String(all.length)} notices`
        : `${String(entries.length)} of ${String(all.length)}`,
  };
}

export async function loadLicenseManifest(
  signal: AbortSignal,
): Promise<ThirdPartyLicenseManifest> {
  const response = await fetch("/third-party-licenses.json", { signal });
  if (!response.ok) {
    throw new Error(
      `The license manifest request failed with status ${String(response.status)}.`,
    );
  }
  return decodeThirdPartyLicenseManifest((await response.json()) as unknown);
}
