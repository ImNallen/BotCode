import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { z } from "zod";

const favoriteModelSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});
export type FavoriteModel = Readonly<z.infer<typeof favoriteModelSchema>>;

const schema = z.object({
  appearance: z.enum(["system", "light", "dark"]),
  promptFontSize: z.number().int().min(12).max(20),
  codeFontSize: z.number().int().min(11).max(20),
  favoriteModels: z.array(favoriteModelSchema),
});
type Preferences = Readonly<z.infer<typeof schema>>;
const defaults: Preferences = {
  appearance: "system",
  promptFontSize: 14,
  codeFontSize: 13,
  favoriteModels: [],
};
const storageKey = "z1:preferences:v1";
type PreferenceState = {
  preferences: Preferences;
  persistenceError: string | undefined;
};
const Context = createContext<
  | (PreferenceState & {
      update: (patch: Partial<Preferences>) => void;
      reset: () => void;
      setFavorite: (pair: FavoriteModel, wanted: boolean) => void;
    })
  | null
>(null);

function readPreferences(): PreferenceState {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored === null)
      return { preferences: defaults, persistenceError: undefined };
    const object = z
      .object({
        appearance: z.unknown().optional(),
        promptFontSize: z.unknown().optional(),
        codeFontSize: z.unknown().optional(),
        favoriteModels: z.unknown().optional(),
      })
      .parse(JSON.parse(stored));
    const appearance = schema.shape.appearance.safeParse(object.appearance);
    const promptFontSize = schema.shape.promptFontSize.safeParse(
      object.promptFontSize,
    );
    const codeFontSize = schema.shape.codeFontSize.safeParse(
      object.codeFontSize,
    );
    const favorites = schema.shape.favoriteModels.safeParse(
      object.favoriteModels,
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
    let persistenceError: string | undefined;
    try {
      localStorage.setItem(storageKey, JSON.stringify(parsed.data));
    } catch {
      persistenceError =
        "Changes apply now, but could not be saved. They may be lost when Z1 Code restarts.";
    }
    current.current = parsed.data;
    setState({ preferences: parsed.data, persistenceError });
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

export function usePreferences() {
  const context = useContext(Context);
  if (!context) throw new Error("PreferencesProvider is missing.");
  return context;
}
