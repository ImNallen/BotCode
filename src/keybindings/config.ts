// Ported from pingdotgg/t3code v0.0.45 apps/server/src/keybindings.ts and packages/shared/src/schemaJson.ts (MIT).
import { z } from "zod";
import { STATIC_KEYBINDING_COMMANDS } from "./commands";
import {
  compileResolvedKeybindingRule,
  MAX_KEYBINDINGS_COUNT,
  type KeybindingRule,
  type ResolvedKeybindingRule,
} from "./rules";

export type KeybindingIssue = { index?: number; message: string };
export type KeybindingsDocument = {
  entries: readonly unknown[] | null;
  rules: readonly KeybindingRule[];
  compiled: readonly ResolvedKeybindingRule[];
  issues: readonly KeybindingIssue[];
};
const schema = z.object({
  key: z.string().trim().min(1).max(64),
  command: z.string().trim().min(1),
  when: z.string().trim().min(1).max(256).optional(),
});
const known = new Set<string>(STATIC_KEYBINDING_COMMANDS);
export function parseRule(input: unknown, extensions: ReadonlySet<string>) {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    return {
      error: parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    };
  const rule = parsed.data;
  if (
    !known.has(rule.command) &&
    !extensions.has(rule.command) &&
    !/^script\.[a-z0-9][a-z0-9-]{0,23}\.run$/.test(rule.command)
  )
    return { error: `Unknown command ${rule.command}.` };
  const compiled = compileResolvedKeybindingRule(rule);
  if (!compiled)
    return {
      error: `Invalid shortcut or when expression for ${rule.command}.`,
    };
  return { rule, compiled };
}
function lenientJson(text: string): unknown {
  let stripped = text.replace(
    /("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g,
    (match, literal: string | undefined) => (literal ? match : ""),
  );
  stripped = stripped.replace(
    /("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\//g,
    (match, literal: string | undefined) => (literal ? match : ""),
  );
  stripped = stripped.replace(
    /("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g,
    (match, literal: string | undefined, bracket: string | undefined) =>
      literal ? match : (bracket ?? ""),
  );
  return JSON.parse(stripped);
}
export function parseKeybindings(
  text: string | null,
  extensions: ReadonlySet<string>,
): KeybindingsDocument {
  const rules: KeybindingRule[] = [];
  const compiled: ResolvedKeybindingRule[] = [];
  const issues: KeybindingIssue[] = [];
  let entries: unknown[];
  try {
    entries =
      text === null
        ? []
        : z
            .array(z.unknown())
            .max(MAX_KEYBINDINGS_COUNT)
            .parse(lenientJson(text));
  } catch {
    return {
      entries: null,
      rules,
      compiled,
      issues: [
        {
          message: `keybindings.json must contain a JSON array of at most ${MAX_KEYBINDINGS_COUNT} rules. Defaults remain active.`,
        },
      ],
    };
  }
  entries.forEach((entry, index) => {
    const parsed = parseRule(entry, extensions);
    if (parsed.error !== undefined)
      issues.push({
        index,
        message: `${parsed.error} The command's default remains active unless another valid rule overrides it.`,
      });
    else {
      rules.push(parsed.rule);
      compiled.push(parsed.compiled);
    }
  });
  return { entries, rules, compiled, issues };
}
export type KeybindingEdit =
  | { kind: "upsert"; rule: KeybindingRule; replace?: KeybindingRule }
  | { kind: "remove"; rule: KeybindingRule }
  | { kind: "reset"; command: string };
const sameRule = (a: KeybindingRule, b: KeybindingRule) =>
  a.command === b.command &&
  a.key === b.key &&
  (a.when ?? "") === (b.when ?? "");
export function editKeybindings(
  document: KeybindingsDocument,
  edit: KeybindingEdit,
  extensions: ReadonlySet<string>,
): string {
  if (document.entries === null)
    throw new Error(
      "Fix the malformed keybindings.json before saving shortcuts. The file was left unchanged.",
    );
  if (edit.kind === "upsert") {
    const parsed = parseRule(edit.rule, extensions);
    if (parsed.error !== undefined) throw new Error(parsed.error);
    edit = { ...edit, rule: parsed.rule };
  }
  const entries = document.entries.filter((entry) => {
    const parsed = parseRule(entry, extensions);
    if (parsed.error !== undefined) return true;
    if (edit.kind === "reset") return parsed.rule.command !== edit.command;
    if (edit.kind === "remove") return !sameRule(parsed.rule, edit.rule);
    return (
      !sameRule(parsed.rule, edit.rule) &&
      (!edit.replace || !sameRule(parsed.rule, edit.replace))
    );
  });
  if (edit.kind === "upsert") entries.push(edit.rule);
  if (entries.length > MAX_KEYBINDINGS_COUNT)
    throw new Error(
      "The keybindings file already contains 256 entries. Remove a rule before adding another.",
    );
  return `${JSON.stringify(entries, null, 2)}\n`;
}
