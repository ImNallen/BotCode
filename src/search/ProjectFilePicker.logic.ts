// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/files/ProjectFilePicker.logic.ts (MIT).
export const PROJECT_FILE_PICKER_RESULT_LIMIT = 200;
export function findMatchIndices(value: string, rawQuery: string): number[] {
  const query = rawQuery
    .trim()
    .replace(/^[@./]+/, "")
    .toLowerCase()
    .replace(/\s/g, "");
  if (!query) return [];
  const indices: number[] = [];
  let queryIndex = 0;
  const normalized = value.toLowerCase();
  for (let index = 0; index < normalized.length; index++) {
    if (normalized[index] !== query[queryIndex]) continue;
    indices.push(index);
    if (++queryIndex === query.length) return indices;
  }
  return [];
}
export function getProjectFilePickerMatches(
  paths: readonly string[],
  query: string,
) {
  return paths.slice(0, PROJECT_FILE_PICKER_RESULT_LIMIT).map((path) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    return {
      path,
      name,
      nameMatchIndices: findMatchIndices(name, query),
      pathMatchIndices: findMatchIndices(path, query),
    };
  });
}
