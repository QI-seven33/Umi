/** SQLite datetime('now') 为 UTC；显式补时区，避免当作浏览器本地时间。 */
export function parseActivityTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z` : value;
  const time = new Date(normalized).getTime();
  return Number.isFinite(time) ? time : null;
}

/** 按用户本地日历归类；跨夏令时仍按日历天，而不是固定 24 小时判断。 */
export function activityLabel(value: number | null | undefined, now: number): string {
  if (value == null || !Number.isFinite(value)) return "";
  const date = new Date(value), current = new Date(now);
  const day = (input: Date) => Date.UTC(input.getFullYear(), input.getMonth(), input.getDate());
  const elapsed = Math.floor((day(current) - day(date)) / 86_400_000);
  if (elapsed <= 0) return "今天";
  if (elapsed === 1) return "昨天";
  if (elapsed < 7) return "7天";
  if (elapsed < 30) return "30天";
  return new Intl.DateTimeFormat("zh-CN", {
    ...(date.getFullYear() !== current.getFullYear() ? { year: "numeric" as const } : {}),
    month: "2-digit", day: "2-digit",
  }).format(date);
}
