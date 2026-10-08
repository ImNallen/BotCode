// Ported from pingdotgg/t3code v0.0.45 components/settings/KeybindingsSettings.logic.ts (MIT).
import { shortcutConflictKey } from "../keybindings/keyboard";
import {
  compileResolvedKeybindingRule,
  parseKeybindingWhenExpression,
  type KeybindingRule,
  type KeybindingWhenNode,
  type ResolvedKeybindingRule,
} from "../keybindings/rules";

export type KeybindingCommandOption = { command: string; label: string };
export type KeybindingRow = {
  id: string;
  rule: KeybindingRule;
  binding: ResolvedKeybindingRule;
  label: string;
  source: "Default" | "Custom" | "Project";
  defaultRule: KeybindingRule | null;
};

export function isProjectCommand(command: string): boolean {
  return /^script\.[a-z0-9][a-z0-9-]{0,23}\.run$/.test(command);
}

export function projectCommandLabel(command: string): string {
  const name = command.slice("script.".length, -".run".length);
  return `Run Script: ${name
    .split("-")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ")}`;
}

function sameBinding(
  left: ResolvedKeybindingRule,
  right: ResolvedKeybindingRule,
): boolean {
  return (
    JSON.stringify(left.shortcut) === JSON.stringify(right.shortcut) &&
    JSON.stringify(left.whenAst) === JSON.stringify(right.whenAst)
  );
}

export function buildKeybindingRows(
  effective: readonly KeybindingRule[],
  defaults: readonly KeybindingRule[],
  commands: readonly KeybindingCommandOption[],
): readonly KeybindingRow[] {
  const labels = new Map(
    commands.map(({ command, label }) => [command, label]),
  );
  const occurrences = new Map<string, number>();
  return effective
    .flatMap((rule) => {
      if (!labels.has(rule.command) && !isProjectCommand(rule.command))
        return [];
      const binding = compileResolvedKeybindingRule(rule);
      if (!binding) return [];
      const commandDefaults = defaults.filter(
        (entry) => entry.command === rule.command,
      );
      const matchingDefault = commandDefaults.find((entry) => {
        const compiled = compileResolvedKeybindingRule(entry);
        return compiled && sameBinding(binding, compiled);
      });
      const identity = `${rule.command}\u0000${rule.key}\u0000${rule.when ?? ""}`;
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      return [
        {
          id: `${identity}\u0000${occurrence}`,
          rule,
          binding,
          label: labels.get(rule.command) ?? projectCommandLabel(rule.command),
          source: isProjectCommand(rule.command)
            ? "Project"
            : matchingDefault
              ? "Default"
              : "Custom",
          defaultRule:
            matchingDefault ??
            commandDefaults.find(
              (entry) => (entry.when ?? "") === (rule.when ?? ""),
            ) ??
            commandDefaults[0] ??
            null,
        } satisfies KeybindingRow,
      ];
    })
    .sort(
      (left, right) =>
        left.rule.command.localeCompare(right.rule.command) ||
        left.rule.key.localeCompare(right.rule.key),
    );
}

export function filterKeybindingRows(
  rows: readonly KeybindingRow[],
  query: string,
): readonly KeybindingRow[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return rows;
  return rows.filter((row) =>
    [
      row.rule.command,
      row.label,
      row.rule.key,
      row.rule.when ?? "",
      row.source,
    ].some((value) => value.toLowerCase().includes(normalized)),
  );
}

export function keybindingConflictLabels(
  rows: readonly KeybindingRow[],
  input: { rowId: string; rule: KeybindingRule },
  platform: string,
): readonly string[] {
  const binding = compileResolvedKeybindingRule(input.rule);
  if (!binding) return [];
  const key = shortcutConflictKey(binding.shortcut, platform);
  const when = input.rule.when?.trim() ?? "";
  return [
    ...new Set(
      rows
        .filter((row) => {
          const candidateWhen = row.rule.when?.trim() ?? "";
          return (
            row.id !== input.rowId &&
            shortcutConflictKey(row.binding.shortcut, platform) === key &&
            (!when || !candidateWhen || when === candidateWhen)
          );
        })
        .map((row) => row.label),
    ),
  ].sort();
}

function collectIdentifiers(
  node: KeybindingWhenNode,
  identifiers: Set<string>,
): void {
  switch (node.type) {
    case "identifier":
      identifiers.add(node.name);
      return;
    case "not":
      collectIdentifiers(node.node, identifiers);
      return;
    case "and":
    case "or":
      collectIdentifiers(node.left, identifiers);
      collectIdentifiers(node.right, identifiers);
      return;
  }
}

export function buildWhenVariableOptions(
  defaults: readonly KeybindingRule[],
): readonly string[] {
  const identifiers = new Set([
    "terminalFocus",
    "terminalOpen",
    "isWeb",
    "isDesktop",
    "editableFocus",
    "true",
    "false",
  ]);
  for (const rule of defaults) {
    const compiled = compileResolvedKeybindingRule(rule);
    if (compiled?.whenAst) collectIdentifiers(compiled.whenAst, identifiers);
  }
  return [...identifiers];
}

export function validateWhenDraft(
  expression: string,
  variables: readonly string[],
):
  | { kind: "valid"; expression: string; unknownVariables: readonly string[] }
  | { kind: "invalid"; message: string } {
  const trimmed = expression.trim();
  if (!trimmed) return { kind: "valid", expression: "", unknownVariables: [] };
  if (trimmed.length > 256)
    return {
      kind: "invalid",
      message: "Keep the expression to 256 characters or fewer.",
    };
  const node = parseKeybindingWhenExpression(trimmed);
  if (!node)
    return {
      kind: "invalid",
      message: "Use variables with !, &&, ||, and parentheses.",
    };
  const identifiers = new Set<string>();
  collectIdentifiers(node, identifiers);
  return {
    kind: "valid",
    expression: trimmed,
    unknownVariables: [...identifiers]
      .filter((name) => !variables.includes(name))
      .sort(),
  };
}
