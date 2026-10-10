import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { z } from "zod";
import { ipc, native, permissionMode } from "../ipc";
import { editorId } from "../lib/editors";
import { mergeMethod } from "../panel/prIdentity";
import { serial } from "../lib/serial";

const favoriteModelSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});
export type FavoriteModel = Readonly<z.infer<typeof favoriteModelSchema>>;

export const autoSettleDefaultDays = 3;
// Settings that a project can override. Null auto-settle days turn auto-settling off.
export const sourceControlWritingStyleSchema = z.object({
  mode: z.enum(["repo_conventions", "conventional_commits", "custom"]),
  customInstructions: z.string().trim(),
  followChangeRequestTemplates: z.boolean(),
});
export type SourceControlWritingStyle = z.infer<
  typeof sourceControlWritingStyleSchema
>;

const projectSchema = z.object({
  sourceControlWritingStyle: sourceControlWritingStyleSchema,
  defaultAutoPull: z.boolean(),
  pullRequestMergeMethod: mergeMethod.nullable(),
  defaultPermissionMode: permissionMode.nullable(),
  autoSettleOnMerge: z.boolean(),
  newThreadCheckout: z.enum(["local", "worktree"]),
  newWorktreesStartFromOrigin: z.boolean(),
  sidebarAutoSettleAfterDays: z.number().min(1).max(90).nullable(),
});
export type ProjectValues = z.infer<typeof projectSchema>;
export type ProjectSetting = keyof ProjectValues;
export type ProjectOverride = Partial<ProjectValues>;
export const builtInProject: ProjectValues = {
  sourceControlWritingStyle: {
    mode: "repo_conventions",
    customInstructions: "",
    followChangeRequestTemplates: true,
  },
  defaultAutoPull: false,
  pullRequestMergeMethod: null,
  defaultPermissionMode: null,
  autoSettleOnMerge: true,
  newThreadCheckout: "local",
  newWorktreesStartFromOrigin: true,
  sidebarAutoSettleAfterDays: autoSettleDefaultDays,
};

const storageCleanupSchema = z.object({
  worktreeAfterDays: z.number().int().min(1).max(3650).nullable(),
  worktreeUnchanged: z.boolean(),
  worktreeOnDelete: z.boolean(),
});
export type StorageCleanup = z.infer<typeof storageCleanupSchema>;

export const notificationModeSchema = z.enum([
  "off",
  "notifications",
  "sound",
  "notifications-and-sound",
]);
export type NotificationMode = z.infer<typeof notificationModeSchema>;

const schema = z.object({
  automaticGitFetchInterval: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER),
  newThreadCheckoutConfigured: z.boolean().default(false),
  notificationMode: notificationModeSchema,
  inAppNotificationsEnabled: z.boolean(),
  appearance: z.enum(["system", "light", "dark"]),
  promptFontSize: z.number().int().min(12).max(20),
  codeFontSize: z.number().int().min(11).max(20),
  followUpBehavior: z.enum(["queue", "steer"]),
  // Null picks the first installed editor.
  preferredEditor: editorId.nullable(),
  contextWindowMeter: z.boolean(),
  sidebarWorkingShelfEnabled: z.boolean(),
  favoriteModels: z.array(favoriteModelSchema),
  ...projectSchema.shape,
  projectOverrides: z.record(z.uuid(), projectSchema.partial()),
  storageCleanup: storageCleanupSchema,
});
type Preferences = Readonly<z.infer<typeof schema>>;
export const checkoutModeLabels = {
  local: "Current checkout",
  worktree: "New worktree",
} as const satisfies Record<Preferences["newThreadCheckout"], string>;
export type CheckoutMode = keyof typeof checkoutModeLabels;
export const defaults: Preferences = {
  automaticGitFetchInterval: 30_000,
  newThreadCheckoutConfigured: false,
  notificationMode: "off",
  inAppNotificationsEnabled: false,
  appearance: "system",
  promptFontSize: 14,
  codeFontSize: 13,
  followUpBehavior: "queue",
  preferredEditor: null,
  contextWindowMeter: true,
  sidebarWorkingShelfEnabled: false,
  favoriteModels: [],
  ...builtInProject,
  projectOverrides: {},
  storageCleanup: {
    worktreeAfterDays: null,
    worktreeUnchanged: false,
    worktreeOnDelete: false,
  },
};
const storageKey = "z1:preferences:v1";
let fileText: string | null | Error = null;
export async function loadPreferences(): Promise<void> {
  if (native)
    fileText = await ipc
      .settingsFile()
      .catch(() => new Error("Unreadable settings file."));
}
function storedText(): string | null {
  if (!native) return localStorage.getItem(storageKey);
  if (fileText instanceof Error) throw fileText;
  return fileText;
}
const enqueue = serial();
async function saveText(text: string): Promise<void> {
  if (native) await enqueue(() => ipc.saveSettingsFile(text));
  else localStorage.setItem(storageKey, text);
}
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

export function readPreferences(): PreferenceState {
  try {
    const stored = storedText();
    if (stored === null)
      return { preferences: defaults, persistenceError: undefined };
    const object = z
      .object({
        sourceControlWritingStyle: z.unknown().optional(),
        defaultAutoPull: z.unknown().optional(),
        pullRequestMergeMethod: z.unknown().optional(),
        automaticGitFetchInterval: z.unknown().optional(),
        defaultPermissionMode: z.unknown().optional(),
        autoSettleOnMerge: z.unknown().optional(),
        appearance: z.unknown().optional(),
        promptFontSize: z.unknown().optional(),
        codeFontSize: z.unknown().optional(),
        followUpBehavior: z.unknown().optional(),
        preferredEditor: z.unknown().optional(),
        contextWindowMeter: z.unknown().optional(),
        sidebarWorkingShelfEnabled: z.unknown().optional(),
        notificationMode: z.unknown().optional(),
        inAppNotificationsEnabled: z.unknown().optional(),
        favoriteModels: z.unknown().optional(),
        newThreadCheckout: z.unknown().optional(),
        newThreadCheckoutConfigured: z.unknown().optional(),
        newWorktreesStartFromOrigin: z.unknown().optional(),
        sidebarAutoSettleAfterDays: z.unknown().optional(),
        projectOverrides: z.unknown().optional(),
        storageCleanup: z.unknown().optional(),
      })
      .parse(JSON.parse(stored));
    const defaultPermissionMode = schema.shape.defaultPermissionMode.safeParse(
      object.defaultPermissionMode,
    );
    const autoSettleOnMerge = schema.shape.autoSettleOnMerge.safeParse(
      object.autoSettleOnMerge,
    );
    const appearance = schema.shape.appearance.safeParse(object.appearance);
    const promptFontSize = schema.shape.promptFontSize.safeParse(
      object.promptFontSize,
    );
    const codeFontSize = schema.shape.codeFontSize.safeParse(
      object.codeFontSize,
    );
    const contextWindowMeter = schema.shape.contextWindowMeter.safeParse(
      object.contextWindowMeter,
    );
    const newThreadCheckout = schema.shape.newThreadCheckout.safeParse(
      object.newThreadCheckout,
    );
    const newWorktreesStartFromOrigin =
      schema.shape.newWorktreesStartFromOrigin.safeParse(
        object.newWorktreesStartFromOrigin,
      );
    const sidebarAutoSettleAfterDays =
      schema.shape.sidebarAutoSettleAfterDays.safeParse(
        object.sidebarAutoSettleAfterDays,
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
        const override = projectSchema.partial().parse(
          Object.fromEntries(
            projectSchema
              .keyof()
              .options.filter(
                (key) =>
                  projectSchema.shape[key].safeParse(parsed.data[key]).success,
              )
              .map((key) => [key, parsed.data[key]]),
          ),
        );
        return Object.keys(override).length > 0 ? [[id, override]] : [];
      }),
    );
    const storageCleanup = z
      .record(z.string(), z.unknown())
      .catch({})
      .parse(object.storageCleanup);
    const worktreeAfterDays =
      storageCleanupSchema.shape.worktreeAfterDays.safeParse(
        storageCleanup.worktreeAfterDays,
      );
    const worktreeUnchanged =
      storageCleanupSchema.shape.worktreeUnchanged.safeParse(
        storageCleanup.worktreeUnchanged,
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
        sourceControlWritingStyle: sourceControlWritingStyleSchema
          .catch(builtInProject.sourceControlWritingStyle)
          .parse(object.sourceControlWritingStyle),
        defaultAutoPull: z.boolean().catch(false).parse(object.defaultAutoPull),
        pullRequestMergeMethod: mergeMethod
          .nullable()
          .catch(null)
          .parse(object.pullRequestMergeMethod),
        automaticGitFetchInterval: schema.shape.automaticGitFetchInterval
          .catch(30_000)
          .parse(object.automaticGitFetchInterval),
        defaultPermissionMode: defaultPermissionMode.success
          ? defaultPermissionMode.data
          : defaults.defaultPermissionMode,
        favoriteModels,
        sidebarWorkingShelfEnabled: schema.shape.sidebarWorkingShelfEnabled
          .catch(false)
          .parse(object.sidebarWorkingShelfEnabled),
        followUpBehavior: schema.shape.followUpBehavior
          .catch("queue")
          .parse(object.followUpBehavior),
        preferredEditor: editorId
          .nullable()
          .catch(null)
          .parse(object.preferredEditor ?? null),
        notificationMode: notificationModeSchema
          .catch("off")
          .parse(object.notificationMode),
        inAppNotificationsEnabled: z
          .boolean()
          .catch(false)
          .parse(object.inAppNotificationsEnabled),
        appearance: appearance.success ? appearance.data : defaults.appearance,
        promptFontSize: promptFontSize.success
          ? promptFontSize.data
          : defaults.promptFontSize,
        codeFontSize: codeFontSize.success
          ? codeFontSize.data
          : defaults.codeFontSize,
        contextWindowMeter: contextWindowMeter.success
          ? contextWindowMeter.data
          : defaults.contextWindowMeter,
        newThreadCheckoutConfigured:
          object.newThreadCheckoutConfigured === true,
        newThreadCheckout: newThreadCheckout.success
          ? newThreadCheckout.data
          : defaults.newThreadCheckout,
        newWorktreesStartFromOrigin: newWorktreesStartFromOrigin.success
          ? newWorktreesStartFromOrigin.data
          : defaults.newWorktreesStartFromOrigin,
        autoSettleOnMerge: autoSettleOnMerge.success
          ? autoSettleOnMerge.data
          : defaults.autoSettleOnMerge,
        sidebarAutoSettleAfterDays: sidebarAutoSettleAfterDays.success
          ? sidebarAutoSettleAfterDays.data
          : defaults.sidebarAutoSettleAfterDays,
        projectOverrides,
        storageCleanup: {
          worktreeOnDelete: storageCleanup.worktreeOnDelete === true,
          worktreeAfterDays: worktreeAfterDays.success
            ? worktreeAfterDays.data
            : defaults.storageCleanup.worktreeAfterDays,
          worktreeUnchanged: worktreeUnchanged.success
            ? worktreeUnchanged.data
            : defaults.storageCleanup.worktreeUnchanged,
        },
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
    const parsed = schema.safeParse({
      ...current.current,
      ...patch,
      newThreadCheckoutConfigured:
        patch.newThreadCheckoutConfigured ??
        (patch.newThreadCheckout !== undefined
          ? true
          : current.current.newThreadCheckoutConfigured),
    });
    if (!parsed.success) return;
    current.current = parsed.data;
    setState((state) => ({ ...state, preferences: parsed.data }));
    void saveText(`${JSON.stringify(parsed.data, null, 2)}\n`).then(
      () => setState((state) => ({ ...state, persistenceError: undefined })),
      () =>
        setState((state) => ({
          ...state,
          persistenceError:
            "Changes apply now, but could not be saved. They may be lost when Bot Code restarts.",
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

export function projectSetting<K extends ProjectSetting>(
  preferences: Preferences,
  workspaceId: string | undefined,
  key: K,
): { value: ProjectValues[K]; overridden: boolean } {
  const override =
    workspaceId === undefined
      ? undefined
      : preferences.projectOverrides[workspaceId]?.[key];
  return override === undefined
    ? { value: preferences[key], overridden: false }
    : { value: override as ProjectValues[K], overridden: true };
}

export function usePreferences() {
  const context = useContext(Context);
  if (!context) throw new Error("PreferencesProvider is missing.");
  return context;
}
