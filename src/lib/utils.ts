// Ported from pingdotgg/t3code v0.0.45 apps/web/src/lib/utils.ts (MIT): isMacPlatform only.
export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}
