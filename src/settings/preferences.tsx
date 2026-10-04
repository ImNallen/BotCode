import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { z } from "zod";
import { storage } from "../lib/storage";

const favoriteModelSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});
export type FavoriteModel = Readonly<z.infer<typeof favoriteModelSchema>>;

const newThreadSchema = z.object({
  newThreadCheckout: z.enum(["local", "worktree"]),
  newWorktreesStartFromOrigin: z.boolean(),
});
export type NewThreadValues = z.infer<typeof newThreadSchema>;
export type NewThreadSetting = keyof NewThreadValues;
export type ProjectOverride = Partial<NewThreadValues>;
export const builtInNewThread: NewThreadValues = {
  newThreadCheckout: "local",
  newWorktreesStartFromOrigin: true,
};

const schema = z.object({
  appearance: z.enum(["system", "light", "dark"]),
  promptFontSize: z.number().int().min(12).max(20),
  codeFontSize: z.number().int().min(11).max(20),
  favoriteModels: z.array(favoriteModelSchema),
  ...newThreadSchema.shape,
  projectOverrides: z.record(z.uuid(), newThreadSchema.partial()),
});
type Preferences = Readonly<z.infer<typeof schema>>;
export const checkoutModeLabels = {
  local: "Current checkout",
  worktree: "New worktree",
} as const satisfies Record<Preferences["newThreadCheckout"], string>;
export type CheckoutMode = keyof typeof checkoutModeLabels;
const defaults: Preferences = {
  appearance: "system",
  promptFontSize: 14,
  codeFontSize: 13,
  favoriteModels: [],
  ...builtInNewThread,
  projectOverrides: {},
};
const storageKey = "z1:preferences:v1";
type PreferenceState = {
  preferences: Preferences;
  persistenceError: string | undefined;
};
const Context = createContext<
  | (PreferenceState & {
      update: (patch: Partial<Preferences>) => void;
      // An undefined field removes that override.
      patchProject: (workspaceId: string, patch: ProjectOverride) => void;
      forgetProject: (workspaceId: string) => void;
      reset: () => void;
      setFavorite: (pair: FavoriteModel, wanted: boolean) => void;
    })
  | null
>(null);

function readPreferences(): PreferenceState {
  try {
    const stored = storage.getItem(storageKey);
    if (stored === null)
      return { preferences: defaults, persistenceError: undefined };
    const object = z
      .object({
        appearance: z.unknown().optional(),
        promptFontSize: z.unknown().optional(),
        codeFontSize: z.unknown().optional(),
        favoriteModels: z.unknown().optional(),
        newThreadCheckout: z.unknown().optional(),
        newWorktreesStartFromOrigin: z.unknown().optional(),
        projectOverrides: z.unknown().optional(),
      })
      .parse(JSON.parse(stored));
    const appearance = schema.shape.appearance.safeParse(object.appearance);
    const promptFontSize = schema.shape.promptFontSize.safeParse(
      object.promptFontSize,
    );
    const codeFontSize = schema.shape.codeFontSize.safeParse(
      object.codeFontSize,
    );
    const newThreadCheckout = schema.shape.newThreadCheckout.safeParse(
      object.newThreadCheckout,
    );
    const newWorktreesStartFromOrigin =
      schema.shape.newWorktreesStartFromOrigin.safeParse(
        object.newWorktreesStartFromOrigin,
      );
    const favorites = schema.shape.favoriteModels.safeParse(
      object.favoriteModels,
    );
    const projectOverrides = Object.fromEntries(
      Object.entries(
        z
          .record(z.string(), z.unknown())
          .catch({})
          .parse(object.projectOverrides),
      ).flatMap(([id, value]) => {
        const parsed = z.record(z.string(), z.unknown()).safeParse(value);
        if (!z.uuid().safeParse(id).success || !parsed.success) return [];
        const entry = parsed.data;
        const checkout = newThreadSchema.shape.newThreadCheckout.safeParse(
          entry.newThreadCheckout,
        );
        const fromOrigin =
          newThreadSchema.shape.newWorktreesStartFromOrigin.safeParse(
            entry.newWorktreesStartFromOrigin,
          );
        const override: ProjectOverride = {
          ...(checkout.success ? { newThreadCheckout: checkout.data } : {}),
          ...(fromOrigin.success
            ? { newWorktreesStartFromOrigin: fromOrigin.data }
            : {}),
        };
        return Object.keys(override).length > 0 ? [[id, override]] : [];
      }),
    );
    const favoriteModels = favorites.success
      ? favorites.data.filter(
          (pair, index, pairs) =>
            pairs.findIndex(
              (other) =>
                other.provider === pair.provider && other.model === pair.model,
            ) === index,
        )
      : [];
    return {
      preferences: {
        favoriteModels,
        appearance: appearance.success ? appearance.data : defaults.appearance,
        promptFontSize: promptFontSize.success
          ? promptFontSize.data
          : defaults.promptFontSize,
        codeFontSize: codeFontSize.success
          ? codeFontSize.data
          : defaults.codeFontSize,
        newThreadCheckout: newThreadCheckout.success
          ? newThreadCheckout.data
          : defaults.newThreadCheckout,
        newWorktreesStartFromOrigin: newWorktreesStartFromOrigin.success
          ? newWorktreesStartFromOrigin.data
          : defaults.newWorktreesStartFromOrigin,
        projectOverrides,
      },
      persistenceError:
        object.favoriteModels !== undefined && !favorites.success
          ? "Saved model favorites could not be read. Using no favorites."
          : undefined,
    };
  } catch {
    return {
      preferences: defaults,
      persistenceError: "Saved preferences could not be read. Using defaults.",
    };
  }
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(readPreferences);
  const current = useRef(state.preferences);
  const update = (patch: Partial<Preferences>) => {
    const parsed = schema.safeParse({ ...current.current, ...patch });
    if (!parsed.success) return;
    current.current = parsed.data;
    setState((state) => ({ ...state, preferences: parsed.data }));
    void storage.setItem(storageKey, JSON.stringify(parsed.data)).then(
      () => setState((state) => ({ ...state, persistenceError: undefined })),
      () =>
        setState((state) => ({
          ...state,
          persistenceError:
            "Changes apply now, but could not be saved. They may be lost when Z1 Code restarts.",
        })),
    );
  };
  useLayoutEffect(() => {
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.classList.toggle(
        "dark",
        state.preferences.appearance === "dark" ||
          (state.preferences.appearance === "system" && scheme.matches),
      );
      document.documentElement.style.setProperty(
        "--font-size-prompt",
        `${state.preferences.promptFontSize}px`,
      );
      document.documentElement.style.setProperty(
        "--font-size-code",
        `${state.preferences.codeFontSize}px`,
      );
      document.documentElement.style.setProperty(
        "--diffs-font-size",
        `${state.preferences.codeFontSize}px`,
      );
    };
    apply();
    scheme.addEventListener("change", apply);
    return () => scheme.removeEventListener("change", apply);
  }, [state.preferences]);
  return (
    <Context.Provider
      value={{
        ...state,
        update,
        patchProject: (workspaceId, patch) => {
          const { [workspaceId]: previous, ...others } =
            current.current.projectOverrides;
          const next = { ...previous, ...patch };
          update({
            projectOverrides: Object.values(next).every(
              (value) => value === undefined,
            )
              ? others
              : { ...others, [workspaceId]: next },
          });
        },
        forgetProject: (workspaceId) => {
          const { [workspaceId]: _, ...others } =
            current.current.projectOverrides;
          update({ projectOverrides: others });
        },
        reset: () =>
          update({
            ...defaults,
            favoriteModels: current.current.favoriteModels,
          }),
        setFavorite: (pair, wanted) => {
          const remaining = current.current.favoriteModels.filter(
            (other) =>
              other.provider !== pair.provider || other.model !== pair.model,
          );
          update({ favoriteModels: wanted ? [...remaining, pair] : remaining });
        },
      }}
    >
      {children}
    </Context.Provider>
  );
}

export function newThreadDefaults(
  preferences: Preferences,
  workspaceId: string | undefined,
): { values: NewThreadValues; overridden: Record<NewThreadSetting, boolean> } {
  const override =
    workspaceId === undefined ? {} : preferences.projectOverrides[workspaceId];
  return {
    values: {
      newThreadCheckout:
        override?.newThreadCheckout ?? preferences.newThreadCheckout,
      newWorktreesStartFromOrigin:
        override?.newWorktreesStartFromOrigin ??
        preferences.newWorktreesStartFromOrigin,
    },
    overridden: {
      newThreadCheckout: override?.newThreadCheckout !== undefined,
      newWorktreesStartFromOrigin:
        override?.newWorktreesStartFromOrigin !== undefined,
    },
  };
}

export function usePreferences() {
  const context = useContext(Context);
  if (!context) throw new Error("PreferencesProvider is missing.");
  return context;
}
