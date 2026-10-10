// Copied from T3 Code v0.0.45 packages/shared/src/path.ts (MIT).
export function newProjectFolderName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  if (!slug) return "project";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(slug)
    ? `${slug}-project`
    : slug;
}
