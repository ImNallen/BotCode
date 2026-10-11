// Ports resolveWeekStartsOn from pingdotgg/t3code v0.0.45 apps/web/src/timestampFormat.ts (MIT).
const WEEKDAY_INDEXES = [0, 1, 2, 3, 4, 5, 6] as const;
type WeekdayIndex = (typeof WEEKDAY_INDEXES)[number];

type LocaleWithWeekInfo = Intl.Locale & {
  readonly weekInfo?: { readonly firstDay: number };
  getWeekInfo?: () => { readonly firstDay: number };
};

export function resolveWeekStartsOn(
  locale: string | undefined,
): WeekdayIndex | undefined {
  try {
    const resolved: LocaleWithWeekInfo = new Intl.Locale(
      locale ?? Intl.DateTimeFormat().resolvedOptions().locale,
    );
    // Week info counts Monday as 1 and Sunday as 7.
    const firstDay =
      resolved.getWeekInfo?.().firstDay ?? resolved.weekInfo?.firstDay;
    return firstDay === undefined ? undefined : WEEKDAY_INDEXES[firstDay % 7];
  } catch {
    return undefined;
  }
}

export const weekStartsOn = resolveWeekStartsOn(undefined);
