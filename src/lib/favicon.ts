// Ported from pingdotgg/t3code v0.0.45 packages/shared/src/favicon.ts (MIT).

function faviconUrlForPage(rawUrl: string | null | undefined): string | null {
  if (!rawUrl || rawUrl.length > 4096) return null;
  try {
    const pageUrl = new URL(rawUrl);
    if (pageUrl.protocol !== "http:" && pageUrl.protocol !== "https:")
      return null;
    return new URL("/favicon.ico", pageUrl.origin).href;
  } catch {
    return null;
  }
}

const THEMED_FAVICON_BY_HOSTNAME: Readonly<
  Record<string, Readonly<{ light: string; dark: string }>>
> = {
  "github.com": {
    light: "https://github.githubassets.com/favicons/favicon.svg",
    dark: "https://github.githubassets.com/favicons/favicon-dark.svg",
  },
};

function themedFaviconUrlForPage(
  rawUrl: string | null | undefined,
  appearance: "light" | "dark",
): string | null {
  if (!rawUrl || rawUrl.length > 4096) return null;
  try {
    const pageUrl = new URL(rawUrl);
    if (pageUrl.protocol !== "http:" && pageUrl.protocol !== "https:")
      return null;
    return (
      THEMED_FAVICON_BY_HOSTNAME[pageUrl.hostname.toLowerCase()]?.[
        appearance
      ] ?? null
    );
  } catch {
    return null;
  }
}

function explicitFaviconUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl || rawUrl.length > 4096) return null;
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "data:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function toolActivityFaviconUrl(
  icon: {
    readonly pageUrl: string;
    readonly faviconUrl: string | null;
    readonly faviconUrlDark: string | null;
  },
  appearance: "light" | "dark",
): string | null {
  if (appearance === "dark") {
    return (
      explicitFaviconUrl(icon.faviconUrlDark) ??
      themedFaviconUrlForPage(icon.pageUrl, "dark") ??
      explicitFaviconUrl(icon.faviconUrl) ??
      faviconUrlForPage(icon.pageUrl)
    );
  }
  return (
    explicitFaviconUrl(icon.faviconUrl) ??
    themedFaviconUrlForPage(icon.pageUrl, "light") ??
    faviconUrlForPage(icon.pageUrl)
  );
}
