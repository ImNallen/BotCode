// Validation follows pingdotgg/t3code v0.0.45 contracts/project.ts (MIT).

export function isMonogramText(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 32 &&
    /^[\p{L}\p{N}][\p{L}\p{N}\p{M}\u200c\u200d]*$/u.test(value)
  );
}
