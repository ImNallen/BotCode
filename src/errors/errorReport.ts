// Ported from T3 Code v0.0.45 apps/web/src/routes/__root.tsx (MIT).
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0)
    return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  return "An unexpected error occurred.";
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  if (typeof error === "string") return error;
  try {
    return (
      JSON.stringify(error, null, 2) ??
      "No additional error details are available."
    );
  } catch {
    return "No additional error details are available.";
  }
}

const MAX_ERROR_CAUSE_DEPTH = 5;

export function errorReport({
  error,
  pathname,
  version,
  area,
}: {
  error: unknown;
  pathname: string;
  version: string;
  area: string;
}): string {
  const lines = [
    `Bot Code ${version}`,
    `Path: ${pathname.split(/[?#]/, 1)[0] ?? "/"}`,
    `Area: ${area}`,
    `Time: ${new Date().toISOString()}`,
    "",
    errorDetails(error),
  ];
  let cause = error instanceof Error ? error.cause : undefined;
  for (
    let depth = 0;
    cause !== undefined && depth < MAX_ERROR_CAUSE_DEPTH;
    depth += 1
  ) {
    lines.push("", "Caused by:", errorDetails(cause));
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return lines.join("\n");
}
