import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { z } from "zod";
import {
  ipc,
  native,
  permissionMode,
  projectScript,
  type ProjectScript,
} from "../ipc";
import { editorId } from "../lib/editors";
import { mergeMethod } from "../panel/prIdentity";
import { serial } from "../lib/serial";
import { DEFAULT_LINK_TARGET, linkTargetSchema } from "../preview/linkTarget";
import { readUsagePrices } from "../usage/prices";
import {
  appearanceSchema,
  defaultAppearance,
  LEGACY_WORD_WRAP_KEY,
  readAppearance,
  type AppearanceSettings,
} from "../appearance/settings";
import { storage } from "../lib/storage";

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
// A null effort uses the model's default reasoning effort.
export const modelSelectionSchema = z.object({
  model: z.string().min(1),
  effort: z.string().min(1).nullable(),
});
export type ModelSelection = z.infer<typeof modelSelectionSchema>;
// T3 Code v0.0.45 packages/contracts/src/model.ts DEFAULT_TEXT_GENERATION_MODEL and DEFAULT_TEXT_GENERATION_REASONING_EFFORT.
export const defaultTextGenerationModelSelection: ModelSelection = {
  model: "gpt-6-luna",
  effort: "low",
};

const projectSchema = z.object({
  sourceControlWritingStyle: sourceControlWritingStyleSchema,
  defaultAutoPull: z.boolean(),
  pullRequestMergeMethod: mergeMethod.nullable(),
  defaultPermissionMode: permissionMode.nullable(),
  autoSettleOnMerge: z.boolean(),
  newThreadCheckout: z.enum(["local", "worktree"]),
  newWorktreesStartFromOrigin: z.boolean(),
  sidebarAutoSettleAfterDays: z.number().min(1).max(90).nullable(),
  // Null starts new threads on the provider's default model.
  defaultModelSelection: modelSelectionSchema.nullable(),
  textGenerationModelSelection: modelSelectionSchema,
});
export type ProjectValues = z.infer<typeof projectSchema>;
export type ProjectSetting = keyof ProjectValues;
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
  defaultModelSelection: null,
  textGenerationModelSelection: defaultTextGenerationModelSelection,
};

const retentionDays = z.number().int().min(1).max(3650).nullable();
const storageCleanupSchema = z.object({
  worktreeAfterDays: retentionDays,
  worktreeOnMerge: z.boolean(),
  worktreeUnchanged: z.boolean(),
  worktreeOnDelete: z.boolean(),
  browserArtifactsAfterDays: retentionDays,
  logsAfterDays: retentionDays,
});
export type StorageCleanup = z.infer<typeof storageCleanupSchema>;
const worktreeCleanupRulesSchema = storageCleanupSchema.pick({
  worktreeAfterDays: true,
  worktreeOnMerge: true,
  worktreeOnDelete: true,
  worktreeUnchanged: true,
});
export type WorktreeCleanupRules = z.infer<typeof worktreeCleanupRulesSchema>;
const worktreeCleanupSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("off") }),
  z.object({ mode: z.literal("custom"), rules: worktreeCleanupRulesSchema }),
]);
export type WorktreeCleanup = z.infer<typeof worktreeCleanupSchema>;
const projectOverrideShape = {
  ...projectSchema.shape,
  worktreeCleanup: worktreeCleanupSchema,
};
const projectOverrideSchema = z.object(projectOverrideShape).partial();
export type ProjectOverride = z.infer<typeof projectOverrideSchema>;

export const notificationModeSchema = z.enum([
  "off",
  "notifications",
  "sound",
  "notifications-and-sound",
]);
export type NotificationMode = z.infer<typeof notificationModeSchema>;

export const sendShortcutSchema = z.enum([
  "enter",
  "mod-enter-multiline",
  "mod-enter",
]);
export type SendShortcut = z.infer<typeof sendShortcutSchema>;

export const quitShortcutSchema = z.enum(["direct", "hold", "double-click"]);
export type QuitShortcut = z.infer<typeof quitShortcutSchema>;

const scriptSettingsOverrides = z.record(
  z.uuid(),
  z.object({ defaultProjectScripts: z.array(projectScript).optional() }),
);
const schema = z.object({
  defaultProjectScripts: z.array(projectScript),
  projectSettingsOverrides: scriptSettingsOverrides,
  projectScriptOverrides: z.record(z.uuid(), z.array(projectScript).nullable()),
  projectSettingsFolded: z.boolean(),
  automaticGitFetchInterval: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER),
  newThreadCheckoutConfigured: z.boolean().default(false),
  notificationMode: notificationModeSchema,
  inAppNotificationsEnabled: z.boolean(),
  appearance: appearanceSchema,
  followUpBehavior: z.enum(["queue", "steer"]),
  composerRichTextEnabled: z.boolean(),
  composerCollapseOnScroll: z.boolean(),
  sendShortcut: sendShortcutSchema,
  confirmQuit: quitShortcutSchema,
  // Null picks the first installed editor.
  preferredEditor: editorId.nullable(),
  browserLinkTarget: linkTargetSchema,
  contextWindowMeter: z.boolean(),
  sidebarWorkingShelfEnabled: z.boolean(),
  favoriteModels: z.array(favoriteModelSchema),
  ...projectSchema.shape,
  projectOverrides: z.record(z.uuid(), projectOverrideSchema),
  storageCleanup: storageCleanupSchema,
  usagePriceOverrides: z.unknown().transform(readUsagePrices),
});
export type Preferences = Readonly<z.infer<typeof schema>>;
export const checkoutModeLabels = {
  local: "Current checkout",
  worktree: "New worktree",
} as const satisfies Record<Preferences["newThreadCheckout"], string>;
export type CheckoutMode = keyof typeof checkoutModeLabels;
export const defaults: Preferences = {
  defaultProjectScripts: [],
  projectSettingsOverrides: {},
  projectScriptOverrides: {},
  projectSettingsFolded: false,
  automaticGitFetchInterval: 30_000,
  newThreadCheckoutConfigured: false,
  notificationMode: "off",
  inAppNotificationsEnabled: false,
  appearance: defaultAppearance,
  followUpBehavior: "queue",
  composerRichTextEnabled: true,
  composerCollapseOnScroll: true,
  sendShortcut: "enter",
  confirmQuit: "hold",
  preferredEditor: null,
  browserLinkTarget: DEFAULT_LINK_TARGET,
  contextWindowMeter: true,
  sidebarWorkingShelfEnabled: false,
  favoriteModels: [],
  ...builtInProject,
  projectOverrides: {},
  storageCleanup: {
    worktreeAfterDays: null,
    worktreeOnMerge: false,
    worktreeUnchanged: false,
    worktreeOnDelete: false,
    browserArtifactsAfterDays: null,
    logsAfterDays: null,
  },
  usagePriceOverrides: {},
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
      // Merges into the latest appearance, so two changes in one handler both
      // land. Resolves false when settings.json could not be written.
      updateAppearance: (
        change: (current: AppearanceSettings) => Partial<AppearanceSettings>,
      ) => Promise<boolean>;
      save: (patch: Partial<Preferences>) => Promise<void>;
      saveActions: (
        workspaceId: string | undefined,
        scripts: readonly ProjectScript[] | null,
      ) => Promise<void>;
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
        defaultProjectScripts: z.unknown().optional(),
        projectSettingsOverrides: z.unknown().optional(),
        projectScriptOverrides: z.unknown().optional(),
        projectSettingsFolded: z.unknown().optional(),
        sourceControlWritingStyle: z.unknown().optional(),
        defaultAutoPull: z.unknown().optional(),
        pullRequestMergeMethod: z.unknown().optional(),
        automaticGitFetchInterval: z.unknown().optional(),
        defaultPermissionMode: z.unknown().optional(),
        autoSettleOnMerge: z.unknown().optional(),
        appearance: z.unknown().optional(),
        // Legacy keys, read only to migrate them into appearance.
        promptFontSize: z.unknown().optional(),
        codeFontSize: z.unknown().optional(),
        followUpBehavior: z.unknown().optional(),
        composerRichTextEnabled: z.unknown().optional(),
        composerCollapseOnScroll: z.unknown().optional(),
        sendShortcut: z.unknown().optional(),
        confirmQuit: z.unknown().optional(),
        preferredEditor: z.unknown().optional(),
        browserLinkTarget: z.unknown().optional(),
        contextWindowMeter: z.unknown().optional(),
        sidebarWorkingShelfEnabled: z.unknown().optional(),
        notificationMode: z.unknown().optional(),
        inAppNotificationsEnabled: z.unknown().optional(),
        favoriteModels: z.unknown().optional(),
        newThreadCheckout: z.unknown().optional(),
        newThreadCheckoutConfigured: z.unknown().optional(),
        newWorktreesStartFromOrigin: z.unknown().optional(),
        sidebarAutoSettleAfterDays: z.unknown().optional(),
        defaultModelSelection: z.unknown().optional(),
        textGenerationModelSelection: z.unknown().optional(),
        projectOverrides: z.unknown().optional(),
        storageCleanup: z.unknown().optional(),
        usagePriceOverrides: z.unknown().optional(),
      })
      .parse(JSON.parse(stored));
    const defaultPermissionMode = schema.shape.defaultPermissionMode.safeParse(
      object.defaultPermissionMode,
    );
    const autoSettleOnMerge = schema.shape.autoSettleOnMerge.safeParse(
      object.autoSettleOnMerge,
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
        const override = projectOverrideSchema.parse(
          Object.fromEntries(
            projectOverrideSchema
              .keyof()
              .options.filter(
                (key) =>
                  projectOverrideShape[key].safeParse(parsed.data[key]).success,
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
        defaultProjectScripts: schema.shape.defaultProjectScripts
          .catch([])
          .parse(object.defaultProjectScripts),
        projectSettingsOverrides: scriptSettingsOverrides
          .catch({})
          .parse(object.projectSettingsOverrides),
        projectScriptOverrides: schema.shape.projectScriptOverrides
          .catch({})
          .parse(object.projectScriptOverrides),
        projectSettingsFolded: object.projectSettingsFolded === true,
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
        composerRichTextEnabled: z
          .boolean()
          .catch(defaults.composerRichTextEnabled)
          .parse(object.composerRichTextEnabled),
        composerCollapseOnScroll: z
          .boolean()
          .catch(defaults.composerCollapseOnScroll)
          .parse(object.composerCollapseOnScroll),
        sendShortcut: sendShortcutSchema
          .catch(defaults.sendShortcut)
          .parse(object.sendShortcut),
        confirmQuit: quitShortcutSchema
          .catch(defaults.confirmQuit)
          .parse(object.confirmQuit),
        preferredEditor: editorId
          .nullable()
          .catch(null)
          .parse(object.preferredEditor ?? null),
        browserLinkTarget: linkTargetSchema
          .catch(defaults.browserLinkTarget)
          .parse(object.browserLinkTarget),
        notificationMode: notificationModeSchema
          .catch("off")
          .parse(object.notificationMode),
        inAppNotificationsEnabled: z
          .boolean()
          .catch(false)
          .parse(object.inAppNotificationsEnabled),
        appearance: readAppearance(object.appearance, {
          ...object,
          wordWrap: storage.getItem(LEGACY_WORD_WRAP_KEY),
        }),
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
        defaultModelSelection: modelSelectionSchema
          .nullable()
          .catch(defaults.defaultModelSelection)
          .parse(object.defaultModelSelection ?? null),
        textGenerationModelSelection: modelSelectionSchema
          .catch(defaults.textGenerationModelSelection)
          .parse(object.textGenerationModelSelection),
        projectOverrides,
        storageCleanup: Object.fromEntries(
          storageCleanupSchema.keyof().options.map((key) => {
            const value = storageCleanupSchema.shape[key].safeParse(
              storageCleanup[key],
            );
            return [
              key,
              value.success ? value.data : defaults.storageCleanup[key],
            ];
          }),
        ) as StorageCleanup,
        usagePriceOverrides: readUsagePrices(object.usagePriceOverrides),
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
  const persist = async (patch: Partial<Preferences>) => {
    const parsed = schema.parse({
      ...current.current,
      ...patch,
      newThreadCheckoutConfigured:
        patch.newThreadCheckoutConfigured ??
        (patch.newThreadCheckout !== undefined
          ? true
          : current.current.newThreadCheckoutConfigured),
    });
    current.current = parsed;
    setState((state) => ({ ...state, preferences: parsed }));
    try {
      await saveText(
        `${JSON.stringify(parsed, (key, value) => (key === "defaultProjectScripts" && Array.isArray(value) ? value.map(({ async, previewUrl, autoOpenPreview, ...script }: ProjectScript) => ({ ...script, ...(async === false ? { async: false } : {}), ...(previewUrl ? { previewUrl, autoOpenPreview } : {}) })) : value), 2)}\n`,
      );
      setState((state) => ({ ...state, persistenceError: undefined }));
    } catch (error: unknown) {
      setState((state) => ({
        ...state,
        persistenceError:
          "Changes apply now, but could not be saved. They may be lost when Bot Code restarts.",
      }));
      throw error;
    }
  };
  const update = (patch: Partial<Preferences>) => {
    void persist(patch).catch(() => {});
  };
  return (
    <Context.Provider
      value={{
        ...state,
        update,
        updateAppearance: (change) => {
          const appearance = current.current.appearance;
          return persist({
            appearance: { ...appearance, ...change(appearance) },
          }).then(
            () => true,
            () => false,
          );
        },
        save: persist,
        saveActions: (workspaceId, scripts) => {
          if (!workspaceId)
            return persist({ defaultProjectScripts: [...(scripts ?? [])] });
          const { [workspaceId]: previous, ...others } =
            current.current.projectSettingsOverrides;
          const next = { ...previous };
          if (scripts === null) delete next.defaultProjectScripts;
          else next.defaultProjectScripts = [...scripts];
          return persist({
            projectSettingsOverrides: Object.keys(next).length
              ? { ...others, [workspaceId]: next }
              : others,
          });
        },
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
          const { [workspaceId]: _actions, ...actionOthers } =
            current.current.projectSettingsOverrides;
          const { [workspaceId]: _legacy, ...legacyOthers } =
            current.current.projectScriptOverrides;
          update({
            projectOverrides: others,
            projectSettingsOverrides: actionOthers,
            projectScriptOverrides: legacyOthers,
          });
        },
        reset: () =>
          update({
            ...defaults,
            favoriteModels: current.current.favoriteModels,
            usagePriceOverrides: current.current.usagePriceOverrides,
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

// Ports T3 Code v0.0.45 packages/shared/src/projectSettings.ts resolveWorktreeCleanup (MIT).
export function resolveWorktreeCleanup(
  preferences: Preferences,
  workspaceId: string | undefined,
): WorktreeCleanupRules {
  const policy =
    workspaceId === undefined
      ? undefined
      : preferences.projectOverrides[workspaceId]?.worktreeCleanup;
  if (policy?.mode === "custom") return policy.rules;
  if (policy?.mode === "off")
    return {
      worktreeAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
    };
  const {
    worktreeAfterDays,
    worktreeOnMerge,
    worktreeOnDelete,
    worktreeUnchanged,
  } = preferences.storageCleanup;
  return {
    worktreeAfterDays,
    worktreeOnMerge,
    worktreeOnDelete,
    worktreeUnchanged,
  };
}

// Ports T3 Code v0.0.45 packages/shared/src/serverSettings.ts custom seeding (MIT).
export function customWorktreeCleanup(
  preferences: Preferences,
  workspaceId: string,
  patch: Partial<WorktreeCleanupRules>,
): Extract<WorktreeCleanup, { mode: "custom" }> {
  const current = preferences.projectOverrides[workspaceId]?.worktreeCleanup;
  const {
    worktreeAfterDays,
    worktreeOnMerge,
    worktreeOnDelete,
    worktreeUnchanged,
  } = preferences.storageCleanup;
  return {
    mode: "custom",
    rules: {
      worktreeAfterDays,
      worktreeOnMerge,
      worktreeOnDelete,
      worktreeUnchanged,
      ...(current?.mode === "custom" ? current.rules : {}),
      ...patch,
    },
  };
}

export function usePreferences() {
  const context = useContext(Context);
  if (!context) throw new Error("PreferencesProvider is missing.");
  return context;
}
